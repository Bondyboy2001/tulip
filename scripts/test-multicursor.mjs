import assert from 'node:assert/strict'
import { appSession, delay } from './lib/app-session.mjs'

for (const mode of ['edit', 'raw']) {
  const app = await appSession({ executable: process.argv[2],
    files: { 'Note.md': 'alpha\nbeta\ngamma\n' },
    config: { tabs: ['Note.md'], tabIndex: 0, view: mode }
  })
  async function click (pos, modifiers = 0) {
    await app.evaluate('window.__tulip.editor.focus()')
    await delay(100)
    const point = await app.evaluate(`(() => {
      const editor = window.__tulip.editor
      const rect = editor.coordsAtPos(${pos})
      return { x: rect.left, y: (rect.top + rect.bottom) / 2 }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await app.command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1, modifiers })
    }
    /* Let the editor settle the selection before the next click: on a loaded
       runner the events alone are quicker than the layout they act on. */
    await app.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  /* The selection the click asked for, once the editor has had its say. */
  const rangesEventually = async (n, what) => {
    for (let i = 0; i < 60; i++) {
      if (await ranges() === n) return
      await delay(50)
    }
    assert.equal(await ranges(), n, what)
  }
  const ranges = () => app.evaluate('window.__tulip.editor.state.selection.ranges.length')
  const text = () => app.evaluate('window.__tulip.editor.state.doc.toString()')
  try {
    await delay(300)
    await app.evaluate('window.__tulip.editor.scrollDOM.scrollTop = 0')
    await delay(100)
    await click(5)
    await click(10, 1)
    await click(16, 1)
    await rangesEventually(3, `${mode}: Option-click adds cursors`)
    await app.command('Input.insertText', { text: '!' })
    assert.equal(await text(), 'alpha!\nbeta!\ngamma!\n')
    await app.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    assert.equal(await text(), 'alpha\nbeta\ngamma\n')
    await delay(600)
    await app.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await delay(100)
    await rangesEventually(1, `${mode}: Escape returns to one cursor`)
    await click(5, 1)
    await rangesEventually(2, `${mode}: Option-click adds a second cursor`)
    await click(10)
    await rangesEventually(1, `${mode}: ordinary click resets cursors`)
    console.log(`${mode}: multiple cursors, typing, deletion, Escape and ordinary click passed`)
  } finally { await app.dispose() }
}
