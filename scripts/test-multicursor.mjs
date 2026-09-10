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
    assert.equal(await ranges(), 3, `${mode}: Option-click adds cursors`)
    await app.command('Input.insertText', { text: '!' })
    assert.equal(await text(), 'alpha!\nbeta!\ngamma!\n')
    await app.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    assert.equal(await text(), 'alpha\nbeta\ngamma\n')
    await delay(600)
    await app.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await delay(100)
    assert.equal(await ranges(), 1, `${mode}: Escape returns to one cursor`)
    await click(5, 1)
    assert.equal(await ranges(), 2)
    await click(10)
    assert.equal(await ranges(), 1, `${mode}: ordinary click resets cursors`)
    console.log(`${mode}: multiple cursors, typing, deletion, Escape and ordinary click passed`)
  } finally { await app.dispose() }
}
