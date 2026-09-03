/* Does the Word viewer draw what the document said?
 *
 * The zip, the XML and the blocks are checked without a browser in
 * scripts/test-docx.cjs. This is the other half: the viewer mounted in a real
 * window, handed a document holding one of every shape it draws, asked what
 * ended up in the DOM.
 *
 * It exists for what a reading test cannot reach. A `.docx` has no list element
 * — a list is a run of paragraphs that each name a level — so the nesting is
 * rebuilt by the viewer and is only true if the DOM says so. A link in a Word
 * document points out of the vault, and has to leave through `openExternal`
 * rather than navigating this window, which has no way back. And the editing is
 * a real contenteditable: what typing into one produces, and what the save
 * built from it sends, cannot be asserted anywhere but in a window.
 *
 * A small window appears for a moment. Same harness as test-notebook-view.mjs.
 */

import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
/* The executable the package exports, not the .bin shim: on Windows the shim
   is a .cmd, which spawn will not start without a shell since Node closed
   that hole, and the test died with ENOENT before it began. */
import electron from 'electron'

await mkdir('node_modules/.cache', { recursive: true })
await esbuild.build({
  entryPoints: ['scripts/test-docx.page.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: 'node_modules/.cache/docx-page.js',
  loader: { '.svg': 'text' },
  logLevel: 'error'
})

/* Only the layout the assertions rest on: a host with a height, so `scrollTop`
   is a number that can move. Everything the app's stylesheet says about type
   and colour is beside the point here. */
await writeFile('node_modules/.cache/docx-page.html', `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  #host { width: 900px; height: 400px; overflow: auto; }
  #host > .docx-page { padding-bottom: 900px; }
</style>
<div id="host"></div>
<script type="module">
  window.__done = import('./docx-page.js').then((mod) => mod.run())
</script>`)

await writeFile('node_modules/.cache/docx-main.mjs', `
import electron from 'electron'
const { app, BrowserWindow } = electron
const say = (payload) => { console.log(JSON.stringify(payload)); app.exit(payload.error ? 1 : 0) }
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 940, height: 640, show: true, webPreferences: { backgroundThrottling: false }
  })
  const said = []
  win.webContents.on('console-message', (e, level, message) =>
    said.push(String(e?.message ?? message ?? '')))
  win.webContents.on('did-fail-load', (_e, code, desc) => said.push('load failed: ' + code + ' ' + desc))
  try {
    await win.loadFile(${JSON.stringify(path.resolve('node_modules/.cache/docx-page.html'))})
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
        say({ error: 'timed out waiting for the docx scenario — reached: ' +
          (probe && probe.stage) + (said.length ? '\\n' + said.slice(-12).join('\\n') : '') })
      }
    }
  } catch (err) {
    say({ error: String(err && err.stack || err) })
  }
})`)

const run = spawnSync(electron, ['node_modules/.cache/docx-main.mjs'],
  { encoding: 'utf8' })
const line = run.stdout.trim().split('\n').filter(Boolean).pop() || ''
let probe
try { probe = JSON.parse(line) } catch {
  console.error(run.stdout)
  console.error(run.stderr)
  throw new Error(`docx harness produced no result (exit ${run.status})`)
}
if (probe.error) throw new Error(probe.error)
const r = probe.result

let passed = 0
const ok = (what, fn) => { fn(); passed++; console.log(`ok - ${what}`) }

/* --------------------------------------------------------- what it drew */

ok('the document’s hierarchy is drawn as headings', () => {
  assert.deepEqual(r.headings, ['H1:Field notes', 'H2:Monday'])
})

ok('emphasis, alignment and breaks survive the trip', () => {
  assert.equal(r.aligned, 'center')
  assert.deepEqual(r.emphasis, ['is-bold', 'is-italic is-underline'])
  assert.ok(r.hasBreak, 'the run holding a break drew no <br>')
})

ok('a quote style is drawn as a quote', () => assert.ok(r.quoted))

ok('a picture is drawn at the size Word laid it out at', () => {
  assert.deepEqual(r.image, { alt: 'the paddock', width: 120, height: 60 })
})

/* Word has no list element: a list is a run of paragraphs each naming a level,
   and the nesting below exists only because the viewer rebuilt it. */
ok('a list inside a list is drawn inside the item it belongs to', () => {
  assert.equal(r.topLists, 1, 'the sub-list was drawn as a second top-level list')
  assert.equal(r.nested, 'ol', 'the numbered sub-list did not come back numbered')
  assert.equal(r.nestedInsideItem, 'yes')
  assert.equal(r.nestedItems, 2)
  assert.equal(r.topItems, 2, 'the outer list lost or gained an item')
})

ok('and the paragraph after a list is not swallowed by it', () => {
  assert.equal(r.afterList, 'after the list')
})

ok('a table keeps its header row, its spans and its own scroller', () => {
  assert.deepEqual(r.tableHeaders, ['Day', 'Rain'])
  assert.deepEqual(r.tableCells, ['Mon', '4mm'])
  assert.equal(r.tableSpan, 2)
  assert.ok(r.tableScrolls, 'a wide table would push the whole column sideways')
})

ok('the status line is told the document’s length', () => {
  assert.equal(r.status, '12 words')
  assert.equal(r.title, 'Field notes, week 12')
})

/* Three lines, not three blocks: the break inside that paragraph is a line
   break in the text as well, which is what the agent should be reading. */
ok('the copilot is handed the document as text, headings and all', () => {
  assert.deepEqual(r.text, ['# Field notes', '## Monday', 'Warm and bright'])
})
ok('the copilot context is a focused paragraph window with document position', () => {
  assert.equal(r.context.at, 1)
  assert.ok(r.context.paragraphs > 3)
  assert.match(r.context.text, /# Field notes/)
  assert.equal(r.context.title, 'Field notes, week 12')
})

/* ------------------------------------------------------ and what it did */

ok('the Reading view is read-only, and the Editing view is not', () => {
  assert.equal(r.editableWhileReading, 'false')
  assert.equal(r.editableWhileEditing, 'true')
})

ok('a link leaves through the browser while the document is being read', () => {
  assert.deepEqual(r.opened[0], ['external', 'https://example.com/log'])
})

/* Clicking a link mid-sentence to put the caret in it must not open a browser
   — which is the whole difference between reading and writing. */
ok('and is a piece of text while it is being written', () => {
  assert.equal(r.openedWhileEditing, 1, 'clicking a link in the editing view opened it')
})

/* The count after an edit is counted from the page, not taken from the read —
   which is why it is not the fixture's own `words: 12`. In the app the two
   agree, because both count the same words. */
ok('typing into the page changes it, and says so', () => {
  assert.equal(r.typed, 'Monday morning')
  assert.equal(r.dirtyAfterTyping, true)
  assert.equal(r.wordsAfterTyping, 25, 'the word count did not follow the edit')
})

ok('⌘B bolds the selection', () => {
  assert.ok(r.bolded, 'nothing came back bold')
  assert.equal(r.boldedText, 'after the list', 'the words changed as well as their weight')
})

ok('⌥⌘3 makes the paragraph a heading', () => assert.equal(r.promoted, 'H3'))

ok('Return splits a paragraph in two', () => {
  assert.deepEqual(r.split, ['quo', 'ted'])
})

ok('a table cell takes typing', () => assert.equal(r.cellText, 'Monday'))

/* --------------------------------------------------------- and the save

   The point of the whole design: what goes over the wire is mostly ranges of
   the file that is already on disk. */

ok('a save sends one item per block, in the order the document reads', () => {
  assert.equal(r.wrote, 1)
  assert.equal(r.itemCount, 11, 'the split paragraph should have added one item')
  assert.equal(r.savedCount, 1)
  assert.equal(r.dirtyAfterSave, false)
  assert.equal(r.stamp, 'stamp-1', 'the save was not written against the document that was read')
})

ok('the paragraphs nobody touched are kept rather than rewritten', () => {
  assert.equal(r.kept, 5, `kept ${r.kept}, rewrote ${r.rewritten}`)
  assert.equal(r.listKept, 4, 'a list nobody edited was rewritten')
})

ok('an edited paragraph keeps its properties and its place in the file', () => {
  assert.match(r.headingKeptItsStyle, /Heading2/)
  assert.deepEqual(r.headingKeptItsPlace, [20, 30])
})

ok('a bolded word is a run of its own, and the rest of the paragraph is not', () => {
  assert.deepEqual(r.boldRun, ['bafter', ' the list'])
})

ok('the heading command writes the style the document says it is', () => {
  assert.match(r.headingStyleWritten, /<w:pStyle w:val="Heading3"\/>/)
})

ok('a paragraph made by splitting has nowhere in the file to come from', () => {
  assert.equal(r.newParagraphs, 1)
})

/* A picture is the one thing on the page this app cannot write: the run it
   arrived as is what goes back, even when the paragraph around it was
   rewritten because somebody typed a word into it. */
ok('a picture inside a rewritten paragraph is carried, not rebuilt', () => {
  assert.ok(r.pictureStillDrawn, 'the picture left the page when its paragraph was edited')
  assert.ok(r.pictureCarried, 'the picture run was not put back as it arrived')
})

ok('only the edited cell of a table is rewritten', () => {
  assert.ok(r.tableRewritten, 'the table was kept whole despite a cell being typed into')
  assert.equal(r.tableKeptItsGrid, '<w:tblPr/><w:tblGrid/>')
  assert.deepEqual(r.tableCellsKept, [false, true, true],
    'a cell nobody typed in was rewritten, or the edited one was not')
})

/* A cell continuing a vertical merge is never drawn — and must still be in the
   file afterwards, or the table loses a column when it is saved. */
ok('and the cells a merge hides are still in the save', () => {
  assert.equal(r.mergedCellKept, 3)
})

/* A save moves every offset in the file. The page is told where it now is
   rather than redrawn — a redraw would take the caret with it, and would throw
   away anything typed while the write was in flight. */
ok('the second save is written against the file the first one produced', () => {
  assert.equal(r.secondStamp, 'stamp-2', 'the page saved against the document it had replaced')
  assert.deepEqual(r.secondRanges, [1000, 1010, 1020], 'the paragraphs were not told where they moved to')
})

ok('and only the paragraph edited since is rewritten', () => {
  assert.equal(r.secondRewritten, 1, `rewrote ${r.secondRewritten}`)
  /* Ten items, one of them typed into since — and the table, which the stub's
     reply replaced wholesale, is rewritten rather than kept because its cells'
     ranges came back as the reply stated them. */
  assert.equal(r.secondKept, 9, `kept ${r.secondKept}`)
})

/* ---------------------------------------------------------------- undo

   ⌘Z used to fall through to the editor, which holds nothing while a viewed
   kind is on screen — so a mistyped word in a Word document could not be taken
   back at all. */

ok('⌘Z takes back the last change, and ⇧⌘Z puts it back', () => {
  assert.equal(r.beforeUndo, 'Monday morning and Tuesday')
  assert.equal(r.undid, true, 'there was nothing to undo')
  assert.equal(r.afterUndo, 'Monday morning')
  assert.equal(r.redid, true, 'there was nothing to redo')
  assert.equal(r.afterRedo, 'Monday morning and Tuesday')
})

ok('a run of typing undoes as one change, not one per letter', () => {
  // The `!` is from the earlier save; the burst is the six letters after it.
  assert.equal(r.burstTyped, 'quo!abcdef')
  assert.equal(r.afterBurstUndo, 'quo!')
})

ok('and an undo is a change the file catches up with', () => {
  assert.equal(r.savedAfterUndo, 3, 'the undone document was not written back')
})

ok('a renamed document is saved to its new name', () => {
  assert.equal(r.wroteTo, 'Notes/Field notes renamed.docx')
})

/* ---------------------------------------------------- lists and tables

   The two structures Word writes that this app could not make: it could change
   the words of a list and never start one. */

ok('a paragraph becomes a list item', () => {
  assert.equal(r.listedInto, 'UL')
})

ok('and the same button again takes it back out', () => assert.ok(r.unlisted))

ok('every paragraph a selection covers becomes a list item', () => {
  assert.equal(r.selectionListed, 2, 'both lines the selection covered')
  assert.equal(r.selectionListSort, 'OL')
  assert.ok(r.selectionOneList, 'one list, not one per line — the numbering runs on')
})

ok('and the same button again takes the whole selection back out', () => {
  assert.equal(r.selectionUnlisted, 2)
})

ok('a table is made with the shape it was asked for', () => {
  assert.deepEqual(r.tableShape, [2, 3])
  assert.ok(r.tableHasHeader, 'the first row is the header row Word would draw')
})

/* A structural change redraws the table from its model, so what was typed into
   a cell a moment before has to be read back into that model first — or the
   redraw throws it away. */
ok('a row and a column can be added to it, keeping what was typed', () => {
  assert.deepEqual(r.grownShape, [3, 4])
  assert.equal(r.grownKept, 'Kept', 'the cell typed into was emptied by the redraw')
  assert.equal(r.inTable, true)
})

ok('and the save writes the table it did not have before', () => {
  assert.deepEqual(r.tableWritten, [3, 4])
  assert.ok(r.tableBordered, 'a table Tulip made came out with no borders')
})

/* ---------------------------------------------- emptied altogether */

/* A `contenteditable` will give up its last paragraph, and what was left was an
   empty <article>: nowhere to put a caret, so every command on the bar acted on
   no paragraph and did nothing, and what was typed afterwards went in as a bare
   text node that the save read straight past. Tulip wrote real documents with
   no paragraph in them this way, and once written they could not be typed into
   again. */
ok('a document emptied of its last paragraph keeps one to type into', () => {
  assert.equal(r.emptiedTo, 1, 'the page was left with nothing to put a caret in')
  assert.deepEqual(r.emptiedShape, ['P'])
})

ok('and what is typed into it lands in a paragraph, not loose in the page', () => {
  assert.equal(r.typedIntoEmpty, 'typed into nothing')
  assert.equal(r.typedIntoAParagraph, 'typed into nothing',
    'the typing was loose in the page, where a save cannot see it')
})

ok('and the bar can still reach it', () => assert.ok(r.listedFromEmpty))

ok('and the save carries what was typed rather than dropping it', () => {
  assert.equal(r.emptySaveItems, 1)
  assert.equal(r.emptySaveText, 'typed into nothing')
})

/* The <br> an empty paragraph is drawn with is the room for a caret, not a
   break the document holds. Read back as one, every blank line gained a
   `w:br` — so one blank line in Word became two. */
ok('a blank line is written as a blank line, not as a line break', () =>
  assert.equal(r.blankLineRuns, 0, 'an empty paragraph was saved with a run in it'))

/* ------------------------------------------------- the one question */

ok('a document with fields in it asks once, before the first edit', () => {
  assert.equal(r.askedOnce, 1)
  assert.match(r.askedAbout, /fields; comments/)
  assert.equal(r.stillEditing, 'true')
})

ok('and saying no puts it back into its reading view', () => {
  assert.equal(r.askedTwice, 2)
  assert.equal(r.refusedEditing, 'false')
})

/* --------------------------------------------------------- and closing */

ok('the place is where the reader scrolled to', () => assert.equal(r.place, 40))

ok('a file it cannot read throws, and leaves the open document alone', () => {
  assert.match(r.refused, /could not be read/)
  assert.equal(r.stillDrawn, 2, 'the failed open tore down the document on screen')
})

/* The two buttons that used to sit under the document are gone: a permanent
   control at the foot of a page is one you have to scroll to the end of a
   document to reach. Opening the file in Word is on the toolbar now, which the
   renderer owns. */
ok('the page carries no chrome of its own', () => assert.ok(r.noFooter))

/* What the toolbar shows is read off the page rather than from the browser's
   own idea of bold, which knows nothing about a run whose weight came out of a
   `w:rPr`. */
ok('the bar is told what the caret is sitting in', () => {
  assert.equal(r.formatHeading.level, 3, 'a heading did not report its level')
  assert.deepEqual(r.formatMarks, ['bold'])
  assert.equal(r.formatList, 'bullet')
  assert.equal(r.formatTable, true, 'a cell did not report that it is in a table')
})

/* ---------------------------------------------- the document moved under us

   A `.docx` is not mergeable. When the file on disk is no longer the one the
   page was read from — a sync client wrote it, another app saved it — there is
   no right answer available at write time: forcing loses their version,
   re-reading loses the reader's. So the disk's version is put aside as a
   conflict copy and the reader's edits go in against the bytes the page was
   read from, which keeps both.

   These are here rather than in test-docx.cjs because the halves were already
   tested separately and the wiring between them was not: main answering
   `{stale}`, and the renderer making a copy. Neither of those tells you that a
   reader who typed a sentence into a document a sync client touched still has
   their sentence. */

ok('a stale write asks about the document, once, by name', () => {
  assert.equal(r.conflictAsked, 1)
  assert.equal(r.conflictPath, 'Notes/Field notes.docx')
})

ok('and goes again, forcing, once the disk copy is safe', () => {
  assert.equal(r.conflictAttempts, 2, 'the write should have been retried')
  assert.deepEqual(r.conflictForced, [false, true],
    'the first attempt must not force, and the second must')
})

/* The retry carries the same edit — the stamp the page was read at included.
   Forcing a different body would write something nobody typed. */
ok('the retry is the same edit, not a fresh one', () => {
  assert.equal(r.conflictSameStamp, true)
})

ok('the reader keeps what they typed, and the page comes back clean', () => {
  assert.ok(r.conflictTyped.includes('Z'), `the typed character is not there: ${r.conflictTyped}`)
  assert.equal(r.conflictClean, true, 'the page still says it has unsaved edits')
  assert.ok(r.conflictSaved > 0, 'nothing reported the document as saved')
})

/* A reader who declines the copy has declined the write. The failure has to be
   loud: a silent success would leave the page believing it is on disk when the
   document there is somebody else's. */
ok('declining the copy fails the save rather than forcing it', () => {
  assert.equal(r.declinedAsked, 1)
  assert.match(r.declinedError, /changed on disk/)
  assert.equal(r.declinedDirty, true, 'the page must still know it is unsaved')
})

/* ------------------------------------------------- lists inside lists */

ok('items taken out of a sub-list leave the item that held them whole', () => {
  assert.deepEqual(r.leftSubList.slice(0, 4),
    ['UL:outer one', 'P:inner one', 'P:inner two', 'UL:outer two'])
})

ok('Return on an empty sub-item climbs out one level at a time', () => {
  assert.deepEqual(r.enterMadeItem.slice(0, 2), ['UL:outer one|outer two', 'P:after the list'])
  assert.deepEqual(r.enterClimbed.slice(0, 2), ['UL:outer one||outer two', 'P:after the list'])
  assert.deepEqual(r.enterLeft.slice(0, 3), ['UL:outer one', 'P:', 'UL:outer two'])
})

ok('a letter typed in bold beside a sub-list keeps the sub-list', () => {
  assert.deepEqual(r.boldBesideSubList, { text: 'outer onex', bold: true, subItems: 2 })
})

ok('a paragraph the browser emptied is saved empty, not as a break', () => {
  assert.equal(r.emptiedByBrowser, true, 'the browser refused the delete')
  assert.deepEqual(r.emptiedRuns, [], `saved as ${JSON.stringify(r.emptiedRuns)} from ${r.emptiedHtml}`)
})

ok('a selection ending at the start of the next paragraph leaves it alone', () => {
  assert.deepEqual(r.touchedNext, { warned: 0, heading: 'quoted', itemStill: 'LI' })
})

ok('Return over a selection from an empty bullet takes nothing out of the list', () => {
  assert.equal(r.enterOverSelection[0].startsWith('UL:outer one|outer two|'), true, r.enterOverSelection.join(' / '))
  assert.equal(r.enterOverSelection.some((line) => line.startsWith('P:after the list')), true)
})

ok('closing empties the pane', () => assert.equal(r.closedTo, 0))

ok('nothing warned', () => assert.deepEqual(r.warned, []))

console.log(`\n${passed} checks passed`)
