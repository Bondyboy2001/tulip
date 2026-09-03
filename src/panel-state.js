/* One accessibility contract for the three collapsible columns. Grid geometry
 * decides what is visible; this module makes keyboard and assistive-technology
 * reachability agree with it. */

const SPECS = [
  ['sidebar', 'sidebar'],
  ['side', 'sidepane'],
  ['ai', 'aiPanel']
]

/* How long a closing panel keeps its contents reachable — the length of the
   slide that is taking it off screen. Making a subtree inert is a restyle of
   the whole of it, and for the file tree that is thousands of rows; done on
   the frame the slide begins, it was the frame that stuttered. Opening is the
   other way round and is not deferred: focus is often sent into a panel the
   instant it is opened, and `.focus()` on an inert element does nothing. */
const CLOSE_SETTLE_MS = 300

function mountState (app, panels) {
  const timers = new Map()
  const apply = (panel, open) => {
    panel.toggleAttribute('inert', !open)
    panel.setAttribute('aria-hidden', String(!open))
  }
  return () => {
    for (const [state, key] of SPECS) {
      const panel = panels[key]
      if (!panel) continue
      const open = app.dataset[state] === 'open'
      clearTimeout(timers.get(key))
      timers.delete(key)
      // Focus leaves a closing panel now, whatever the slide is still showing.
      if (!open && panel.contains(document.activeElement)) panels.returnFocus?.[key]?.()
      if (open || panel.hasAttribute('inert')) { apply(panel, open); continue }
      timers.set(key, setTimeout(() => { timers.delete(key); apply(panel, false) }, CLOSE_SETTLE_MS))
    }
  }
}

export function mountPanelAccessibility (app, panels) {
  const sync = mountState(app, panels)
  const observer = new MutationObserver(sync)
  observer.observe(app, {
    attributes: true,
    attributeFilter: ['data-sidebar', 'data-side', 'data-ai']
  })
  sync()
}
