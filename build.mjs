import * as esbuild from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'

const watch = process.argv.includes('--watch')

await mkdir('dist', { recursive: true })
await cp('src/index.html', 'dist/index.html')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/renderer.js'],
  bundle: true,
  outfile: 'dist/renderer.js',
  format: 'iife',
  platform: 'browser',
  target: ['chrome130'],
  // KaTeX's stylesheet references its own woff2 files. Emitting them next to
  // the bundle keeps the app offline and satisfies the page's font-src 'self'.
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  assetNames: 'fonts/[name]',
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info'
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('watching…')
} else {
  await esbuild.build(options)
}
