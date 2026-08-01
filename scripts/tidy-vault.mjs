/* ========================================================= tidy-vault.mjs
   The markdown linter over a folder of notes, from the terminal.

     node scripts/tidy-vault.mjs ~/Notes            rewrite what needs it
     node scripts/tidy-vault.mjs ~/Notes --check    name it and change nothing
     npm run tidy -- ~/Notes [--check]

   The rules are src/lint.js — the same ones the app applies on every save, read
   here out of dist/lint.cjs so there is no second opinion about what tidy means.
   `--check` exits 1 when something would change, which is what a git hook or a
   CI step wants; the default run exits 0 unless a file could not be written.
   ================================================================== */

import { readFile, writeFile, readdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* `src` is ESM and this package is CommonJS, so node reads src/lint.js as
   CommonJS and stops at its first `export`. The build compiles it around that —
   see build.mjs — which is why this asks for the built file. */
let lintMarkdown
try {
  ;({ lintMarkdown } = createRequire(import.meta.url)(path.join(ROOT, 'dist/lint.cjs')))
} catch {
  console.error('dist/lint.cjs is missing — run `npm run build` first.')
  process.exit(2)
}

const args = process.argv.slice(2)
const check = args.includes('--check')
const target = args.find((arg) => !arg.startsWith('-'))

if (!target) {
  console.error('usage: node scripts/tidy-vault.mjs <vault> [--check]')
  process.exit(2)
}

/* What the app's own walk skips — see vaultFiles in electron/main.js. Every
   dot-directory, which covers .git, .obsidian, .trash and the attachments
   folder, plus the one undotted directory that is never notes. */
const IGNORED = new Set(['node_modules'])
const MD = new Set(['.md', '.markdown', '.mdown'])

async function notes (dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await notes(abs))
    else if (MD.has(path.extname(entry.name).toLowerCase())) out.push(abs)
  }
  return out
}

const root = path.resolve(target)
if (!await stat(root).then((s) => s.isDirectory(), () => false)) {
  console.error(`${root} is not a folder.`)
  process.exit(2)
}

/* Through a temporary file in the same folder and a rename over the target, the
   way every note the app writes goes down — see writeAtomic in main.js. A tidy
   is a rewrite of a file whose only copy is the one being rewritten, so a crash
   halfway through must leave the old note rather than half of it. */
async function writeNote (abs, text) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tidy-tmp`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, abs)
}

const files = await notes(root)
let changed = 0
let failed = 0

for (const abs of files) {
  let text
  try { text = await readFile(abs, 'utf8') } catch { continue }

  const next = lintMarkdown(text)
  if (next === text) continue
  changed++

  // Named from inside the vault: it is the reader's own idea of where a note is,
  // and it does not turn into a row of `../..` when the vault is elsewhere.
  const name = path.relative(root, abs)
  if (check) { console.log(name); continue }

  try {
    await writeNote(abs, next)
    console.log(`tidied ${name}`)
  } catch (err) {
    failed++
    console.error(`could not write ${name}: ${err.message}`)
  }
}

const noun = `${files.length} ${files.length === 1 ? 'note' : 'notes'}`
if (check) {
  const verb = changed === 1 ? 'needs' : 'need'
  console.log(changed ? `${changed} of ${noun} ${verb} tidying` : `${noun}, all tidy`)
  process.exit(changed ? 1 : 0)
}
console.log(changed ? `tidied ${changed} of ${noun}` : `${noun}, nothing to do`)
process.exit(failed ? 1 : 0)
