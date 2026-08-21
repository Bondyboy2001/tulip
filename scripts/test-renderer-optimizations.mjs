import assert from 'node:assert/strict'
import { searchablePage, itemAtOffset } from '../src/pdf-search.js'
import { firstPageEndingAfter } from '../src/pdf-window.js'

const normalized = searchablePage('Alpha  \n  beta\tgamma', [
  { at: 0, y: 90 },
  { at: 10, y: 50 },
  { at: 15, y: 10 }
])
assert.equal(normalized.display, 'Alpha beta gamma')
assert.equal(normalized.search, 'alpha beta gamma')
assert.equal(itemAtOffset(normalized.items, normalized.search.indexOf('beta')).y, 50)
assert.equal(itemAtOffset(normalized.items, normalized.search.indexOf('gamma')).y, 10)

let seed = 0x51debeef
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}
for (let run = 0; run < 20000; run++) {
  let top = 0
  const pages = Array.from({ length: 1 + Math.floor(random() * 1200) }, () => {
    const from = top
    const height = 300 + Math.floor(random() * 1400)
    top += height + Math.floor(random() * 40)
    return { from, to: from + height }
  })
  const point = Math.floor(random() * (top + 1000)) - 500
  const expected = pages.findIndex((page) => page.to > point)
  const actual = firstPageEndingAfter(pages.length, point, (index) => pages[index])
  assert.equal(actual, expected < 0 ? pages.length : expected)
}

// `retirePainters` is tested through the real bundled module with the minimum
// renderer globals it expects at import time.
globalThis.window = { tulip: { on () {}, run: { start () {}, stop () {}, warm () {} } } }
globalThis.requestAnimationFrame = (callback) => { callback(); return 1 }
class FakeElement {
  constructor (children = []) { this.children = children; this.retired = 0 }
  querySelectorAll () { return this.children }
}
globalThis.Element = FakeElement
const { retirePainters } = await import('../src/runcode.js')
const children = Array.from({ length: 2000 }, () => {
  const child = new FakeElement()
  child.tkRetire = () => { child.retired++ }
  return child
})
const root = new FakeElement(children)
root.tkRetire = () => { root.retired++ }
retirePainters(root)
assert.equal(root.retired, 1)
assert.equal(children.filter((child) => child.retired === 1).length, 2000)

// A panel drag exposes one start/end pair so the renderer can pin an expensive
// Reading page for the duration without changing the divider's live width.
class EventHub {
  constructor () { this.listeners = new Map() }
  addEventListener (type, callback, options = {}) {
    const list = this.listeners.get(type) || []
    list.push({ callback, once: !!options.once })
    this.listeners.set(type, list)
  }
  removeEventListener (type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((x) => x.callback !== callback))
  }
  dispatch (type, event = {}) {
    for (const item of [...(this.listeners.get(type) || [])]) {
      item.callback({ button: 0, pointerId: 1, clientX: 320, preventDefault () {}, ...event })
      if (item.once) this.removeEventListener(type, item.callback)
    }
  }
}

const fakeStyle = () => ({
  values: new Map(),
  setProperty (key, value) { this.values.set(key, value) }
})
const panel = (left, right) => ({ getBoundingClientRect: () => ({ left, right }) })
const grip = () => Object.assign(new EventHub(), {
  offsetParent: {},
  style: {},
  classList: { add () {}, remove () {} },
  getClientRects () { return [{}] },
  setPointerCapture () {}
})
const panelApp = { dataset: {}, style: fakeStyle(), append () {} }
const sidebarGrip = grip()
const starts = []
const previews = []
const ends = []
globalThis.window.addEventListener = () => {}
globalThis.window.innerWidth = 1440
globalThis.MutationObserver = class { observe () {} }
globalThis.ResizeObserver = class { observe () {} }
let panelFrame = null
globalThis.requestAnimationFrame = (callback) => { panelFrame = callback; return 7 }
globalThis.cancelAnimationFrame = (id) => { if (id === 7) panelFrame = null }
const { mountPanels } = await import('../src/panels.js')
mountPanels({
  el: {
    app: panelApp,
    gripSidebar: sidebarGrip, sidebar: panel(0, 248),
    gripSide: grip(), sidepane: panel(700, 1080),
    gripAi: grip(), aiPanel: panel(740, 1080)
  },
  api: { config: { set () {} } },
  onResizeStart: (key) => { starts.push(key); return true },
  onResizePreview: (key, width) => previews.push([key, width]),
  onResizeEnd: (key) => ends.push(key)
})
sidebarGrip.dispatch('pointerdown')
sidebarGrip.dispatch('pointermove', { clientX: 280 })
sidebarGrip.dispatch('pointermove', { clientX: 300 })
assert.equal(panelApp.style.values.get('--rail'), undefined)
assert.deepEqual(starts, ['railWidth'])
assert.deepEqual(previews, [])
panelFrame()
assert.deepEqual(previews, [['railWidth', 300]])
assert.deepEqual(ends, [])
// Releasing before the next frame flushes its final coordinate synchronously.
sidebarGrip.dispatch('pointermove', { clientX: 310 })
sidebarGrip.dispatch('pointerup')
assert.equal(panelApp.style.values.get('--rail'), '310px')
assert.deepEqual(previews, [['railWidth', 300], ['railWidth', 310]])
assert.deepEqual(ends, ['railWidth'])

console.log('renderer optimizations: all checks passed')
