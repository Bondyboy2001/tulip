/* ==================================================== panel widths
   The three resizable columns — the sidebar, the side pane and the assistant —
   and the arithmetic that keeps the note readable however wide they are asked
   to be.

   Its own module because none of it is about notes: it moves numbers between
   a pointer, a custom property and the config file, and the rest of the app
   only ever needs to hand back the widths a previous session left.
   ================================================================== */

/* However wide the panels are asked to be, the note itself keeps a column it
   can still be read in. */
const MAIN_FLOOR = 380

/* How far an arrow key moves an edge, with and without shift. */
const NUDGE = 8
const NUDGE_FAST = 32

/**
 * @param {object} deps
 * @param {object} deps.el   the DOM registry — grips, hosts, and the app shell
 * @param {object} deps.api  the preload bridge, for persisting a width
 * @param {() => void} deps.onResize
 *   Run whenever the columns have been refitted. Narrowing the main column is
 *   one of the ways the tab strip starts to overflow, and only the caller knows
 *   what else depends on its width.
 * @returns {{restorePanelWidths: (cfg: object) => void}}
 */
export function mountPanels ({ el, api, onResize }) {
  /* Each panel states its own width the way the stylesheet does: one custom
     property, one stored key. The column arithmetic stays in the CSS — this only
     ever moves a number, so a panel that is closed needs no special case.
     `grow` is which way the panel widens as the cursor moves right: the sidebar
     is anchored on the left, the two right-hand panels on the other side. */
  const PANELS = [
    { grip: el.gripSidebar, host: el.sidebar, prop: '--rail', key: 'railWidth',
      def: 248, min: 172, max: 520, grow: 1 },
    { grip: el.gripSide, host: el.sidepane, prop: '--side', key: 'sideWidth',
      def: 380, min: 280, max: 720, grow: -1 },
    { grip: el.gripAi, host: el.aiPanel, prop: '--chat', key: 'chatWidth',
      def: 340, min: 260, max: 680, grow: -1 }
  ]

  /**
   * The width asked for, and the width the window can actually spare, held
   * apart: a narrow window squeezes a panel without forgetting how wide it was
   * asked to be, so widening the window gives the width back.
   */
  function setPanelWidth (p, px) {
    p.want = Math.round(Math.max(p.min, Math.min(p.max, px)))
    return fitPanel(p)
  }

  function fitPanel (p) {
    // The other open panels are already spoken for, so the room this one may
    // take is what is left over once they and the note's floor are counted.
    const taken = PANELS.reduce(
      (sum, q) => sum + (q === p || !panelOpen(q) ? 0 : q.width), 0)
    const room = window.innerWidth - taken - MAIN_FLOOR
    p.width = Math.max(p.min, Math.min(p.want, room))
    el.app.style.setProperty(p.prop, `${p.width}px`)
    return p.width
  }

  function refitPanels () {
    for (const p of PANELS) if (panelOpen(p)) fitPanel(p)
    onResize?.()
  }

  /** A closed panel is a zero-wide column, and its handle is hidden with it. */
  function panelOpen (p) {
    return p.grip.offsetParent !== null
  }

  for (const p of PANELS) {
    p.want = p.width = p.def

    p.grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()

      /* The edge the width is measured from does not move while the panel's own
         edge is dragged, so it is read once. */
      const box = p.host.getBoundingClientRect()
      const anchor = p.grow === 1 ? box.left : box.right

      p.grip.setPointerCapture(e.pointerId)
      el.app.dataset.resizing = 'yes'
      p.grip.classList.add('is-live')

      const move = (ev) => setPanelWidth(p, (ev.clientX - anchor) * p.grow)
      const done = () => {
        p.grip.removeEventListener('pointermove', move)
        delete el.app.dataset.resizing
        p.grip.classList.remove('is-live')
        onResize?.()
        api.config.set({ [p.key]: p.want })
      }

      p.grip.addEventListener('pointermove', move)
      p.grip.addEventListener('pointerup', done, { once: true })
      p.grip.addEventListener('pointercancel', done, { once: true })
    })

    // Back to the width the app ships with — the same gesture a window divider
    // answers to.
    p.grip.addEventListener('dblclick', () => {
      api.config.set({ [p.key]: setPanelWidth(p, p.def) })
    })

    p.grip.addEventListener('keydown', (e) => {
      const step = (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0)
      if (!step) return
      e.preventDefault()
      setPanelWidth(p, p.want + step * p.grow * (e.shiftKey ? NUDGE_FAST : NUDGE))
      api.config.set({ [p.key]: p.want })
    })
  }

  window.addEventListener('resize', refitPanels)

  /* Opening a panel takes room from the ones already out, so the fit is redone
     whenever one of them opens or closes — wherever in the app that happened. */
  new MutationObserver(refitPanels).observe(el.app, {
    attributeFilter: ['data-sidebar', 'data-outline', 'data-side', 'data-ai']
  })

  /** Widths as they were left, and kept legal when the window is smaller than
   *  the screen they were set on. */
  const restorePanelWidths = (cfg) => {
    for (const p of PANELS) setPanelWidth(p, Number(cfg[p.key]) || p.def)
  }

  return { restorePanelWidths }
}
