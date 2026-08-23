#!/usr/bin/env node
/* The half of `npm run typecheck` that is allowed to fail a build.
 *
 * tsconfig.json explains why the whole-tree run does not gate: it reports
 * ~2,570 errors, most of them the DOM's own typing, and a gate that is red on
 * the day it is installed is a gate that gets turned off. Its own comment says
 * what to do instead — take the modules that are already clean and hold them
 * there. This is that.
 *
 * It is a filter over the ordinary run rather than a second tsconfig, because
 * `include` does not mean "report only these": tsc reports on every file it
 * pulls into the program, so a clean module that imports a messy one would
 * fail a config-based gate for its neighbour's errors. Narrowing the OUTPUT is
 * the only narrowing that says what we mean.
 *
 * WIDENING IT is the point, and is meant to be routine: fix a module's
 * findings, run `node scripts/typecheck-gate.mjs --suggest`, and paste what it
 * prints into CLEAN below. Removing a file from the list is a decision, not a
 * shortcut — say why in the commit.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* Modules that typecheck clean under strictNullChecks and must stay that way.
   Kept as one flat list rather than globs: a glob quietly adopts every new file
   in a directory, and a gate you did not choose to join is a gate that fails
   for reasons the author did not sign up for. */
const CLEAN = [
  'electron/ai-turns.js',
  'electron/atomic-store.js',
  'electron/chat-history.js',
  'electron/config-keys.js',
  'electron/copilot-rename.js',
  'electron/copilot-restore.js',
  'electron/copilot-search.js',
  'electron/index-cache.js',
  'electron/kill-tree.js',
  'electron/language-history-store.js',
  'electron/language-row.js',
  'electron/path-store.js',
  'electron/pdf-context.js',
  'electron/pdf-text-worker.js',
  'electron/preload.js',
  'electron/range-response.js',
  'electron/review-store.js',
  'electron/safe-name.js',
  'electron/search-narrow.js',
  'electron/trust-store.js',
  'electron/vault-events.js',
  'electron/whiteboard-data.js',
  'src/callouts.js',
  'src/citations.js',
  'src/cite.js',
  'src/copilot-turns.js',
  'src/countries.js',
  'src/dom.js',
  'src/file-icons.js',
  'src/find-bar.js',
  'src/find.js',
  'src/fonts.js',
  'src/guest.js',
  'src/highlight.js',
  'src/history.js',
  'src/htmlrun.js',
  'src/linediff.js',
  'src/links.js',
  'src/lint.js',
  'src/marks.js',
  'src/math-editor.js',
  'src/merge.js',
  'src/mergepanel.js',
  'src/mermaid-editor.js',
  'src/models.js',
  'src/money-editor.js',
  'src/money.js',
  'src/panel-state.js',
  'src/pdf-search.js',
  'src/pdf-text.js',
  'src/pdf-window.js',
  'src/properties.js',
  'src/rawhtml.js',
  'src/reading-split.js',
  'src/review-stats.js',
  'src/runblocks.js',
  'src/saved-searches.js',
  'src/speech.js',
  'src/spell-languages.js',
  'src/spellcheck.js',
  'src/study-match.js',
  'src/svg-editor.js',
  'src/svg.js',
  'src/table-widths.js',
  'src/tabstrip.js',
  'src/tex-split.js',
  'src/themes.js',
  'src/threejs.js',
  'src/threelib.js',
  'src/tikz-editor.js',
  'src/tikz.js',
  'src/time.js',
  'src/tree-diff.js',
  'src/vault-paths.js',
  'src/zoom.js'
]

/* The whole-tree count may only fall. The CLEAN list holds finished modules
   where they are; this holds everything else where it is — a change that adds
   findings to a file nobody has cleaned yet used to land silently, and 2,800
   findings became 2,900 without anyone deciding that. When the number drops,
   lower the ceiling to match in the same commit that earned the drop; the
   gate says so rather than doing it, because a self-lowering ceiling would
   also quietly absorb a fix that later regresses. */
const CEILING = 2437

/* The same tree does not count the same everywhere: a hosted runner's tsc
   sees a slightly different `@types` resolution (platform-specific optional
   packages, a different Node) and reported two more findings than the machine
   that set the ceiling — which failed every CI run on main for a week over
   findings no commit had introduced. The gated modules above are held to
   zero anywhere; the whole-tree ceiling gets this much room for the
   environment and no more. Lowering the ceiling still follows the local
   count, so the room is never absorbed into it. */
const DRIFT = 8

/** tsc exits nonzero when it has findings, which is the normal case here. */
function runTsc () {
  try {
    return execFileSync('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    // A real failure to RUN (no tsc, bad config) writes to stderr and prints
    // no findings; that must not read as "nothing to report".
    const out = err.stdout || ''
    if (!out.includes('error TS')) {
      console.error(err.stderr || err.message)
      process.exit(2)
    }
    return out
  }
}

/** `src/foo.js(12,3): error TS18047: …` → the path, in repo terms. */
const fileOf = (line) => line.slice(0, line.indexOf('(')).replace(/\\/g, '/')

const lines = runTsc().split('\n').filter((l) => l.includes(': error TS'))

if (process.argv.includes('--suggest')) {
  const dirty = new Set(lines.map(fileOf))
  const clean = execFileSync('git', ['ls-files', 'src/*.js', 'electron/*.js'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => !dirty.has(f))
  console.log(clean.map((f) => `  '${f}',`).join('\n'))
  process.exit(0)
}

// A gated file that has been renamed or deleted would otherwise pass for ever
// by being absent from a report it can no longer appear in.
const missing = CLEAN.filter((f) => !existsSync(path.join(root, f)))
const gated = new Set(CLEAN)
const broke = lines.filter((l) => gated.has(fileOf(l)))

for (const f of missing) console.error(`gated file is gone: ${f} — remove it from CLEAN or fix the path`)
for (const l of broke) console.error(l)

if (broke.length || missing.length) {
  const files = new Set(broke.map(fileOf))
  console.error(`\ntypecheck gate: ${broke.length} error(s) in ${files.size} gated file(s), ${missing.length} missing.`)
  console.error('These modules typecheck clean at HEAD. Fix the finding rather than widening the exemption.')
  process.exit(1)
}

if (lines.length > CEILING + DRIFT) {
  console.error(`typecheck gate: ${lines.length} findings in the whole tree, over the ceiling of ${CEILING} (+${DRIFT} for the environment).`)
  console.error('The count only falls. Fix the findings the change introduced rather than raising CEILING.')
  process.exit(1)
}

const spare = CEILING - lines.length
console.log(`typecheck gate: ${CLEAN.length} modules clean, ${lines.length} findings elsewhere (ceiling ${CEILING})`)
if (spare > 0) console.log(`the tree is ${spare} under the ceiling — lower CEILING to ${lines.length} in scripts/typecheck-gate.mjs`)
