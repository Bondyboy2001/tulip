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
const GRIP_WIDTH = 12

/**
 * @param {object} deps
 * @param {any} deps.el   the DOM registry — grips, hosts, and the app shell
 * @param {any} deps.api  the preload bridge, for persisting a width
 * @param {() => void} deps.onResize
 *   Run whenever the columns have been refitted. Narrowing the main column is
 *   one of the ways the tab strip starts to overflow, and only the caller knows
 *   what else depends on its width.
 * @param {(key: string, width: number) => boolean|void} [deps.onResizeStart]
 * @param {(key: string, width: number) => void} [deps.onResizeEnd]
 *   The renderer uses these edges to suspend expensive document relayout while
 *   a divider is moving. The width itself still follows every pointer event.
 * @param {(key: string, width: number) => void} [deps.onResizePreview]
 *   When `onResizeStart` returns true, the grid width is committed only at the
 *   end and this callback supplies the live preview width in between.
 * @returns {{restorePanelWidths: (cfg: object) => void}}
 */
export function mountPanels ({
  el, api, onResize, onResizeStart, onResizePreview, onResizeEnd
}) {
  /* Each panel states its own width the way the stylesheet does: one custom
     property, one stored key. The column arithmetic stays in the CSS — this only
     ever moves a number, so a panel that is closed needs no special case.
     `grow` is which way the panel widens as the cursor moves right: the sidebar
     is anchored on the left, the two right-hand panels on the other side.

     `share` is a second ceiling for a panel whose content has a natural width:
     a fraction of the window it may not take more than, whatever `max` says. */
  const PANELS = [
    /* The file rail holds names, not prose — one deep heading is as wide as it
       ever needs to be, and past that the drag is only taking the note's room
       away. 380 is comfortably wider than the deepest tree the outline draws,
       and the share keeps it from swallowing a small window on the way there. */
    { grip: el.gripSidebar, host: el.sidebar, prop: '--rail', key: 'railWidth',
      def: 248, min: 172, max: 380, share: 0.34, grow: 1 },
    { grip: el.gripSide, host: el.sidepane, prop: '--side', key: 'sideWidth',
      def: 380, min: 280, max: 720, grow: -1 },
    { grip: el.gripAi, host: el.aiPanel, prop: '--chat', key: 'chatWidth',
      def: 340, min: 260, max: 680, grow: -1 }
  ]

  /* A grip nested inside an overflow-hidden panel can only occupy the panel's
     side of its border. Put it on the app shell instead, where its hit target
     can straddle the divider evenly without allowing panel content to leak. */
  for (const p of PANELS) el.app.append(p.grip)

  const placeGrip = (p) => {
    const box = p.host.getBoundingClientRect()
    const edge = p.grow === 1 ? box.right : box.left
    p.grip.style.left = `${Math.round(edge - GRIP_WIDTH / 2)}px`
  }

  /**
   * The width asked for, and the width the window can actually spare, held
   * apart: a narrow window squeezes a panel without forgetting how wide it was
   * asked to be, so widening the window gives the width back.
   */
  function setPanelWidth (p, px, paint = true) {
    p.want = Math.round(Math.max(p.min, Math.min(p.max, px)))
    return fitPanel(p, paint)
  }

  /**
   * The widest this panel may actually be drawn in this window — its own
   * ceiling, and for a panel with a `share`, that fraction of the window.
   *
   * Applied here rather than to `want` for the same reason the room is: the
   * width asked for is remembered whole, so a window that grows hands it back
   * instead of leaving the panel stuck at what a smaller screen allowed.
   */
  function panelCeiling (p) {
    if (!p.share) return p.max
    // Never below the floor: a window too small for the share still owes the
    // panel the width it cannot work under.
    return Math.max(p.min, Math.min(p.max, Math.round(window.innerWidth * p.share)))
  }

  function fitPanel (p, paint = true) {
    // The other open panels are already spoken for, so the room this one may
    // take is what is left over once they and the note's floor are counted.
    const taken = PANELS.reduce(
      (sum, q) => sum + (q === p || !panelOpen(q) ? 0 : q.width), 0)
    const room = window.innerWidth - taken - MAIN_FLOOR
    p.width = Math.max(p.min, Math.min(p.want, panelCeiling(p), room))
    if (paint) el.app.style.setProperty(p.prop, `${p.width}px`)
    return p.width
  }

  function refitPanels () {
    for (const p of PANELS) {
      if (panelOpen(p)) fitPanel(p)
      placeGrip(p)
    }
    onResize?.()
  }

  /** A closed panel is a zero-wide column, and its handle is hidden with it. */
  function panelOpen (p) {
    // A fixed-position grip deliberately has no offsetParent; client rects
    // still distinguish it from the display:none rule of a closed panel.
    return p.grip.getClientRects().length > 0
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
      const deferred = onResizeStart?.(p.key, p.width) === true

      /* A trackpad and a high-polling mouse can send several pointer events
         before Chromium paints one frame. Applying a grid width for each of
         them makes those obsolete intermediate positions compete with the
         document for the main thread — especially a large Reading page. Keep
         only the newest coordinate and paint it once per frame. */
      let nextX = null
      let moveFrame = 0
      const paintMove = () => {
        moveFrame = 0
        if (nextX == null) return
        const x = nextX
        nextX = null
        const width = setPanelWidth(p, (x - anchor) * p.grow, !deferred)
        if (deferred) onResizePreview?.(p.key, width)
        placeGrip(p)
      }
      const move = (ev) => {
        nextX = ev.clientX
        if (!moveFrame) moveFrame = requestAnimationFrame(paintMove)
      }
      const done = () => {
        p.grip.removeEventListener('pointermove', move)
        if (moveFrame) cancelAnimationFrame(moveFrame)
        moveFrame = 0
        // A release between frames still commits the divider where it ended.
        paintMove()
        if (deferred) el.app.style.setProperty(p.prop, `${p.width}px`)
        delete el.app.dataset.resizing
        p.grip.classList.remove('is-live')
        onResizeEnd?.(p.key, p.width)
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

  /* Opening/closing a pane animates the grid edge. Follow the actual host box
     through those frames instead of guessing where the CSS transition is. */
  const gripObserver = new ResizeObserver((entries) => {
    /* Only the hosts that actually moved. Placing all three on any one host's
       frame meant a rect read and a style write per panel per frame for the
       whole of the grid transition, two thirds of it about edges that had not
       gone anywhere. */
    for (const entry of entries) {
      const p = PANELS.find((panel) => panel.host === entry.target)
      if (p) placeGrip(p)
    }
  })
  for (const p of PANELS) gripObserver.observe(p.host)

  /* Opening a panel takes room from the ones already out, so the fit is redone
     whenever one of them opens or closes — wherever in the app that happened. */
  new MutationObserver(refitPanels).observe(el.app, {
    attributeFilter: ['data-sidebar', 'data-side', 'data-ai']
  })

  /** Widths as they were left, and kept legal when the window is smaller than
   *  the screen they were set on. */
  const restorePanelWidths = (cfg) => {
    for (const p of PANELS) setPanelWidth(p, Number(cfg[p.key]) || p.def)
  }

  return { restorePanelWidths }
}
