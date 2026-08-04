import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { shortcutLabel } from '../src/platform.js'

assert.equal(shortcutLabel('New note (⌘⇧N)', 'darwin'), 'New note (⌘⇧N)')
assert.equal(shortcutLabel('New note (⌘⇧N)', 'win32'), 'New note (Ctrl+Shift+N)')
assert.equal(shortcutLabel('Open to side (⌘⌥O)', 'win32'), 'Open to side (Ctrl+Alt+O)')
assert.equal(shortcutLabel('Review (⌃⌘S)', 'win32'), 'Review (Ctrl+Alt+S)')

const fromRoot = (name) => path.resolve(process.cwd(), name)
const main = await readFile(fromRoot('electron/main.js'), 'utf8')
const build = await readFile(fromRoot('build.mjs'), 'utf8')
const pkg = JSON.parse(await readFile(fromRoot('package.json'), 'utf8'))

assert.doesNotMatch(main, /accelerator:\s*['"](?:Shift\+|Alt\+)?Cmd\+/)
assert.doesNotMatch(main, /\['\/bin\/(?:cp|mv)'/)
assert.match(main, /taskkill\.exe/)
assert.match(build, /process\.platform === 'darwin'/)
assert.deepEqual(pkg.build.win.target, ['nsis', 'zip'])
assert.equal(pkg.build.publish.provider, 'github')

console.log('platform contracts: all checks passed')
