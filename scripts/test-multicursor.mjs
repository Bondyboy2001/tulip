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
    /* DOM events, not CDP input: on a hosted runner an offscreen window did
       not route `Input.dispatchMouseEvent` to the editor at all, and the
       modifier is then ours to state rather than the platform's to infer. */
    await app.evaluate(`(() => {
      const editor = window.__tulip.editor
      const rect = editor.coordsAtPos(${pos})
      const init = {
        bubbles: true, cancelable: true, view: window, detail: 1,
        clientX: rect.left + 1, clientY: (rect.top + rect.bottom) / 2,
        button: 0, buttons: 1,
        altKey: ${modifiers === 1}, ctrlKey: false, metaKey: false, shiftKey: false
      }
      editor.contentDOM.dispatchEvent(new MouseEvent('mousedown', init))
      editor.contentDOM.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
      editor.contentDOM.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }))
      return true
    })()`)
    /* Let the editor settle the selection before the next click. */
    await app.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  /* The selection the click asked for, once the editor has had its say. */
  const rangesEventually = async (n, what) => {
    for (let i = 0; i < 60; i++) {
      if (await ranges() === n) return
      await delay(50)
    }
    const seen = await app.evaluate('({ ranges: window.__tulip.editor.state.selection.ranges.map((r) => [r.anchor, r.head]), focused: window.__tulip.editor.hasFocus })')
    assert.equal(await ranges(), n, `${what} — ${JSON.stringify(seen)}`)
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
