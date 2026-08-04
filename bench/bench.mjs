/* Runnable entrypoint for the renderer benchmark. Tulip's package is CommonJS
   while src/*.js is bundled as ESM for Chromium, so direct Node imports cannot
   load it correctly. Build the exact benchmark graph first, then execute it. */

import * as esbuild from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

await mkdir('node_modules/.cache', { recursive: true })
const output = 'node_modules/.cache/tulip-render-bench.mjs'
await esbuild.build({
  entryPoints: ['bench/render-bench-entry.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  loader: { '.svg': 'text' },
  outfile: output,
  logLevel: 'error'
})
const result = spawnSync(process.execPath, [output], { stdio: 'inherit' })
process.exit(result.status ?? 1)
