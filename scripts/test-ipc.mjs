/* ================================================================ IPC tests
   The main process's handlers, called directly.
 *
 * Main registers 80-odd `ipcMain.handle` channels and, until this file, not one
 * of them had a test. Everything under electron/ that could be pulled out into
 * a pure module has been — safe-name, config-keys, search-narrow, the stores —
 * and those are well covered. What was left untested is precisely the part that
 * cannot be pulled out: the handlers that touch the real filesystem, and so the
 * handlers where every data-loss bug in this project's history has lived.
 *
 * How it works. An Electron main process stubs `ipcMain.handle` to keep a
 * reference to each callback, then requires the real `electron/main.js` and
 * lets it boot against a scratch vault. The handlers are then called the way
 * the preload calls them — same arguments, same order — against real files.
 * No window is driven and no renderer is involved: this is main's own surface,
 * tested on its own.
 *
 * The vault is a fresh temporary directory and the profile is a fresh
 * `--user-data-dir`, so nothing here can see, let alone touch, a real vault.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
/* The executable the package exports, not the .bin shim: on Windows the shim
   is a .cmd, which spawn will not start without a shell since Node closed
   that hole, and the test died with ENOENT before it began. */
import electron from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(path.join(tmpdir(), 'tulip-ipc-'))
const vault = path.join(scratch, 'vault')
const profile = path.join(scratch, 'profile')
mkdirSync(vault, { recursive: true })
mkdirSync(profile, { recursive: true })
/* The real path, because the vault is what the app watches: on Windows the
   temp directory comes back as an 8.3 name (`RUNNER~1`), and a recursive
   watch on the short name can stay silent about files written under the long
   one. Resolved here so both sides of the harness name the same folder. */
const watched = realpathSync(vault)
writeFileSync(path.join(vault, 'Seed.md'), '# Seed\n\nA note that was already here, mentioning pomegranate.\n')
/* This suite tests the run pipeline, not the consent prompt. Its disposable
   vault is explicitly trusted just as a reader's vault is after accepting the
   prompt, so the compiled-language test reaches compile, stage and execute. */
writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
  vaultPath: watched,
  trustedVaults: [watched]
}))


/* The checks themselves live in scripts/test-ipc.harness.cjs and run inside an
   Electron main process. A separate file rather than a string built here: it is
   a program of a hundred lines, a failure in it should have a stack that points
   at a real line, and a template literal holding code is one stray backtick
   away from a syntax error in a test nobody was editing. */
const harness = path.join(root, 'scripts', 'test-ipc.harness.cjs')

const run = spawnSync(electron, [harness, `--user-data-dir=${profile}`], {
  encoding: 'utf8',
  cwd: root,
  timeout: 120000,
  env: { ...process.env, TULIP_IPC_VAULT: watched, TULIP_IPC_OUTSIDE: scratch }
})

const line = (run.stdout || '').split('\n').find((l) => l.startsWith('TULIP_IPC_RESULTS '))
if (!line) {
  console.error(run.stdout)
  console.error(run.stderr)
  rmSync(scratch, { recursive: true, force: true })
  throw new Error(`the IPC harness produced no results (exit ${run.status})`)
}

const results = JSON.parse(line.slice('TULIP_IPC_RESULTS '.length))
let failed = 0
for (const result of results) {
  if (result.ok) console.log(`ok - ${result.what}`)
  else { console.log(`not ok - ${result.what}\n  ${result.why}`); failed++ }
}
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${results.length - failed} checks passed${failed ? `, ${failed} failed` : ''}`)
if (failed) process.exit(1)
