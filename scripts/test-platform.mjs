/* What has to be true on a platform the person running this is probably not on.

   Tulip ships on macOS and Windows, and most of the differences between them
   are decided in one branch somewhere and then never exercised again by whoever
   wrote it. These are those branches, asked directly — so the Windows answer is
   checked on a Mac and the Mac answer on Windows. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { shortcutLabel } from '../src/platform.js'
import { killPlan } from '../electron/process-tree.js'

/* ----------------------------------------------------------- shortcuts */

assert.equal(shortcutLabel('New note (⌘⇧N)', 'darwin'), 'New note (⌘⇧N)')
assert.equal(shortcutLabel('New note (⌘⇧N)', 'win32'), 'New note (Ctrl+Shift+N)')
assert.equal(shortcutLabel('Open to side (⌘⌥O)', 'win32'), 'Open to side (Ctrl+Alt+O)')
assert.equal(shortcutLabel('Review (⌃⌘S)', 'win32'), 'Review (Ctrl+Alt+S)')

/* -------------------------------------------------- stopping a run's tree */

/* POSIX signals the group, which is what the negative pid says. Getting this
   wrong leaves the interpreter's own children running after Stop. */
assert.deepEqual(killPlan(4242, 'SIGTERM', 'darwin'),
  { kind: 'signal', target: -4242, signal: 'SIGTERM' })
assert.deepEqual(killPlan(4242, 'SIGKILL', 'linux'),
  { kind: 'signal', target: -4242, signal: 'SIGKILL' })

/* Windows has neither groups nor signals: taskkill walks the tree by parent
   id, and /f is the difference between asking and insisting. */
assert.deepEqual(killPlan(4242, 'SIGTERM', 'win32'),
  { kind: 'spawn', command: 'taskkill.exe', args: ['/pid', '4242', '/t'] })
assert.deepEqual(killPlan(4242, 'SIGKILL', 'win32'),
  { kind: 'spawn', command: 'taskkill.exe', args: ['/pid', '4242', '/t', '/f'] })

// `/t` is not optional on either. Without it only the leader goes.
for (const signal of ['SIGTERM', 'SIGKILL']) {
  assert.ok(killPlan(1, signal, 'win32').args.includes('/t'),
    `${signal} on Windows must take the whole tree`)
}

/* ----------------------------------------------------- packaging targets */

const pkg = JSON.parse(await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'))

assert.deepEqual(pkg.build.win.target, ['nsis', 'zip'])
assert.deepEqual(pkg.build.mac.target, ['dmg', 'zip'])
assert.equal(pkg.build.publish.provider, 'github')

/* The updater reads what the release workflow writes. If the provider ever
   stops being GitHub, electron/updates.js is looking in the wrong place. */
assert.equal(typeof pkg.dependencies['electron-updater'], 'string',
  'electron-updater is a runtime dependency, not a build-time one')

/* --------------------------------------------------- source conventions

   The two below are greps, and stay greps knowingly. They guard a convention
   held across a 5,000-line file that has no seam to call into: there is no
   function that returns "every accelerator in the menu", only a template
   handed straight to Electron. Extracting one purely to assert on it would be
   a worse trade than this. Everything above was a grep too, and is not any
   more. */

const main = await readFile(path.resolve(process.cwd(), 'electron/main.js'), 'utf8')

/* `Cmd+` binds nothing on Windows — the key does not exist there. Every
   accelerator has to be `CmdOrCtrl+`, and a single `Cmd+` is a shortcut that
   silently does not work for half the users. */
assert.doesNotMatch(main, /accelerator:\s*['"](?:Shift\+|Alt\+)?Cmd\+/,
  'menu accelerators must use CmdOrCtrl+, which Windows can bind')

/* Neither exists on Windows, and shelling out to them is the reflex this is
   here to catch. node:fs does both, everywhere. */
assert.doesNotMatch(main, /\['\/bin\/(?:cp|mv)'/,
  'copy and move go through node:fs, not /bin')

console.log('platform contracts: all checks passed')
