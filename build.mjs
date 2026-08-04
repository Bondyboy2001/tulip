import * as esbuild from 'esbuild'
import { execFile } from 'node:child_process'
import { access, cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const watch = process.argv.includes('--watch')
const output = watch ? 'dist' : `.dist-stage-${process.pid}`
const buildsNativePdfOcr = process.platform === 'darwin'

if (!watch) await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
/* Chunk names carry a content hash, so a chunk that changes is written under a
   new name and the old one is left behind. Cleared rather than accumulated —
   nothing loads a stale chunk, but a dist that only ever grows makes the size
   of the bundle impossible to read. */
await rm(path.join(output, 'chunks'), { recursive: true, force: true })
await cp('src/index.html', path.join(output, 'index.html'))

/* pdf.js reads these at run time rather than having them compiled in: the glyph
   data for a PDF that names a standard font without embedding it, the character
   maps a CJK document needs, the ICC profile that makes CMYK colours right, and
   the wasm decoders for JPEG 2000 and JBIG2 images. Copied next to the bundle so
   the app is offline and the page's own origin is the only thing it fetches from.
   Together they are about 4 MB — most PDFs touch none of it, but the ones that do
   render as blank pages without it. */
for (const dir of ['standard_fonts', 'cmaps', 'iccs', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${dir}`, path.join(output, 'pdfjs', dir), { recursive: true })
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
  outdir: output,
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
  outfile: path.join(output, 'pdf.worker.js'),
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
  outfile: path.join(output, 'pdf-text.cjs'),
  /* pdf.js reaches for these when it is asked to *draw* — a canvas to draw on,
     and a polyfill for a browser class node lacks. Nothing here draws, and
     leaving them to be resolved would fail the build over packages the app has
     never installed. */
  external: ['canvas', 'path2d'],
  minify: !watch,
  logLevel: 'info'
}

/* The three.js runtime a ```three block draws with — see src/threelib.js. One
   self-contained script exposing a `THREE` global, because the guest loads it
   with a plain <script src> from a document that has no module graph and no
   import map. It is three quarters of a megabyte and nothing else in the app
   touches it, so it stays out of the renderer's bundle entirely: only a note
   with a scene in it ever pays for the file. */
const three = {
  entryPoints: ['src/threelib.js'],
  bundle: true,
  format: 'iife',
  globalName: 'THREE',
  platform: 'browser',
  target: ['chrome130'],
  outfile: path.join(output, 'three.js'),
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
  outfile: path.join(output, 'lint.cjs'),
  minify: !watch,
  logLevel: 'info'
}

/* Named once: a bundle listed for one of the two branches and forgotten in the
   other is a file that either never rebuilds or never builds. */
const bundles = [options, worker, pdfText, lint, three]

/* Scanned pages have no text layer for pdf.js to return. A tiny native helper
   uses the Vision and PDFKit frameworks already present on macOS, compiled for
   the same architecture as Electron and shipped beside the text extractor. */
async function buildPdfOcr () {
  if (!buildsNativePdfOcr) return
  const arch = process.arch === 'x64' ? 'x86_64' : 'arm64'
  const moduleCache = path.join(os.tmpdir(), `tulip-swift-modules-${process.pid}`)
  await rm(moduleCache, { recursive: true, force: true })
  try {
    await run('xcrun', [
      'swiftc', 'native/pdf-ocr.swift', '-O',
      '-target', `${arch}-apple-macos11.0`,
      '-module-cache-path', moduleCache,
      '-framework', 'AppKit', '-framework', 'PDFKit', '-framework', 'Vision',
      '-o', path.join(output, 'pdf-ocr')
    ])
  } finally {
    await rm(moduleCache, { recursive: true, force: true })
  }
}

if (watch) {
  await buildPdfOcr()
  for (const config of bundles) {
    const ctx = await esbuild.context(config)
    await ctx.watch()
  }
  console.log('watching…')
} else {
  try {
    await Promise.all([...bundles.map((config) => esbuild.build(config)), buildPdfOcr()])

  /** A production tree is complete before it can replace the last known-good
   *  one. This catches a successful-looking partial build and makes stale maps
   *  impossible to carry into the packaged app. */
  const required = [
    'index.html', 'renderer.js', 'renderer.css', 'katex.css',
    'pdf.worker.js', 'pdf-text.cjs', 'lint.cjs', 'three.js',
    'pdfjs/standard_fonts', 'pdfjs/cmaps', 'pdfjs/iccs', 'pdfjs/wasm'
  ]
  if (buildsNativePdfOcr) required.push('pdf-ocr')
  for (const item of required) await access(path.join(output, item))

  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else files.push(abs)
    }
  }
  await walk(output)
  const maps = files.filter((file) => file.endsWith('.map'))
  if (maps.length) throw new Error(`production output contains source maps: ${maps.join(', ')}`)

  const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g
  for (const file of files.filter((file) => file.endsWith('.js'))) {
    const source = await readFile(file, 'utf8')
    for (let match = imports.exec(source); match; match = imports.exec(source)) {
      const target = path.resolve(path.dirname(file), match[1])
      await access(target).catch(() => { throw new Error(`missing import ${match[1]} from ${file}`) })
    }
    imports.lastIndex = 0
  }

  if (process.argv.includes('--test-fail-before-swap')) {
    throw new Error('simulated failure before production output swap')
  }

  const previous = `.dist-previous-${process.pid}`
  await rm(previous, { recursive: true, force: true })
  let held = false
  try {
    await rename('dist', previous).then(() => { held = true }, (err) => {
      if (err.code !== 'ENOENT') throw err
    })
    await rename(output, 'dist')
    await rm(previous, { recursive: true, force: true })
  } catch (err) {
    await rm('dist', { recursive: true, force: true }).catch(() => {})
    if (held) await rename(previous, 'dist').catch(() => {})
    await rm(output, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  } catch (err) {
    await rm(output, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}
