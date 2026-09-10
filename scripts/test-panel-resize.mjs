import assert from 'node:assert/strict'
import { appSession, delay } from './lib/app-session.mjs'
const executable = process.argv[2]
if (!executable) { console.log('panel resize: skipped until a built executable is supplied'); process.exit(0) }
const app = await appSession({ executable, files: { 'Note.md': '# Note\n', 'Reference.md': '# Reference\n' }, config: { tabs: ['Note.md'], tabIndex: 0, zoom: 1, sidebar: 'closed', ai: 'closed' } })
try {
  // Right-panel motion must not cover the toolbar before its final layout.
  await app.command('Emulation.setDeviceMetricsOverride', { width: 1728, height: 1000, deviceScaleFactor: 1, mobile: false })
  await app.evaluate('window.tulip.zoom.set(1.5)')
  await delay(350)
  for (const opening of [true, false]) {
    const frames = await app.evaluate(`(async () => {
      const frames = []
      const start = performance.now()
      window.__tulip.runCommand('copilot')
      do {
        await new Promise(requestAnimationFrame)
        const controls = [...document.querySelectorAll('.view-option'), document.getElementById('zoom'), document.getElementById('ai-toggle')]
        frames.push(controls.map(node => {
          const rect = node.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          return { x: rect.x, visible: !!hit && (hit === node || node.contains(hit)) }
        }))
      } while (performance.now() - start < 420)
      return frames
    })()`)
    assert.ok(frames.length > 5, 'sample multiple animation frames')
    assert.ok(frames.every(frame => frame.every(control => control.visible)), 'view controls stay visible throughout right-panel motion')
    for (let i = 1; i < frames.length; i++) {
      const movement = frames[i].at(-1).x - frames[i - 1].at(-1).x
      assert.ok(opening ? movement < 2 : movement > -2, 'toolbar moves continuously without snapping back')
    }
  }
  await app.evaluate('window.tulip.zoom.set(1)')
  await delay(350)
  for (const panel of ['ai', 'side']) {
  const hostId = panel === 'ai' ? 'ai' : 'sidepane'
  const key = panel === 'ai' ? 'chatWidth' : 'sideWidth'
  for (const viewport of [1400, 900, 700, 500]) {
    await app.command('Emulation.setDeviceMetricsOverride', { width: viewport, height: 800, deviceScaleFactor: 1, mobile: false })
    await app.evaluate(`window.__tulip.runCommand(${JSON.stringify(panel === 'ai' ? 'copilot' : 'open-beside')}); true`)
    await delay(500)
    assert.equal(await app.evaluate(`document.elementFromPoint(document.querySelector('#${hostId}').getBoundingClientRect().left, 300)?.id`), `grip-${panel}`, `${viewport}: opened panel edge is draggable before resetting`)
    await app.evaluate(`document.querySelector('#grip-${panel}').dispatchEvent(new MouseEvent('dblclick')); true`)
    await delay(300)
    const before = await app.evaluate(`(() => {
      const host = document.querySelector('#${hostId}').getBoundingClientRect();
      const grip = document.querySelector('#grip-${panel}').getBoundingClientRect();
      return { width: host.width, edge: host.left, x: grip.left + grip.width / 2, y: 300, hit: document.elementFromPoint(host.left, 300)?.id, innerWidth }
    })()`)
    console.log('before', JSON.stringify(before))
    assert.equal(before.hit, `grip-${panel}`, `${viewport}: handle receives pointer at Copilot edge`)
    assert.ok(Math.abs(before.edge - before.x) < 2, `${viewport}: handle follows opened drawer`)
    await app.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 })
    await app.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + 65, y: before.y, button: 'left', buttons: 1 })
    await delay(80)
    await app.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x + 65, y: before.y, button: 'left', clickCount: 1 })
    await delay(300)
    const after = await app.evaluate(`(async () => ({ width: document.querySelector('#${hostId}').getBoundingClientRect().width, saved: (await window.tulip.config.get()).${key} }))()`)
    assert.ok(before.width - after.width > 40, `${viewport}: dragging narrows Copilot (${before.width} -> ${after.width})`)
    assert.ok(Math.abs(after.width - after.saved) < 2, `${viewport}: dragged width persists`)
    await app.evaluate(`document.querySelector('#${hostId}-close').click(); true`)
    await delay(300)
  }
  }
  const saved = await app.evaluate('(async () => { const cfg = await window.tulip.config.get(); return [cfg.chatWidth, cfg.sideWidth] })()')
  await app.restart()
  const restored = await app.evaluate('(async () => { const cfg = await window.tulip.config.get(); return [cfg.chatWidth, cfg.sideWidth] })()')
  assert.deepEqual(restored, saved, 'widths survive restart')
  console.log('panel resize: real pointer drag, hit targets and persisted widths passed')
} finally { await app.dispose() }
