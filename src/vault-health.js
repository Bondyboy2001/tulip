import MarkdownIt from 'markdown-it'
import { headings, findHeading, blockReferences } from './headings.js'
import { findCitations, parseBibTeXCached } from './citations.js'
import { assetIndex } from './assets.js'
import { NOTE_EXT } from './vault-paths.js'

const parser = new MarkdownIt({ html: true })
const external = (target) => !target || /^(?:#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(target)
const fold = (text) => text.toLowerCase().normalize('NFC')

// Parse Markdown before inspecting references: code examples and comments are
// not dependencies, and reference-style links need the parser's resolution.
export function references (text) {
  const found = []
  const walk = (tokens, line = 1) => {
    for (const token of tokens) {
      const at = token.map ? token.map[0] + 1 : line
      if (token.type === 'link_open') found.push({ target: token.attrGet('href'), kind: 'link', line: at })
      if (token.type === 'image') found.push({ target: token.attrGet('src'), kind: 'embed', line: at })
      if (token.type === 'text') {
        for (const match of token.content.matchAll(/(!?)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
          found.push({ target: match[2], kind: match[1] ? 'embed' : 'link', wiki: true, line: at })
        }
        for (const cite of findCitations(token.content)) {
          for (const key of cite.keys) found.push({ target: key, kind: 'citation', line: at })
        }
      }
      if (token.type === 'html_inline' || token.type === 'html_block') {
        const html = token.content.replace(/<!--[\s\S]*?-->/g, '')
        for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) found.push({ target: match[1], kind: 'embed', line: at })
      }
      if (token.children && token.type !== 'image') walk(token.children, at)
    }
  }
  walk(parser.parse(text, {}))
  return found
}

export async function scanVaultHealth ({ api, progress = (_status) => {}, cancelled = () => false }) {
  const snapshot = await api.vault.snapshot()
  const paths = [...(snapshot.assets || [])]
  const collect = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === 'file') paths.push(node.path)
      if (node.children) collect(node.children)
    }
  }
  collect(snapshot.tree)
  const resolve = assetIndex(paths)
  const aliases = await api.vault.aliases()
  const notePaths = [...new Set(paths.filter((p) => NOTE_EXT.test(p)))]
  const names = new Map()
  const nameGroups = new Map()
  const emptyNotes = []
  const indexed = new Set()
  for (const p of notePaths) {
    const key = fold(p.split('/').pop().replace(NOTE_EXT, ''))
    if (!names.has(key)) names.set(key, p)
    if (!nameGroups.has(key)) nameGroups.set(key, [])
    nameGroups.get(key).push(p)
  }
  const issues = []
  const skipped = []
  const bibs = new Map()
  const anchorChecks = []
  const anchorIndex = new Map()
  let scanned = 0
  let offset = 0
  for (;;) {
    if (cancelled()) return { issues, skipped, scanned, cancelled: true }
    const page = await api.vault.notes({ offset, limit: 100 })
    const notes = Array.isArray(page) ? page : page.notes
    for (const note of notes) {
      if (!NOTE_EXT.test(note.path)) continue
      indexed.add(note.path)
      anchorIndex.set(note.path, { headings: headings(note.text), blocks: blockReferences(note.text) })
      if (!note.text.trim()) emptyNotes.push(note.path)
      const dir = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : ''
      const seen = new Set()
      for (const ref of references(note.text)) {
        let target = ref.target
        if (ref.kind !== 'citation' && external(target) && !target?.startsWith('#')) continue
        if (ref.kind === 'citation') {
          const bib = resolve('references.bib', dir)
          if (bib && !bibs.has(bib)) {
            try { bibs.set(bib, parseBibTeXCached(await api.file.read(bib))) } catch {
              bibs.set(bib, null); skipped.push(bib)
            }
          }
          if (bib && (bibs.get(bib) === null || bibs.get(bib)?.has(target))) continue
        } else {
          target = target.split('#')[0].split('?')[0].trim()
          let hit = target ? resolve(target, dir) : note.path
          if (!hit && ref.wiki) {
            const key = fold(target.replace(NOTE_EXT, ''))
            hit = resolve(`${target}.md`, dir) || resolve(`${target}.markdown`, dir) || names.get(key) || aliases?.[key]?.[0]
          }
          if (hit) {
            if (ref.target.includes('#') && NOTE_EXT.test(hit)) anchorChecks.push({ ref, path: note.path, hit })
            continue
          }
        }
        const key = `${ref.kind}:${target}`
        if (seen.has(key)) continue
        seen.add(key)
        issues.push({ ...ref, sourceTarget: ref.target, target, path: note.path })
      }
      scanned++
    }
    offset += notes.length
    progress({ scanned, count: issues.length })
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!notes.length || Array.isArray(page) || offset >= page.total) break
  }
  // Large/unindexed notes are explicitly reported rather than a false clean bill.
  for (const path of notePaths) {
    if (!indexed.has(path)) skipped.push(`${path} — unavailable in the text index`)
  }
  for (const { ref, path, hit } of anchorChecks) {
    const index = anchorIndex.get(hit)
    if (!index) { skipped.push(`${hit} — anchors unavailable`); continue }
    let anchor = ref.target.slice(ref.target.indexOf('#') + 1)
    try { anchor = decodeURIComponent(anchor) } catch {}
    if (!anchor) continue
    const exists = anchor.startsWith('^')
      ? index.blocks.some((block) => block.id === anchor.slice(1))
      : findHeading(index.headings, anchor)
    if (!exists) issues.push({ ...ref, kind: 'anchor', sourceTarget: ref.target, target: ref.target, path })
  }
  const duplicateNames = [...nameGroups.values()].filter((group) => group.length > 1)
  return { issues, skipped, scanned, emptyNotes, duplicateNames, generatedAt: new Date().toISOString(), cancelled: false }
}

// Only offer an automatic edit when the exact reference occurs once. Repeated
// or complex references stay an explicit source edit rather than a guessed patch.
export function replaceWikiReference (text, target, replacement) {
  if (!replacement || /[[\]\n\r|]/.test(replacement)) return null
  const matches = [...text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].filter((match) => match[1] === target)
  if (matches.length !== 1) return null
  const match = matches[0]
  const from = match.index + 2
  return text.slice(0, from) + replacement + text.slice(from + target.length)
}

const issueLabel = (issue) => issue.kind === 'anchor' ? 'Missing heading or block' : issue.kind === 'citation' ? 'Unresolved citation' : issue.kind === 'embed' ? 'Missing embed' : 'Broken link'

export function formatHealthLog (report) {
  const lines = [
    '# Logs',
    '',
    `Checked ${report.scanned} ${report.scanned === 1 ? 'note' : 'notes'} · ${report.issues.length} unresolved ${report.issues.length === 1 ? 'reference' : 'references'}`,
    '',
    ...(report.generatedAt ? [`Checked at ${report.generatedAt}`, ''] : []),
    '## References',
    '',
    ''
  ]
  for (const issue of report.issues) {
    lines.push(`${issue.path}:${issue.line}`, `  ${issueLabel(issue)}: ${issue.target}`, '')
  }
  if (!report.issues.length) lines.push('No unresolved references found.', '')
  lines.push('## Notes', '')
  const emptyNotes = report.emptyNotes || []
  const duplicateNames = report.duplicateNames || []
  lines.push(`Empty notes: ${emptyNotes.length}`, ...emptyNotes.map((path) => `- ${path}`), '')
  lines.push(`Duplicate note names: ${duplicateNames.length}`, '')
  for (const group of duplicateNames) lines.push(...group.map((path) => `- ${path}`), '')
  if (duplicateNames.length) lines.push('Use folder paths in links to distinguish notes with the same name.', '')
  lines.push('## Scan coverage', '')
  if (report.skipped.length) lines.push('Not fully checked:', ...report.skipped.map((item) => `  ${item}`), '')
  else lines.push('All indexed notes checked; no unreadable bibliography files encountered.', '')
  lines.push('Checks: local links, embeds, citations, empty notes and duplicate note names.',
    'Headings and block references in indexed notes are checked. Remote URLs are not checked.', '')
  return lines.join('\n')
}

