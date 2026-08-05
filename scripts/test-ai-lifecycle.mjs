import assert from 'node:assert/strict'
import { TurnLedger, turnId } from '../electron/ai-turns.js'
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
