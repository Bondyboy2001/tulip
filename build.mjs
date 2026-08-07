import * as esbuild from 'esbuild'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const watch = process.argv.includes('--watch')
/* Only a release build advances the version. `npm start` runs this file too, so
   an unconditional bump rewrote package.json and the lockfile on every launch —
   the working tree drifted several patch versions without a single release, and
   the number in the built app stopped meaning anything. */
const release = process.argv.includes('--release')
const output = watch ? 'dist' : `.dist-stage-${process.pid}`
/* Vision and PDFKit are macOS frameworks and `swiftc` is part of the Mac
   toolchain, so the OCR helper is a macOS artifact and nothing else can build
   it. The worker that runs it already treats a missing binary as "this PDF has
   no text layer and cannot be read" (see recognize() in pdf-text-worker.js), so
   the other platforms simply go without rather than failing to build. */
const mac = process.platform === 'darwin'
const pdfOcrCache = path.join(os.homedir(), 'Library', 'Caches', 'Tulip', 'native')

/* A release build is a version boundary for the local app. Advance only the
   patch component — one thousandth in the project's three-part version — after
   the new dist has safely replaced the old one. Plain builds and watch mode stay
   version-neutral, so neither `npm start` nor saving a file rewrites the package
   manifests; `build-app.sh`, which is what actually produces an installable app,
   passes `--release`. */
async function bumpPatchVersion () {
  const packagePath = 'package.json'
  const lockPath = 'package-lock.json'
  const packageData = JSON.parse(await readFile(packagePath, 'utf8'))
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageData.version)
  if (!match) throw new Error(`cannot advance non-semver version ${packageData.version}`)

  const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
  packageData.version = version
  await writeFile(packagePath, `${JSON.stringify(packageData, null, 2)}\n`)

  const lockData = JSON.parse(await readFile(lockPath, 'utf8'))
  lockData.version = version
  if (lockData.packages?.['']) lockData.packages[''].version = version
  await writeFile(lockPath, `${JSON.stringify(lockData, null, 2)}\n`)
  console.log(`version advanced to ${version}`)
}

/* Tulip presents Excalidraw in English and does not expose its separate AI
   text-to-diagram product. The published entry point nevertheless contains a
   dynamic import for every translation and for Mermaid conversion, which
   makes esbuild faithfully ship several megabytes that no Tulip control can
   reach. Rewrite only those optional imports while bundling; fail loudly when
   an upstream release changes their shape so an upgrade cannot silently ship
   a broken editor. Markdown Mermaid diagrams remain handled by Tulip's own
   renderer. */
const leanExcalidraw = {
  name: 'lean-excalidraw',
  setup (build) {
    build.onLoad({
      filter: /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/](?:prod|dev)[\\/]index\.js$/
    }, async ({ path: file }) => {
      let source = await readFile(file, 'utf8')
      const localeEntry = /(["']\.\/locales\/[^"']+\.json["']\s*:\s*\(\)\s*=>\s*import\(\s*["'][^"']+["']\s*\)\s*,?)/g
      let locales = 0
      source = source.replace(localeEntry, (entry) => {
        locales++
        return entry.includes('/en.json') ? entry : ''
      })
      const mermaidImport = /import\(\s*["']@excalidraw\/mermaid-to-excalidraw["']\s*\)/g
      const mermaid = source.match(mermaidImport)?.length || 0
      source = source.replace(
        mermaidImport,
        'Promise.reject(new Error("Mermaid paste is not enabled in Tulip whiteboards."))'
      )
      if (locales < 2 || mermaid < 1) {
        throw new Error('Excalidraw optional-import layout changed; update leanExcalidraw.')
      }
      return { contents: source, loader: 'js', resolveDir: path.dirname(file) }
    })
  }
}

/* Chromium 130 understands WOFF2, and KaTeX's stylesheet lists WOFF and TTF
   fallbacks for browsers old enough to predate it. Keep the runtime's font
   choices intact while avoiding nearly a megabyte of duplicate font data in
   the packaged app. Fail loudly if KaTeX changes the declaration shape so a
   dependency upgrade cannot silently emit a stylesheet with missing fonts. */
const leanKatex = {
  name: 'lean-katex',
  setup (build) {
    build.onLoad({
      filter: /[\\/]node_modules[\\/]katex[\\/]dist[\\/]katex\.min\.css$/
    }, async ({ path: file }) => {
      let source = await readFile(file, 'utf8')
      const fallbacks = /,url\(fonts\/[^)]+\.woff\)\s+format\("woff"\),url\(fonts\/[^)]+\.ttf\)\s+format\("truetype"\)/g
      const count = source.match(fallbacks)?.length || 0
      source = source.replace(fallbacks, '')
      if (count < 1) throw new Error('KaTeX font declarations changed; update leanKatex.')
      return { contents: source, loader: 'css', resolveDir: path.dirname(file) }
    })
  }
}

/* markdown-it reaches for `entities`, and takes two things from it: decodeHTML
   and decodeHTMLStrict. The package's barrel re-exports its *encoder* as well,
   whose generated table is 23KB, and esbuild will not shake that back out —
   `sideEffects: false` in entities' manifest notwithstanding, a bundle whose
   only import is decodeHTML still carries encode-html.js in full. markdown-it
   is on the eager startup path (the reading view is the view a launch opens
   in), so those 23KB were compiled before every first paint, to encode text
   that nothing here encodes.

   Pointed at the decode-only entry the package publishes instead. Which names
   markdown-it actually wants is read out of markdown-it rather than assumed,
   and checked against what that entry exports, so the release that starts
   wanting an encoder fails this build rather than shipping a reading view that
   throws "decodeHTML is not a function" on the first `&amp;`. */
const ENTITIES_DECODE = path.resolve('node_modules/entities/lib/esm/decode.js')

async function checkEntitiesDecodeCovers () {
  const dir = 'node_modules/markdown-it/lib'
  const sources = []
  const walk = async (at) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const abs = path.join(at, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (/\.(mjs|js)$/.test(entry.name)) sources.push(abs)
    }
  }
  await walk(dir)

  const wanted = new Set()
  for (const file of sources) {
    const source = await readFile(file, 'utf8')
    const imports = /import\s*\{([^}]*)\}\s*from\s*['"]entities['"]/g
    for (let m = imports.exec(source); m; m = imports.exec(source)) {
      for (const part of m[1].split(',')) {
        // `a as b` is imported as `a`; the local name is markdown-it's business.
        const name = part.trim().split(/\s+as\s+/)[0].trim()
        if (name) wanted.add(name)
      }
    }
  }
  if (!wanted.size) throw new Error('markdown-it no longer imports entities; drop leanEntities.')

  const decode = await readFile(ENTITIES_DECODE, 'utf8')
  const has = (name) =>
    new RegExp(`export\\s+(?:function|const|let|var)\\s+${name}\\b`).test(decode) ||
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(decode)

  const missing = [...wanted].filter((name) => !has(name))
  if (missing.length) {
    throw new Error(
      `markdown-it imports ${missing.join(', ')} from entities, which its decode ` +
      'entry does not export; update leanEntities.'
    )
  }
}

const leanEntities = {
  name: 'lean-entities',
  setup (build) {
    let checked = null
    build.onResolve({ filter: /^entities$/ }, async ({ importer }) => {
      // Only markdown-it's. Anything else that wants the whole package keeps
      // it — and everything else that does is behind a dynamic import anyway.
      if (!/[\\/]node_modules[\\/]markdown-it[\\/]/.test(importer)) return null
      checked ||= checkEntitiesDecodeCovers()
      await checked
      return { path: ENTITIES_DECODE }
    })
  }
}

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
  /* Excalidraw's stylesheet had the same problem, and it was the larger half
     of it: 141KB of the 326KB renderer.css, on the render-blocking <link> in
     index.html, for a drawing engine whose *code* is already behind a dynamic
     import. esbuild hoists CSS reached through a dynamic import into the entry
     point's stylesheet — splitting applies to modules, not to their styles —
     so the lazy chunk was lazy and its 141KB of CSS was not.

     Named here so it lands at `dist/whiteboard.css`, and linked in by
     whiteboard.js beside the runtime. It has to stay the *last* stylesheet the
     document holds: bundled, it sorted after styles.css, so Tulip's own rules
     lose ties to Excalidraw's today and must keep losing them. A <link>
     appended to <head> at mount time is after renderer.css, which is the same
     order by another route. */
  entryPoints: {
    renderer: 'src/renderer.js',
    katex: 'node_modules/katex/dist/katex.min.css',
    whiteboard: `node_modules/@excalidraw/excalidraw/dist/${watch ? 'dev' : 'prod'}/index.css`
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
  /* Excalidraw publishes explicit development/production export conditions
     for both its module and stylesheet. esbuild does not enable either by
     default, so choose the one that matches this build. */
  conditions: [watch ? 'development' : 'production'],
  // KaTeX's stylesheet references its own fonts. Emitting them next to the
  // lazy stylesheet keeps the app offline and satisfies the page's font-src
  // 'self'.
  // Logo artwork that is not in Simple Icons ships as the brand's own SVG,
  // imported as text and inlined — the page's CSP forbids fetching anything.
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'text' },
  assetNames: 'fonts/[name]',
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info',
  /* `node build.mjs --metafile` writes build/meta.json, which is what answers
     "why is the eager bundle this size" — the startup cost is dominated by how
     much real code V8 has to compile before the first paint, so the question
     comes up whenever that number moves. Off by default: it is analysis
     output, not part of the app. */
  metafile: process.argv.includes('--metafile'),
  plugins: [leanExcalidraw, leanKatex, leanEntities]
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

/* The spellchecker, for the sidebar's Spelling pane. Main-process code again,
   and compiled for the same reason as the two above: the packaged app carries
   no node_modules, so the Hunspell dictionaries have to be *inside* a file that
   ships. The `.aff`/`.dic` loader is what puts them there — the dictionary
   packages read those files off disk relative to themselves at import time,
   which works in the checkout and finds nothing inside /Applications.

   It is the largest thing in `dist` after pdf.js, and it is two dictionaries.
   That is the price of not asking the network for a word list in an app that
   runs with the network off. */
const spellcheck = {
  entryPoints: ['src/spellcheck.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  outfile: path.join(output, 'spellcheck.cjs'),
  loader: { '.aff': 'text', '.dic': 'text' },
  minify: !watch,
  logLevel: 'info'
}

/* Named once: a bundle listed for one of the two branches and forgotten in the
   other is a file that either never rebuilds or never builds. */
const bundles = [options, worker, pdfText, lint, three, spellcheck]

/* Scanned pages have no text layer for pdf.js to return. A tiny native helper
   uses the Vision and PDFKit frameworks already present on macOS, compiled for
   the same architecture as Electron and shipped beside the text extractor. */
async function buildPdfOcr () {
  if (!mac) return
  const arch = process.arch === 'x64' ? 'x86_64' : 'arm64'
  const target = `${arch}-apple-macos11.0`
  const flags = [
    '-O', '-target', target,
    '-framework', 'AppKit', '-framework', 'PDFKit', '-framework', 'Vision'
  ]
  const [source, compiler, sdk] = await Promise.all([
    readFile('native/pdf-ocr.swift'),
    run('xcrun', ['swiftc', '--version']).then(({ stdout, stderr }) => stdout || stderr),
    run('xcrun', ['--sdk', 'macosx', '--show-sdk-version'])
      .then(({ stdout, stderr }) => stdout || stderr)
  ])
  const key = createHash('sha256')
    .update(source)
    .update('\0').update(compiler)
    .update('\0').update(sdk)
    .update('\0').update(flags.join('\0'))
    .digest('hex').slice(0, 20)
  /* This artifact belongs to the Mac toolchain, not the npm install. */
  const cached = path.join(pdfOcrCache, `pdf-ocr-${key}`)
  const destination = path.join(output, 'pdf-ocr')
  await mkdir(pdfOcrCache, { recursive: true })
  try {
    await access(cached)
    await cp(cached, destination)
    return
  } catch { /* compile below */ }

  const moduleCache = path.join(os.tmpdir(), `tulip-swift-modules-${process.pid}`)
  const candidate = path.join(pdfOcrCache, `.pdf-ocr-${key}-${process.pid}`)
  await rm(moduleCache, { recursive: true, force: true })
  try {
    await run('xcrun', [
      'swiftc', 'native/pdf-ocr.swift', ...flags,
      '-module-cache-path', moduleCache,
      '-o', candidate
    ])
    await rename(candidate, cached)
    await cp(cached, destination)
  } finally {
    await rm(candidate, { force: true })
    await rm(moduleCache, { recursive: true, force: true })
  }
}

if (watch) {
  await Promise.all(bundles.map(async (config) => {
    const ctx = await esbuild.context(config)
    await ctx.watch()
  }))
  console.log('source watchers ready; preparing PDF OCR…')
  await buildPdfOcr()
  console.log('PDF OCR ready')
} else {
  try {
    const built = await Promise.all([
      ...bundles.map((config) => esbuild.build(config)),
      buildPdfOcr()
    ])
    if (options.metafile && built[0]?.metafile) {
      await mkdir('build', { recursive: true })
      await writeFile('build/meta.json', JSON.stringify(built[0].metafile))
      console.log('wrote build/meta.json')
    }

  /** A production tree is complete before it can replace the last known-good
   *  one. This catches a successful-looking partial build and makes stale maps
   *  impossible to carry into the packaged app. */
  const required = [
    'index.html', 'renderer.js', 'renderer.css', 'katex.css', 'whiteboard.css',
    'pdf.worker.js', 'pdf-text.cjs', ...(mac ? ['pdf-ocr'] : []), 'lint.cjs', 'three.js',
    'pdfjs/standard_fonts', 'pdfjs/cmaps', 'pdfjs/iccs', 'pdfjs/wasm'
  ]
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
  if (release) await bumpPatchVersion()
}
