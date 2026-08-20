// @ts-check
/* One accessibility contract for the three collapsible columns. Grid geometry
 * decides what is visible; this module makes keyboard and assistive-technology
 * reachability agree with it. */

const SPECS = [
  ['sidebar', 'sidebar'],
  ['side', 'sidepane'],
  ['ai', 'aiPanel']
]

export function syncPanelAccessibility (app, panels) {
  for (const [state, key] of SPECS) {
    const panel = panels[key]
    if (!panel) continue
    const open = app.dataset[state] === 'open'
    if (!open && panel.contains(document.activeElement)) panels.returnFocus?.[key]?.focus?.()
    panel.toggleAttribute('inert', !open)
    panel.setAttribute('aria-hidden', String(!open))
  }
}

export function mountPanelAccessibility (app, panels) {
  const sync = () => syncPanelAccessibility(app, panels)
  const observer = new MutationObserver(sync)
  observer.observe(app, {
    attributes: true,
    attributeFilter: ['data-sidebar', 'data-side', 'data-ai']
  })
  sync()
  return { sync, destroy: () => observer.disconnect() }
}
