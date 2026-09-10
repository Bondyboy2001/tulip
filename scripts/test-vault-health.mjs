import assert from 'node:assert/strict'
import { references, scanVaultHealth, replaceWikiReference, formatHealthLog } from '../src/vault-health.js'
const source = `# Test

[[Existing]] [[Missing|label]] ![[lost.png]]

[local](Existing.md) [remote](https://example.com) [heading](#intro)

![reference image][img]

[img]: absent.png

\`[[not a link]]\`

\`\`\`md
[[example]] ![](example.png) [@example]
\`\`\`

<!-- <img src="comment.png"> -->

[@known; @unknown]
`
const refs = references(source)
assert.ok(refs.some((r) => r.target === 'Missing'))
assert.ok(refs.some((r) => r.target === 'absent.png'))
assert.ok(!refs.some((r) => /^(example|not a link|comment)/.test(r.target)))
const api = {
  vault: {
    snapshot: async () => ({ tree: ['Test.md', 'Existing.md', 'references.bib'].map((path) => ({ type: 'file', path })), assets: [] }),
    aliases: async () => ({}),
    notes: async () => ({ notes: [{ path: 'Test.md', text: source }, { path: 'Existing.md', text: '' }], total: 2 })
  },
  file: { read: async () => '@article{known, title={A real reference}}' }
}
const report = await scanVaultHealth({ api })
assert.deepEqual(report.issues.map((r) => r.target).sort(), ['#intro', 'Missing', 'absent.png', 'lost.png', 'unknown'].sort())
assert.equal(report.scanned, 2)
assert.deepEqual(report.skipped, [])
const cancelled = await scanVaultHealth({ api, cancelled: () => true })
assert.equal(cancelled.cancelled, true)
console.log('vault health: Markdown syntax, citations, valid links, code exclusions and cancellation passed')

assert.equal(replaceWikiReference('![[old.png|200]]', 'old.png', 'new.png'), '![[new.png|200]]')
assert.equal(replaceWikiReference('[[old]] [[old]]', 'old', 'new'), null)
assert.equal(replaceWikiReference('[[old]]', 'old', 'bad]]'), null)
assert.equal(replaceWikiReference('[[changed]]', 'old', 'new'), null)
console.log('vault health: repair keeps labels, rejects repeated or stale references and invalid targets')

const log = formatHealthLog(report)
for (const issue of report.issues) assert.ok(log.includes(`${issue.path}:${issue.line}\n  `) && log.includes(issue.target))
assert.ok(formatHealthLog({ scanned: 1, issues: [], skipped: ['large.md'] }).includes('Not fully checked:\n  large.md'))
assert.ok(formatHealthLog({ scanned: 2, issues: [report.issues[0]], skipped: [] }).includes('1 unresolved reference\n'))
console.log('vault health: copyable log includes all source locations and incomplete scan details')

const hygiene = await scanVaultHealth({ api: {
  vault: {
    snapshot: async () => ({ tree: ['a/Note.md', 'b/note.md', 'Empty.md', 'Unindexed.md'].map(path => ({ type: 'file', path })), assets: [] }),
    aliases: async () => ({}),
    notes: async () => ({ notes: [{ path: 'a/Note.md', text: '# A' }, { path: 'b/note.md', text: '# B' }, { path: 'Empty.md', text: '  \n' }], total: 3 })
  }
} })
assert.deepEqual(hygiene.emptyNotes, ['Empty.md'])
assert.deepEqual(hygiene.duplicateNames, [['a/Note.md', 'b/note.md']])
assert.deepEqual(hygiene.skipped, ['Unindexed.md — unavailable in the text index'])
assert.ok(formatHealthLog(hygiene).includes('Duplicate note names: 1'))
console.log('vault health: empty notes, ambiguous names and exact unindexed paths are reported')

const anchors = await scanVaultHealth({ api: { vault: {
  snapshot: async () => ({ tree: [{ type: 'file', path: 'A.md' }, { type: 'file', path: 'B.md' }] }),
  aliases: async () => ({}),
  notes: async () => ({ notes: [
    { path: 'A.md', text: '[[B#Good heading]] [[B#^proof]] [[B#missing]] [[#Local]]\n\n# Local' },
    { path: 'B.md', text: '# Good heading\n\nA proof. ^proof\n\n```\n# missing\n```' }
  ], total: 2 })
} } })
assert.deepEqual(anchors.issues.map((issue) => issue.target), ['B#missing'])
console.log('vault health: headings, local anchors and blocks resolve outside code fences')
