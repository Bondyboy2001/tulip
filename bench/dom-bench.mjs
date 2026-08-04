/* Bundle the renderer modules, then run the DOM benchmark inside Electron —
   `node bench/dom-bench.mjs` previously imported Electron as ordinary Node and
   never reached Chromium. */

import * as esbuild from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

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
const result = spawnSync('node_modules/.bin/electron', [output], { stdio: 'inherit' })
process.exit(result.status ?? 1)
