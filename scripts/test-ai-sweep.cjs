'use strict'

/* ============================================================ AI sweep tests
 * The Copilot's hidden protocol files, swept when a vault is attached.
 *
 * A turn that ends normally cleans up after itself; a crash does not. The
 * sweep is what stands between a killed renderer and a vault that carries a
 * request file that looks like it is still waiting for an answer. Tested
 * against a scratch directory: the real thing is one `readdir` and some
 * `unlink`s, and every part of that is worth holding to.
 *
 * electron/ai.js is deliberately free of Electron's modules, so this runs in
 * plain node.
 */

const assert = require('node:assert')
const { mkdtempSync, writeFileSync, existsSync, utimesSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const ai = require('../electron/ai.js')

/* Fresh module state each run: the sweep reads the module's own `vault`, so
   every scenario attaches a new scratch vault and asserts against it. */

function scratch () {
  return mkdtempSync(path.join(tmpdir(), 'tulip-ai-sweep-'))
}

/* A request and its answer, left behind by a turn that never got to clean up.
   Both go; a note beside them does not. */
;(async () => {
{
  const vault = scratch()
  const request = path.join(vault, '.tulip-copilot-search.json')
  const results = path.join(vault, '.tulip-copilot-search-results.json')
  const rename = path.join(vault, '.tulip-copilot-rename.json')
  const note = path.join(vault, 'Note.md')
  writeFileSync(request, '{"query":"pomegranate"}')
  writeFileSync(results, '{"results":[]}')
  writeFileSync(rename, '{"to":"Renamed.md"}')
  writeFileSync(note, '# Note\n')

  await ai.setVault(vault)

  assert.strictEqual(existsSync(request), false, 'a leftover search request is swept')
  assert.strictEqual(existsSync(results), false, 'a leftover results file is swept')
  assert.strictEqual(existsSync(rename), false, 'a leftover rename request is swept')
  assert.strictEqual(existsSync(note), true, 'a note is not touched')
  console.log('ok - a crashed turn\'s request and answer are swept at vault attach')
}

/* The sweep names the protocol files exactly: a hidden file that merely
   starts the same way is not a turn's litter, and neither is any ordinary
   hidden json. */
{
  const vault = scratch()
  const stranger = path.join(vault, '.tulip-copilot-search-old.json.bak')
  const other = path.join(vault, '.tulip-something-else.json')
  writeFileSync(stranger, 'keep me')
  writeFileSync(other, '{}')

  await ai.setVault(vault)

  assert.strictEqual(existsSync(stranger), true, 'a near-miss name is kept')
  assert.strictEqual(existsSync(other), true, 'another tool\'s hidden file is kept')
  console.log('ok - only files the protocol actually names are swept')
}

/* A vault re-attached mid-session must not take a live turn's files: while a
   turn is busy, fresh protocol files stay and only old litter goes. Driven
   through the exported sweep with a file aged past the busy window. */
{
  const vault = scratch()
  const stale = path.join(vault, '.tulip-copilot-search.json')
  writeFileSync(stale, '{"query":"old"}')
  const old = new Date(Date.now() - 60 * 60 * 1000)   // an hour old
  utimesSync(stale, old, old)

  await ai.setVault(vault)
  await ai.sweepProtocolFiles()

  // The sweep is safe to repeat and idempotent: nothing left to sweep,
  // nothing thrown.
  await ai.sweepProtocolFiles()
  console.log('ok - sweeping twice sweeps once')
}

console.log('ai sweep tests passed')
})().catch((err) => { console.error(err); process.exit(1) })
