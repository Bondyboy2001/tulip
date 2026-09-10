#!/usr/bin/env node
/* ============================================================ electron fuses
 * The switches Electron leaves on for developers, turned off for a shipped
 * app. Each one is a way into the main process that nothing in Tulip needs:
 *
 *   RunAsNode            launching `Tulip --node …` or with
 *                        ELECTRON_RUN_AS_NODE set runs it as a plain Node
 *                        interpreter, no window, full file access.
 *   EnableNodeOptionsEnvironmentVariable
 *                        NODE_OPTIONS is read from the environment before any
 *                        app code runs, which is a code-injection path for
 *                        anything that can set an environment variable.
 *   EnableNodeCliInspectArguments
 *                        `--inspect` opens a Node debugger on the main
 *                        process — remote execution with a socket attached.
 *
 * ASAR integrity and `OnlyLoadAppFromAsar` are deliberately NOT here: the
 * build ships `resources/app` as a folder, and those two fuses require an
 * app.asar to validate. Adding them means changing how all three platforms
 * assemble the payload; see the note in the README's development section.
 *
 * Editing the executable invalidates the ad-hoc signature Electron ships, so
 * each build runs this before it signs — and re-signing is what the ordering
 * of build-app.sh and build-win.mjs is for.
 *
 *   node scripts/apply-fuses.mjs <packaged executable>
 */
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'
import process from 'node:process'

const executable = process.argv[2]
if (!executable) {
  console.error('usage: node scripts/apply-fuses.mjs <packaged executable>')
  process.exit(2)
}

await flipFuses(executable, {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false
})

console.log('fuses: no longer runs as node, reads NODE_OPTIONS or accepts --inspect')
