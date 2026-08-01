import * as esbuild from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'

const watch = process.argv.includes('--watch')

await mkdir('dist', { recursive: true })
/* Chunk names carry a content hash, so a chunk that changes is written under a
   new name and the old one is left behind. Cleared rather than accumulated —
   nothing loads a stale chunk, but a dist that only ever grows makes the size
   of the bundle impossible to read. */
await rm('dist/chunks', { recursive: true, force: true })
await cp('src/index.html', 'dist/index.html')

/* pdf.js reads these at run time rather than having them compiled in: the glyph
   data for a PDF that names a standard font without embedding it, the character
   maps a CJK document needs, the ICC profile that makes CMYK colours right, and
   the wasm decoders for JPEG 2000 and JBIG2 images. Copied next to the bundle so
   the app is offline and the page's own origin is the only thing it fetches from.
   Together they are about 4 MB — most PDFs touch none of it, but the ones that do
   render as blank pages without it. */
for (const dir of ['standard_fonts', 'cmaps', 'iccs', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${dir}`, `dist/pdfjs/${dir}`, { recursive: true })
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  /* KaTeX's runtime is already loaded only for a note that contains maths.
     Its stylesheet used to arrive through math.js's static import, which put
     the whole of KaTeX on renderer.css's startup path anyway. Build it as a
     named sibling instead, and math.js links it in beside the runtime. */
  entryPoints: {
    renderer: 'src/renderer.js',
    katex: 'node_modules/katex/dist/katex.min.css'
  },
  bundle: true,
  outdir: 'dist',
  /* ESM with splitting rather than one IIFE, because several of the heaviest
     things here are already written to be loaded on demand and only the format
     was stopping it: the language packs highlight.js asks for with `desc.load()`,
     mermaid's per-diagram grammars, pdf.js, and mermaid itself. An IIFE has no
     way to express a dynamic import, so esbuild inlined every one of them and
     the app waited on all of it at launch. */
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: ['chrome130'],
  // KaTeX's stylesheet references its own fonts. Emitting them next to the
  // lazy stylesheet keeps the app offline and satisfies the page's font-src
  // 'self'.
  // Logo artwork that is not in Simple Icons ships as the brand's own SVG,
  // imported as text and inlined — the page's CSP forbids fetching anything.
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'text' },
  assetNames: 'fonts/[name]',
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info'
}

/* pdf.js parses documents in a worker, which has to be a file of its own: the
   page hands it a URL, not a function. Built separately, and beside the bundle
   so the page's own origin serves it — a worker from anywhere else would be
   cross-origin and refused. */
const worker = {
  ...options,
  entryPoints: ['node_modules/pdfjs-dist/build/pdf.worker.mjs'],
  /* One self-contained file, so it stays an IIFE and keeps `outfile` — the
     splitting the page's bundle wants would give the worker chunks to import,
     and `importScripts` is not something pdf.js's worker does. */
  format: 'iife',
  splitting: false,
  outdir: undefined,
  chunkNames: undefined,
  outfile: 'dist/pdf.worker.js',
  loader: undefined,
  assetNames: undefined
}

/* The same library again, for the process with no window. Main extracts a PDF's
   text into a sidecar the copilot can read — see `ensurePdfText` — and the
   packaged app carries no node_modules for it to import, so pdf.js is compiled
   in here and required out of `dist` the way the renderer's own bundle is.
   CommonJS because main is: an ESM file would have to be imported, and `require`
   is what a lazy load in a CJS module can do without turning it async. */
const pdfText = {
  entryPoints: ['src/pdf-text.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  outfile: 'dist/pdf-text.cjs',
  /* pdf.js reaches for these when it is asked to *draw* — a canvas to draw on,
     and a polyfill for a browser class node lacks. Nothing here draws, and
     leaving them to be resolved would fail the build over packages the app has
     never installed. */
  external: ['canvas', 'path2d'],
  minify: !watch,
  logLevel: 'info'
}

/* The markdown linter, for the one caller that is not the renderer:
   scripts/tidy-vault.mjs, which runs the same rules over a folder of notes from
   the terminal. Compiled rather than imported for the same reason pdf-text is —
   `src` is ESM and this package is CommonJS, so node reads src/lint.js as
   CommonJS and chokes on its first `export`. One set of rules either way, which
   is the point: the editor and the terminal must agree about what is tidy. */
const lint = {
  entryPoints: ['src/lint.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  outfile: 'dist/lint.cjs',
  minify: !watch,
  logLevel: 'info'
}

if (watch) {
  for (const config of [options, worker, pdfText, lint]) {
    const ctx = await esbuild.context(config)
    await ctx.watch()
  }
  console.log('watching…')
} else {
  await Promise.all([
    esbuild.build(options), esbuild.build(worker), esbuild.build(pdfText), esbuild.build(lint)
  ])
}
