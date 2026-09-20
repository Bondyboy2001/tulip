import assert from 'node:assert/strict'
import { appSession, delay } from './lib/app-session.mjs'

/* The caret over a code line is drawn by the editor, inside the line, because
   the layer's caret cannot follow a line's sideways scroll and the browser's
   own is one pixel wide and cannot be widened. These assert the swap happens
   on the lines that scroll and nowhere else, that the caret travels with the
   scroll, and that the drawn overlays which remain — a selection band, a
   second caret — re-measure on the scroll they could not see. */
const note = [
  'before the block',
  '',
  '```js',
  'const a = 1',
  `const wide = '${'x'.repeat(600)}'`,
  'const b = 2',
  '```',
  '',
  'after the block'
].join('\n')

for (const mode of ['edit', 'raw']) {
  const app = await appSession({ executable: process.argv[2],
    files: { 'Note.md': note },
    config: { tabs: ['Note.md'], tabIndex: 0, view: mode } })
  const evaluate = (expr) => app.evaluate(`(() => { const editor = window.__tulip.editor; ${expr} })()`)
  const caretTo = (line, off = 0) =>
    evaluate(`editor.dispatch({ selection: { anchor: editor.state.doc.line(${line}).from + ${off} } })`)
  /* The wide line of the block as the caret's own line: a number is a widget
     inside the line, so the text is looked for rather than the whole line read. */
  const wideLine = `[...editor.contentDOM.querySelectorAll('.cm-line.tk-code-block')]
    .find((l) => l.textContent.includes('const wide'))`
  const flagged = () => evaluate('return editor.dom.classList.contains("has-code-caret")')
  const settle = async () => {
    await app.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await delay(50)
  }
  try {
    await delay(300)
    /* The window is offscreen, so no real focus exists to give the editor —
       emulated focus is what makes `.cm-focused` and the drawn caret real. */
    await app.command('Emulation.setFocusEmulationEnabled', { enabled: true })
    await evaluate('editor.focus()')
    await delay(100)
    assert.equal(await evaluate('return editor.hasFocus'), true, `${mode}: editor did not take focus`)

    // Line 5 is the wide one, line 3 the opening fence, line 7 the closing.
    await caretTo(5, 8)
    await settle()
    assert.equal(await flagged(), mode === 'edit',
      `${mode}: caret on a scrolling code line should mark the editor only in rendered view`)
    if (mode === 'edit') {
      const drawn = await evaluate(
        'return getComputedStyle(document.querySelector(".cm-cursor-primary")).display')
      assert.equal(drawn, 'none', 'edit: the drawn caret should be suppressed on a code line')
      /* What shows instead is the editor's own caret, inside the line: the
         browser's is one pixel and no stylesheet widens it, so the line carries
         a caret of the app's own, at the app's width. The browser's stays
         transparent — two carets at one position would read as one fat one. */
      const own = await evaluate(
        `const line = ${wideLine}
         const caret = line.querySelector('.tk-code-caret')
         if (!caret) return null
         const layer = document.querySelector('.cm-cursor-primary')
         const box = caret.getBoundingClientRect()
         return JSON.stringify({
           width: getComputedStyle(caret).borderLeftWidth,
           drawn: layer ? getComputedStyle(layer).borderLeftWidth : null,
           device: box.width * devicePixelRatio,
           height: box.height,
           lineHeight: parseFloat(getComputedStyle(line).lineHeight),
           native: getComputedStyle(line).caretColor })`)
      assert.ok(own, 'edit: a scrolling code line should carry a caret of the editor\'s own')
      const caret = JSON.parse(own)
      /* Compared against the caret on every other line rather than against a
         number: a border is snapped to whole device pixels, so what 2px
         computes to depends on the window's scale, and the two carets are the
         same caret and have to come out the same width. */
      assert.equal(caret.width, caret.drawn,
        `edit: the caret on a code line is ${caret.width} wide against the editor's own ${caret.drawn}`)
      assert.ok(caret.device >= 2,
        `edit: the caret is ${caret.device} device pixels wide — the browser's own is one, which is what it is here to replace`)
      assert.ok(Math.abs(caret.height - caret.lineHeight) < 1,
        `edit: the caret is ${caret.height}px in a ${caret.lineHeight}px line — it should stand as tall as the line`)
      assert.equal(caret.native, 'rgba(0, 0, 0, 0)',
        'edit: the browser\'s own caret should stay hidden, so that only one caret shows')
    }

    // The fence markers themselves never scroll, so neither does the caret on them.
    for (const [line, what] of [[3, 'opening fence'], [7, 'closing fence'], [1, 'prose above'], [9, 'prose below']]) {
      await caretTo(line, 2)
      await settle()
      assert.equal(await flagged(), false, `${mode}: caret on the ${what} should not mark the editor`)
      assert.equal(await evaluate('return Boolean(document.querySelector(".tk-code-caret"))'), false,
        `${mode}: the ${what} should carry no caret of its own`)
    }

    if (mode === 'edit') {
      /* The whole reason the caret is drawn in the line: a scroll the editor
         cannot see has to carry it, and it has to leave with the text it marks
         rather than hang over the block beside it. */
      await caretTo(5, 8)
      await settle()
      const caretBox = () => evaluate(`const line = ${wideLine}
        const caret = line.querySelector('.tk-code-caret')
        if (!caret) return null
        const box = caret.getBoundingClientRect()
        return JSON.stringify({ left: box.left, right: box.right,
          lineLeft: line.getBoundingClientRect().left })`)
      const still = JSON.parse(await caretBox())
      await evaluate(`const line = ${wideLine}
        line.scrollLeft = 220
        return line.scrollLeft`)
      await settle()
      const scrolled = JSON.parse(await caretBox())
      assert.ok(Math.abs((still.left - scrolled.left) - 220) < 2,
        `edit: the caret moved ${still.left - scrolled.left}px for a 220px scroll — it should be inside the line's scroller`)
      assert.ok(scrolled.right < scrolled.lineLeft,
        'edit: a caret scrolled out of a line should be out of the line\'s own box, where the line\'s overflow hides it')
      await evaluate(`const line = ${wideLine}
        line.scrollLeft = 0
        return true`)
      await settle()
    }

    if (mode === 'edit') {
      /* A scroll the editor cannot see still has to move what its layers drew.
         Select part of the wide line, scroll the block, and the band should
         travel the same distance rather than keep its old rectangle. */
      await evaluate(
        'const l = editor.state.doc.line(5);' +
        'editor.dispatch({ selection: { anchor: l.from + 8, head: l.from + 28 } })')
      await settle()
      const bandLeft = () => evaluate(
        'return document.querySelector(".cm-selectionBackground").getBoundingClientRect().left')
      const before = await bandLeft()
      const scrolled = await evaluate(
        `const lines = [...editor.contentDOM.querySelectorAll('.cm-line.tk-code-block')]
           .filter((l) => !l.classList.contains('tk-code-top') && !l.classList.contains('tk-code-fence'))
         const wide = lines.find((l) => l.scrollWidth > l.clientWidth + 50)
         if (!wide) return null
         wide.scrollLeft = 220
         return wide.scrollLeft`)
      assert.equal(scrolled, 220, 'edit: the wide line did not take a scroll')
      await settle()
      // The scroll sync carries one line's offset to the rest of the block.
      const offsets = await evaluate(
        `return [...editor.contentDOM.querySelectorAll('.cm-line.tk-code-block')]
           .filter((l) => !l.classList.contains('tk-code-top') && !l.classList.contains('tk-code-fence'))
           .map((l) => l.scrollLeft)`)
      assert.ok(offsets.every((left) => left === 220),
        `edit: scroll did not reach the whole block — ${JSON.stringify(offsets)}`)
      const after = await bandLeft()
      assert.ok(Math.abs(before - after - 220) < 4,
        `edit: selection band moved ${before - after}px for a 220px scroll — the layer kept stale coordinates`)
      // And the caret in the block still marks the editor through a selection.
      assert.equal(await flagged(), true, 'edit: selection head on a code line should keep the mark')
    }
    console.log(`${mode}: code-line caret passed`)
  } finally { await app.dispose() }
}
