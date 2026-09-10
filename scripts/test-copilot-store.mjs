/* Does the conversation's own bookkeeping keep its books?
 *
 * The panel test (test-copilot-view.mjs) drives the whole panel in a window;
 * this one holds only the pieces split out of it — the cap, the digest, the
 * on-disk shape of a message, and the store's delta write with its eviction
 * and its recovery from a failed write. Plain node, no window, no bridge.
 *
 * These are the paths whose invariants used to live only in comments: which
 * row the cap sheds first, what a failed write puts back, which conversation
 * a rename's write must not forget.
 */

import * as esbuild from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('node_modules/.cache', { recursive: true })
await esbuild.build({
  entryPoints: ['scripts/test-copilot-store.page.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'node_modules/.cache/test-copilot-store.mjs',
  logLevel: 'error'
})
await import('../node_modules/.cache/test-copilot-store.mjs')
