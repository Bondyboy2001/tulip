import assert from 'node:assert/strict'
import { TurnLedger, turnId } from '../electron/ai-turns.js'
import { mergeChatHistory, MAX_CHAT_NOTES } from '../electron/chat-history.js'
import { newTurnId, ownsTurn } from '../src/copilot-turns.js'
import { restoreConflicts } from '../electron/copilot-restore.js'
import renameRequest from '../electron/copilot-rename.js'

const { REQUEST_PATH, isRequestPath, parseRequest } = renameRequest

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

assert.equal(turnId(' turn-a '), 'turn-a')
assert.equal(turnId(''), '')
assert.equal(turnId('x'.repeat(121)), '')

assert.equal(isRequestPath(REQUEST_PATH), true)
assert.equal(isRequestPath(`./${REQUEST_PATH}`), true)
assert.equal(isRequestPath('.not-a-command.json'), false)
assert.deepEqual(
  parseRequest('{"path":"Papers/Untitled.tex","name":"test123"}'),
  { path: 'Papers/Untitled.tex', name: 'test123' }
)
assert.throws(() => parseRequest('{"path":"Papers/Untitled.tex"}'), /both/)

const active = { id: newTurnId() }
assert.equal(ownsTurn(active, { turnId: active.id }), true)
assert.equal(ownsTurn(active, { turnId: 'an-older-turn' }), false)
assert.equal(ownsTurn(null, { turnId: active.id }), false)

const snapshots = []
const afterA = deferred()
let completed = 0
const ledger = new TurnLedger({
  snapshot: async () => {
    const next = snapshots.shift()
    return next?.promise ? next.promise : next
  },
  complete: (before, after) => {
    completed++
    return { before, after }
  }
})

snapshots.push('before-a')
await ledger.begin('a')
snapshots.push(afterA)
const firstFinish = ledger.finish('a')
const duplicateFinish = ledger.finish('a')
assert.equal(firstFinish, duplicateFinish, 'duplicate terminal events share one completion')

/* A newer turn can begin while the old turn's after-snapshot is still waiting.
 * Its baseline must not replace the old one. */
snapshots.push('before-b')
await ledger.begin('b')
afterA.resolve('after-a')
assert.deepEqual(await firstFinish, { before: 'before-a', after: 'after-a' })

snapshots.push('after-b')
assert.deepEqual(await ledger.finish('b'), { before: 'before-b', after: 'after-b' })
assert.equal(completed, 2)
assert.equal(await ledger.finish('missing'), null)

/* Whether finishing a turn can produce anything at all. Main drops the index
 * and the vault snapshot on the way into `finish` — a full recursive walk —
 * so that a write which landed a moment ago is seen. A turn that never took a
 * baseline (read-only, or a Stop pressed with nothing running) has nothing to
 * compare against, and that walk would be spent for a guaranteed empty diff. */
assert.equal(ledger.has('missing'), false)
assert.equal(ledger.has(''), false)
snapshots.push('before-c')
await ledger.begin('c')
assert.equal(ledger.has('c'), true)
snapshots.push('after-c')
await ledger.finish('c')
assert.equal(ledger.has('c'), false, 'a finished turn is done being asked about')

/* ---------------------------------------------------- transcripts on disk */

/* The panel writes the notes that changed rather than its whole history, so
 * the file is a merge. Getting this wrong loses conversations silently — the
 * window still shows them, and the next launch simply opens without them. */
const older = {
  'A.md': { at: 3, convos: [{ id: 'a1' }] },
  'B.md': { at: 2, convos: [{ id: 'b1' }] }
}
assert.deepEqual(
  mergeChatHistory(older, { notes: { 'B.md': { at: 9, convos: [{ id: 'b2' }] } }, remove: [] }),
  {
    'A.md': { at: 3, convos: [{ id: 'a1' }] },
    'B.md': { at: 9, convos: [{ id: 'b2' }] }
  },
  'a note not mentioned by the write keeps what is on disk'
)
assert.deepEqual(
  Object.keys(mergeChatHistory(older, { notes: {}, remove: ['A.md'] })),
  ['B.md'],
  'a renamed-away note is taken off disk'
)
assert.deepEqual(
  mergeChatHistory(older, { notes: { 'C.md': { at: 4 } }, remove: ['C.md'] }),
  { 'A.md': { at: 3, convos: [{ id: 'a1' }] }, 'B.md': { at: 2, convos: [{ id: 'b1' }] }, 'C.md': { at: 4 } },
  'a note renamed onto a name being written in the same breath keeps the write'
)
/* A window still running the old code sends its whole history, with the note
 * paths at the top level and no envelope. It has to go on working. */
assert.deepEqual(mergeChatHistory(older, { 'Z.md': { at: 1 } }), { 'Z.md': { at: 1 } })

const many = {}
for (let n = 0; n < MAX_CHAT_NOTES + 5; n++) many[`n${n}.md`] = { at: n }
const capped = mergeChatHistory(many, { notes: { 'new.md': { at: 9999 } }, remove: [] })
assert.equal(Object.keys(capped).length, MAX_CHAT_NOTES, 'the file is capped, not the window')
assert.ok(capped['new.md'], 'the newest survives the cap')
assert.ok(!capped['n0.md'], 'the oldest does not')

const operation = {
  source: 'copilot',
  changes: [
    { path: 'A.md', before: 'old a', after: 'agent a' },
    { path: 'New.md', before: null, after: 'created' }
  ]
}
assert.deepEqual(restoreConflicts(operation, new Map([
  ['A.md', 'agent a'], ['New.md', 'created']
])), [])
assert.deepEqual(restoreConflicts(operation, new Map([
  ['A.md', 'newer user edit'], ['New.md', 'created']
])), ['A.md'])
assert.deepEqual(restoreConflicts(operation, new Map([
  ['A.md', 'agent a'], ['New.md', null]
])), ['New.md'], 'a created note removed or changed later is not trashed/restored blindly')
assert.deepEqual(restoreConflicts({ ...operation, source: 'save' }, new Map()), [],
  'ordinary history restore remains an intentional version choice')

console.log('copilot lifecycle: turn ownership and snapshots')
