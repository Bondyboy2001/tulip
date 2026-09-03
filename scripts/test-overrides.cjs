'use strict'

/* ============================================================== override tests
 * The version overrides in package.json, held to their reasons.
 *
 * The `_overrides` essay there ends with the instruction that matters: they
 * are rechecked on every mermaid/excalidraw bump, because an override that
 * outlives its reason is how a tree ends up pinned to something older than
 * the dependency wants. Instructions in essays are followed until the week
 * everyone is busy; this file is the instruction made mechanical.
 *
 * It walks the installed tree and checks two things per override:
 *
 *   1. every copy that arrived is on the patched line the essay names —
 *      npm applied the override, and nothing nested escaped it;
 *   2. the tree still has at least one package depending on the overridden
 *      name — if that ever goes away, the override's reason is gone and the
 *      override itself should be removed in the same commit.
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

/* The patched lines, restated from the essay in package.json. Bump one of
   these only with the essay open in the other pane. */
const PINS = {
  'lodash-es': { min: '4.18.1', reason: 'chevrotain pins 4.17.21, whose _.template is a code-injection hole' },
  nanoid: { exact: '3.3.18', reason: 'excalidraw and mermaid-to-excalidraw pin lines that return predictable ids' },
  katex: { min: '0.18.4', below: '0.19.0', reason: 'mermaid pins ^0.16, a second near-identical copy in the bundle' }
}

/** `4.18.1` → [4, 18, 1]. A pre-release tag sorts before its own release. */
function parseVersion (version) {
  const [core] = String(version).split(/[-+]/, 1)
  return core.split('.').map((n) => parseInt(n, 10) || 0)
}

function atLeast (version, floor) {
  const a = parseVersion(version)
  const b = parseVersion(floor)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return true
}

function below (version, ceiling) {
  const a = parseVersion(version)
  const b = parseVersion(ceiling)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0)
  }
  return false
}

/* Walk node_modules, top level and nested, collecting every package.json.
   Depth-capped: npm's tree never legitimately nests deeper than this, and a
   cap is what keeps a symlink loop from becoming an infinite one. */
function collectManifests () {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === '.bin') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('@')) {
          walk(full, depth + 1)          // a scope: its children are packages
        } else if (entry.name === 'node_modules') {
          walk(full, depth + 1)
        } else {
          const manifest = path.join(full, 'package.json')
          if (fs.existsSync(manifest)) found.push(manifest)
          walk(path.join(full, 'node_modules'), depth + 1)
        }
      }
    }
  }
  walk(path.join(root, 'node_modules'), 0)
  return found
}

const manifests = collectManifests()
if (!manifests.length) {
  console.error('overrides test: no installed packages found — run `npm ci` first.')
  process.exit(2)
}

const installed = new Map()   // name -> [versions]
const dependents = new Map()  // name -> [who needs it]
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

for (const file of manifests) {
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
  if (!pkg || typeof pkg.name !== 'string') continue
  if (PINS[pkg.name] && typeof pkg.version === 'string') {
    if (!installed.has(pkg.name)) installed.set(pkg.name, [])
    installed.get(pkg.name).push(pkg.version)
  }
  for (const field of FIELDS) {
    const deps = pkg[field] || {}
    for (const name of Object.keys(PINS)) {
      if (deps[name]) {
        if (!dependents.has(name)) dependents.set(name, [])
        dependents.get(name).push(`${pkg.name}@${pkg.version || '?'}`)
      }
    }
  }
}

let failed = false

for (const [name, pin] of Object.entries(PINS)) {
  const versions = installed.get(name) || []
  if (!versions.length) {
    console.error(`overrides: ${name} is not installed at all — the override names a package the tree no longer has. Remove the override (and update package.json's essay).`)
    failed = true
    continue
  }
  for (const version of versions) {
    const ok = pin.exact
      ? version === pin.exact
      : atLeast(version, pin.min) && (pin.below ? below(version, pin.below) : true)
    if (!ok) {
      console.error(`overrides: ${name} ${version} is installed, which is off the patched line (${pin.reason}).`)
      failed = true
    }
  }
  if (!failed) {
    console.log(`ok - every copy of ${name} is on the patched line (${[...new Set(versions)].join(', ')})`)
  }

  if (!dependents.get(name)?.length) {
    console.error(`overrides: nothing in the tree depends on ${name} any more — the override has outlived its reason. Remove it from package.json (overrides and the essay) in the same commit.`)
    failed = true
  } else {
    console.log(`ok - ${name}'s reason is still here: needed by ${[...new Set(dependents.get(name))].slice(0, 3).join(', ')}`)
  }
}

if (failed) process.exit(1)
console.log('overrides match their reasons')
