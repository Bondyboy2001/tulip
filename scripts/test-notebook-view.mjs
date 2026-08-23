/* Does the notebook behave like a notebook?
 *
 * nbformat, the outputs and the escape codes are checked without a browser in
 * test-notebook.mjs. This is the other half: a real viewer in a real Chromium
 * window, driven with the events a person's keyboard and mouse send, asserting
 * what ends up on screen and — the part that matters — what ends up in the
 * file.
 *
 * It exists because the whole editing half of this viewer was untestable
 * before it. The bugs it holds are the ones a pure test cannot reach: a run
 * whose output goes to a cell that undo replaced, a save that re-serialises
 * megabytes once a millisecond, a command that reads a caret that is not
 * there. None of those is visible by looking at the screen either.
 *
 * A small window appears for a moment. Same harness as test-grid.mjs.
 */

import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

await mkdir('node_modules/.cache', { recursive: true })
await esbuild.build({
  entryPoints: ['scripts/test-notebook.page.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'node_modules/.cache/notebook-page.js',
  loader: { '.svg': 'text' },
  logLevel: 'error'
})

/* Only the layout the viewer's own measurements rest on: a scroller with a
   height, and cells that stack. The app's stylesheet says a great deal more
   and none of it changes an assertion here. */
await writeFile('node_modules/.cache/notebook-page.html', `<!doctype html>
<meta charset="utf-8">
<style>
  :root { --line: #ddd; --line-soft: #eee; --sunk: #f6f6f6; --paper: #fff;
          --surface: #fff; --ink: #222; --ink-soft: #666; --muted: #666;
          --faint: #999; --hover: #eee; --selected: #dde3f0;
          --accent: #3056d3; --accent-dim: #e3e9fa; --active-line: #f4f6fb;
          --code-removed: #a11; --font-ui: sans-serif; --font-mono: monospace;
          --font-body: serif; }
  body { margin: 0; }
  #host { display: flex; flex-direction: column; width: 900px; height: 600px; }
  .nb-scroll { flex: 1; overflow: auto; }
  .nb-col { display: flex; flex-direction: column; gap: 6px; }
  .nb-cell { position: relative; display: grid; grid-template-columns: 3.4rem 1fr; }
  .nb-source { position: relative; }
  .nb-input { position: absolute; inset: 0; width: 100%; height: 100%; }
  .nb-hint[hidden] { display: none; }
</style>
<div id="host"></div>
<script type="module">
  window.__done = import('./notebook-page.js').then((mod) => mod.run())
</script>`)

await writeFile('node_modules/.cache/notebook-main.mjs', `
import electron from 'electron'
const { app, BrowserWindow } = electron
const say = (payload) => { console.log(JSON.stringify(payload)); app.exit(payload.error ? 1 : 0) }
app.whenReady().then(async () => {
  /* backgroundThrottling off for the same reason the grid's harness turns it
     off: the suite runs in parallel, and Chromium stops servicing rAF in a
     window that is behind another. This viewer coalesces its repaints into a
     rAF, so a throttled window is one where no output is ever drawn. */
  const win = new BrowserWindow({
    width: 940, height: 640, show: true, webPreferences: { backgroundThrottling: false }
  })
  /* Anything the page says out loud, kept for the failure message. A scenario
     that wedges says nothing at all otherwise, and "timed out" is not a
     diagnosis — the stage marker below is what turns it into one. */
  const said = []
  // Electron moved this event's payload onto the event object; both shapes here.
  win.webContents.on('console-message', (e, level, message) =>
    said.push(String(e?.message ?? message ?? '')))
  win.webContents.on('did-fail-load', (_e, code, desc) => said.push('load failed: ' + code + ' ' + desc))
  try {
    await win.loadFile(${JSON.stringify(path.resolve('node_modules/.cache/notebook-page.html'))})
    for (let wait = 0; wait < 200; wait++) {
      const probe = await win.webContents.executeJavaScript(\`
        (async () => {
          if (!window.__done) return { stage: 'the page module never loaded' }
          const settled = await Promise.race([
            window.__done.then((result) => ({ result }), (err) => ({ error: String(err && err.stack || err) })),
            new Promise((resolve) => setTimeout(() => resolve(null), 50))
          ])
          return settled || { stage: window.__stage || '(nothing yet)' }
        })()\`)
      if (probe && !probe.stage) { win.destroy(); return say(probe) }
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (wait === 199) {
        say({ error: 'timed out waiting for the notebook scenario — reached: ' +
          (probe && probe.stage) + (said.length ? '\\n' + said.slice(-12).join('\\n') : '') })
      }
    }
  } catch (err) {
    say({ error: String(err && err.stack || err) })
  }
})`)

const run = spawnSync(electron, ['node_modules/.cache/notebook-main.mjs'],
  { encoding: 'utf8' })
const line = run.stdout.trim().split('\n').filter(Boolean).pop() || ''
let probe
try { probe = JSON.parse(line) } catch {
  console.error(run.stdout)
  console.error(run.stderr)
  throw new Error(`notebook harness produced no result (exit ${run.status})`)
}
if (probe.error) throw new Error(probe.error)
const r = probe.result

let passed = 0
const ok = (what, fn) => { fn(); passed++; console.log(`ok - ${what}`) }

/* --------------------------------------------------------- what it drew */

ok('a notebook opens as the cells it is', () => {
  assert.equal(r.cellCount, 3)
  assert.deepEqual(r.kinds, ['is-markdown', 'is-code', 'is-code'])
})

ok('an image pasted into a markdown cell is drawn, not left broken', () => {
  assert.ok(r.attachmentDrawn, 'the pasted image did not become an <img>')
  assert.equal(r.attachmentLeftForVault, false,
    'an attachment: stub was left for the vault resolver, which cannot answer it')
  assert.equal(r.attachmentSourceKept, true, 'the cell’s own source was rewritten')
})

ok('a cell says how long it took, from what the file recorded', () => {
  assert.equal(r.duration, '4.5 s')
})

ok('a cell shows what it is tagged', () => {
  assert.deepEqual(r.tags, ['setup'])
})

/* ------------------------------------------------------- the command keys */

ok('a notebook just opened is one the keyboard can already drive', () => {
  assert.equal(r.selectedOnOpen, 0)
})

ok('the arrows walk down the cells', () => {
  assert.equal(r.afterFirstDown, 1)
  assert.equal(r.afterSecondDown, 2)
})

ok('Run cell runs the chosen cell, with no caret anywhere', () => {
  // This is the case that did nothing at all: the command read `editingIndex`,
  // which is -1 unless a textarea is focused — so it was silent in Reading
  // view and silent after every Escape.
  assert.equal(r.ranWithoutCaret, true)
})

ok('a cell can be added and deleted without a mouse', () => {
  assert.equal(r.afterAdd, 4)
  assert.equal(r.addedIsChosen, 3, 'the new cell is the one the keyboard is on')
  assert.equal(r.afterDelete, 3)
})

ok('one d is not a delete', () => {
  assert.equal(r.afterLoneD, 3, 'a lone d, then a later one, deleted a cell')
})

ok('a moved cell keeps the section it was drawn in', () => {
  assert.equal(r.movedDown, true, 'Move down did not move the cell it belongs to')
  assert.equal(r.movedBack, true, 'Move up from the carried section moved the wrong cell')
  assert.equal(r.moveKeptOthers, true,
    'a cell nothing happened to was rebuilt anyway')
  assert.equal(r.renumbered, true, 'a section that moved still claims its old number')
})

ok('a cell can be retyped from the keyboard', () => {
  assert.equal(r.retyped, 'is-markdown')
  assert.equal(r.retypedBack, 'is-code')
})

ok('a cell can be copied and pasted', () => {
  assert.equal(r.afterPaste, 4)
  assert.equal(r.pasteMatches, true, 'the pasted cell is not the cell that was copied')
})

/* ---------------------------------------------------------- the running */

ok('output from a run lands in the cell that asked for it', () => {
  assert.equal(r.liveOutput, 'frame 1')
})

ok('a redrawn display replaces the frame it names', () => {
  assert.equal(r.redrawnCount, 1, 'every frame was kept instead of one being replaced')
  assert.equal(r.redrawnText, 'frame 2')
})

ok('a cell waiting on input() has somewhere to type the answer', () => {
  assert.equal(r.stdinShown, true)
  assert.equal(r.stdinPrompt, 'Name?')
  assert.equal(r.stdinAnswer, 'Ada')
  assert.equal(r.stdinGone, true, 'the line stayed after it was answered')
  assert.equal(r.stdinEchoed, true, 'the answer is not part of what the cell printed')
})

ok('a cell’s outputs fold away and say that they have', () => {
  assert.equal(r.foldedAway, true)
  assert.equal(r.foldedSaysSo, true, 'a folded cell drew nothing at all')
  assert.equal(r.unfolded, true)
})

/* ------------------------------------------------------------- the find */

ok('a search finds a cell by what it printed', () => {
  assert.equal(r.foundInOutput, '1 of 1')
  assert.equal(r.hitCell, 1)
})

ok('a search steps forward and back', () => {
  assert.deepEqual(r.findSteps, ['1 of 2', '2 of 2', '1 of 2'])
})

/* ------------------------------------------------------ what a save costs */

ok('two hundred lines of output are not two hundred saves', () => {
  /* Each save is a deep copy and a JSON.stringify of the whole notebook,
     every recorded plot's base64 among it, and then a write of all of it. At
     the old 900ms debounce a cell printing steadily paid that once a second
     for the length of the run, and the file only gets bigger as it goes. */
  assert.ok(r.writesWhileStreaming <= 1,
    `a streaming cell wrote the file ${r.writesWhileStreaming} times`)
  assert.equal(r.streamDrawn, true, 'the output was throttled away rather than the save')
})

ok('and the run ending does ask for the save', () => {
  assert.equal(r.wroteWhenDone, true, 'a finished run left its output unsaved')
})

ok('undo during a run does not orphan the run', () => {
  /* The run maps are keyed by the cell object, deliberately. Undo restores
     copies of the cells, so without re-pointing them the rest of a running
     cell's output arrived, found no cell, and was dropped without a word. */
  assert.equal(r.outputSurvivedUndo, true)
})

/* --------------------------------------------------------- the restart */

ok('a restart is asked about before it throws the session away', () => {
  assert.equal(r.restartAsked, true, 'a restart happened with no question asked')
  assert.equal(r.restartRefused, true)
})

/* --------------------------------------------------------- the exports */

ok('a notebook can be taken out as a script beside itself', () => {
  assert.equal(r.scriptPath, 'Papers/Analysis.py')
  assert.ok(r.scriptBody.includes('# %%'), r.scriptBody)
  assert.ok(r.notes.some((n) => n.includes('Analysis.py')), r.notes.join(' | '))
})

ok('and as one HTML file', () => {
  assert.equal(r.htmlPath, 'Papers/Analysis.html')
})

/* ------------------------------------------------------- the completion */

ok('Tab after a name asks the kernel what completes there', () => {
  assert.deepEqual(r.completions, ['df.head', 'df.hist'])
  assert.equal(r.completed, 'df.hist')
})

ok('Tab at the start of a line is still indentation', () => {
  assert.equal(r.tabIndents, '    ')
})

/* ------------------------------------------------------ what got written */

ok('what the file holds is still a notebook Jupyter wrote', () => {
  const written = JSON.parse(r.saved)
  assert.equal(written.nbformat, 4)
  assert.equal(Array.isArray(written.cells), true)
  // One space of indent and sorted keys, which is nbformat's own spelling.
  assert.ok(r.saved.startsWith('{\n "cells": ['), r.saved.slice(0, 40))
  assert.ok(r.saved.endsWith('}\n'))
  // The display id belongs to a conversation with a kernel, not to the file.
  assert.equal(r.saved.includes('display_id'), false)
  assert.equal(r.saved.includes('transient'), false)
  // And no cell claims to be a kind of cell nbformat has never heard of.
  for (const cell of written.cells) {
    assert.ok(['code', 'markdown', 'raw'].includes(cell.cell_type), cell.cell_type)
    if (cell.cell_type !== 'code') assert.equal('outputs' in cell, false)
  }
})

console.log(`\n${passed} checks passed`)
