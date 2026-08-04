'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function digestTree (root) {
  const hash = crypto.createHash('sha256')
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs)
      hash.update(rel)
      if (entry.isDirectory()) walk(abs)
      else hash.update(fs.readFileSync(abs))
    }
  }
  walk(root)
  return hash.digest('hex')
}

const before = digestTree('dist')
const run = spawnSync(process.execPath, ['build.mjs', '--test-fail-before-swap'], {
  cwd: process.cwd(), encoding: 'utf8'
})
assert.notEqual(run.status, 0)
assert.match(run.stderr, /simulated failure before production output swap/)
assert.equal(digestTree('dist'), before)
assert.deepEqual(
  fs.readdirSync('.').filter((name) => name.startsWith('.dist-stage-')),
  []
)
assert.deepEqual(
  fs.readdirSync('dist', { recursive: true }).filter((name) => String(name).endsWith('.map')),
  []
)
console.log('build staging: failure preserved the validated dist')
