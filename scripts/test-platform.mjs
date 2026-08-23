/* ======================================================= platform contracts
   What the app calls the keys, and what it will not hard-code about the
   desktop it is running on.

   src/platform.js exists because every shortcut the page printed was a ⌘ chord
   and every reveal button said Finder — words that name keys and applications
   which do not exist on Windows. These are the cases that got it wrong, kept
   as assertions so they cannot come back one glyph at a time.

   The module reads `globalThis.tulip.platform`, so the platform under test is
   set rather than mocked: the same path the renderer takes.
*/

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { keyLabel, isMac, revealLabel } from '../src/platform.js'

const on = (platform) => { globalThis.tulip = { platform } }

/* ---------------------------------------------------------------- the keys */

on('darwin')
assert.ok(isMac())
/* A Mac is what the markup already says, so the rewrite must not touch it —
   the common case, and the one where any edit is a regression. */
assert.equal(keyLabel('New note (⌘⇧N)'), 'New note (⌘⇧N)')

on('win32')
assert.ok(!isMac())
assert.equal(keyLabel('New note (⌘⇧N)'), 'New note (Ctrl+Shift+N)')
assert.equal(keyLabel('Open to side (⌘⌥O)'), 'Open to side (Ctrl+Alt+O)')
/* ⌘ and ⌃ both land on Ctrl, so a chord holding both must print it once. */
assert.equal(keyLabel('Review (⌃⌘S)'), 'Review (Ctrl+S)')
/* "Ctrl++" is the literal spelling and an unreadable one; `-` needs no help. */
assert.equal(keyLabel('Zoom in (⌘+)'), 'Zoom in (Ctrl+Plus)')
assert.equal(keyLabel('Zoom out (⌘-)'), 'Zoom out (Ctrl+-)')
/* The chord is bounded to one trailing key: a ⌘N inside a sentence takes the
   N and leaves the sentence alone. This is what walking every character broke. */
assert.equal(keyLabel('Press ⌘N to make a note'), 'Press Ctrl+N to make a note')
assert.equal(keyLabel(''), '')
assert.equal(keyLabel(null), '')

/* ------------------------------------------------------- the file manager */

on('darwin'); assert.equal(revealLabel(), 'Reveal in Finder')
on('win32'); assert.equal(revealLabel(), 'Show in File Explorer')
on('linux'); assert.equal(revealLabel(), 'Show in the file manager')

/* ------------------------------------------------- what main must not assume */

const read = (name) => readFile(path.resolve(process.cwd(), name), 'utf8')
const [main, killTree, build] = await Promise.all([
  read('electron/main.js'),
  read('electron/kill-tree.js'),
  read('build.mjs')
])

/* Electron drops a bare `Cmd` accelerator on every platform but macOS, so a
   menu built with them is a Windows menu that prints its shortcuts and honours
   none of them. This is what shipped, undetected, while this file did not run. */
assert.doesNotMatch(main, /accelerator: '(?![^']*CmdOrCtrl)[^']*Cmd\+/)

/* Nor may the run pipeline reach for a POSIX path. `/bin/cp` and `/bin/mv` are
   not there on Windows, and the step that used them came after the compile —
   so a compiled block did the slow part and then failed. */
assert.doesNotMatch(main, /'\/bin\/(?:cp|mv)'/)

/* Killing a process group is POSIX-only; Windows walks the tree with taskkill.
   A child process left running is a Python kernel nobody can stop. */
assert.match(killTree, /taskkill/)
assert.match(killTree, /process\.platform === 'win32'/)

/* The build's macOS-only steps have to stay behind a check — a Windows build
   that tries to sign a .app fails at the last step, after the long part. */
assert.match(build, /process\.platform === 'darwin'/)

console.log('platform contracts: all checks passed')
