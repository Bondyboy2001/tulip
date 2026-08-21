/* Runs bench/reading-bench-entry.js inside a real Chromium document, so the
   HTML parse, the DOM mutations and the style invalidation each stage causes
   are the same work the app does. `node` alone cannot host it: half of these
   stages are `querySelectorAll` and `innerHTML`.

   Usage:  node bench/reading-bench.mjs [note.md]
   With no argument it generates the same shaped note the other benches use. */

import * as esbuild from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const args = process.argv.slice(2)
const note = args.find((arg) => !arg.startsWith('--'))
const check = args.includes('--check')

const generated = () => {
  const out = ['# Big Note\n']
  for (let i = 0; i < 400; i++) {
    out.push(`## Section ${i}\n`)
    out.push(`Some prose with **bold**, *italic*, \`code\`, [[Wiki Link ${i}]] and $x_{${i}}^2$ inline math. Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`)
    out.push('```rust\nfn main() {\n    let v = vec![1, 2, 3];\n    for x in &v { println!("{}", x); }\n}\n```\n')
    out.push('| Col A | Col B | Col C |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |\n')
    out.push('- item one\n- item two\n  - nested\n\n')
    out.push(`$$\n\\sum_{i=1}^{${i + 1}} i^2\n$$\n`)
  }
  return out.join('\n')
}

const body = note ? await readFile(note, 'utf8') : generated()

await mkdir('node_modules/.cache/reading-bench', { recursive: true })
const dir = path.resolve('node_modules/.cache/reading-bench')
await esbuild.build({
  /* KaTeX's stylesheet is a sibling of the bundle in the app, and src/math.js
     refuses to render maths until it has loaded. Emitted here under the same
     name so the bench pays for the same maths the reading view does. */
  entryPoints: {
    'reading-bench-entry': 'bench/reading-bench-entry.js',
    katex: 'node_modules/katex/dist/katex.min.css'
  },
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: dir,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: ['chrome130'],
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'text' },
  logLevel: 'error'
})
await writeFile(path.join(dir, 'index.html'),
  '<!doctype html><meta charset="utf-8"><body><script type="module" src="./reading-bench-entry.js"></script>')
await writeFile(path.join(dir, 'note.json'), JSON.stringify(body))
await writeFile(path.join(dir, 'host.mjs'), `
import electron from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
const { app, BrowserWindow } = electron
const dir = ${JSON.stringify(dir)}
app.commandLine.appendSwitch('js-flags', '--expose-gc')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900 })
  await win.loadFile(path.join(dir, 'index.html'))
  const body = JSON.parse(await readFile(path.join(dir, 'note.json'), 'utf8'))
  const result = await win.webContents.executeJavaScript(
    'window.__tulipReadingBench(' + JSON.stringify(body) + ')')
  console.log(JSON.stringify(result, null, 2))
  app.exit(0)
}).catch((err) => { console.error(err); app.exit(1) })
`)

const result = spawnSync('node_modules/.bin/electron', [path.join(dir, 'host.mjs')], {
  stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8'
})
process.stdout.write((result.stdout || '').split('\n').filter((l) => !/^\s*$/.test(l)).join('\n') + '\n')
if (result.status !== 0) {
  process.stderr.write(result.stderr || '')
  process.exit(result.status ?? 1)
}
if (check) {
  try {
    const report = JSON.parse(result.stdout)
    const open = report.stages?.find((stage) => stage.label === 'WHOLE OPEN')
    if (!open || open.ms > 1000) {
      console.error(`reading performance gate failed: whole open ${open?.ms ?? 'missing'}ms`)
      process.exit(1)
    }
    console.error(`reading performance gate passed: whole open ${open.ms}ms`)
  } catch (error) {
    console.error(`reading performance gate failed: ${error.message}`)
    process.exit(1)
  }
}
