/* Bundle the renderer modules, then run the DOM benchmark inside Electron —
   `node bench/dom-bench.mjs` previously imported Electron as ordinary Node and
   never reached Chromium. */

import * as esbuild from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
/* The executable the package exports, not the .bin shim: on Windows the shim
   is a .cmd, which spawn will not start without a shell since Node closed
   that hole, and the test died with ENOENT before it began. */
import electron from 'electron'

await mkdir('node_modules/.cache', { recursive: true })
const output = 'node_modules/.cache/tulip-dom-bench.mjs'
await esbuild.build({
  entryPoints: ['bench/dom-bench-entry.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  loader: { '.svg': 'text' },
  outfile: output,
  logLevel: 'error'
})
const result = spawnSync(electron, [output], { stdio: 'inherit' })
process.exit(result.status ?? 1)
