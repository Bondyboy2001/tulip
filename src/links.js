/**
 * What a click on a rendered note means.
 *
 * A note is rendered in five places — the reading view, the hover popover, the
 * side pane, an embed inside the editor, and the copilot's transcript — and a
 * link in one has to behave as it does in the others. Written out five times it
 * did not: one copy learned `mailto:`, one forgot the guard for a bare `#`, and
 * the copies that grew from the popover's never picked up the callout fold. So
 * the rule lives here, once, and each surface calls it after whatever cases are
 * its own.
 *
 * The rule for an `<a href>`: a bare `#anchor` is an in-page jump — footnotes
 * are built on it — and keeps its default. Everything else is taken over. The
 * schemes prose actually links to go to the browser; anything else is swallowed,
 * because the alternative is the click navigating the app itself, away from the
 * one page it is meant to be. That is a convenience, not the defence: the main
 * process refuses a top-level navigation outright (see the `will-navigate` guard
 * in electron/main.js), and this only means a reader never sees it try.
 */

/** Schemes a link written in a note may send you to. */
export const EXTERNAL_SCHEME = /^(?:https?|mailto):/i

/** How long the wash over a jumped-to target stays up: long enough to catch
 * the eye once the scroll has settled, short enough not to become part of the
 * page. */
const FLASH_MS = 1500

/* Timers by element, so a second click on the same reference restarts the
   wash rather than inheriting the first one's remaining time. */
const flashing = new WeakMap()

/**
 * Say where a jump landed.
 *
 * A reference — an equation's `(3)`, a footnote's marker, a citation — moves
 * the page to somewhere that looks like everywhere else on it, and the reader
 * is left hunting for the line that answered them. A wash of the accent colour
 * over the destination, fading as they find it, is the whole of the answer.
 */
export function flashTarget (target) {
  if (!(target instanceof HTMLElement)) return
  /* Taken off and put back rather than simply added: an animation already
     running ignores a class the element already has, so clicking the same
     reference twice would flash once. Reading a layout property in between is
     what makes the browser treat it as a new animation. */
  target.classList.remove('is-flash-target')
  void target.offsetWidth
  target.classList.add('is-flash-target')

  clearTimeout(flashing.get(target))
  flashing.set(target, setTimeout(() => {
    target.classList.remove('is-flash-target')
    flashing.delete(target)
  }, FLASH_MS))
}

/**
 * The in-page jump, taken over from the browser so it can be seen.
 *
 * The destination is looked for outwards from the link rather than in the
 * document: the same note is rendered in several places at once — a
 * transclusion inside another note, a side pane beside it — and `\eqref{clt}`
 * inside one of them means *that* copy's equation, not whichever copy happens
 * to hold the id the document finds first.
 *
 * @returns {boolean} whether the click was taken
 */
export function revealAnchorTarget (event) {
  const anchor = event.target.closest?.('a[href^="#"]')
  const href = anchor?.getAttribute('href') || ''
  // A bare `#` is a link to nowhere — the placeholder href of something that
  // does its work in JavaScript.
  if (href.length < 2) return false

  let id
  try { id = decodeURIComponent(href.slice(1)) } catch { id = href.slice(1) }
  const selector = `[id="${CSS.escape(id)}"]`
  let target = null
  for (let scope = anchor.parentElement; scope && !target; scope = scope.parentElement) {
    target = scope.querySelector(selector)
  }
  if (!target) return false

  event.preventDefault()
  // Centred, not scrolled-to-the-top: a reference is read against what is
  // around it, and the browser's own jump hides the lines above the target.
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flashTarget(target)
  return true
}

/**
 * A plain anchor, wherever one is clicked.
 * @returns {boolean} whether the click was taken
 */
export function routeAnchor (event, openExternal) {
  const anchor = event.target.closest?.('a[href]')
  if (!anchor) return false
  const href = anchor.getAttribute('href') || '#'
  if (href.startsWith('#')) return false
  event.preventDefault()
  if (EXTERNAL_SCHEME.test(href)) {
    openExternal(href)
    return true
  }
  // Swallowed: a relative path, or a scheme the sanitiser admits for assets
  // but not for going somewhere.
  return false
}

/**
 * The whole of what a click means inside a rendered fragment — the popover and
 * the side pane, which hold nothing but a note. Surfaces with cases of their
 * own (a callout to fold, a checkbox to tick) run those first and then call
 * this.
 *
 * `after` is what the surface does once a click has taken it somewhere else —
 * the popover dismisses itself. It is not called when a link is swallowed,
 * since nothing moved.
 *
 * @returns {boolean} whether the click was taken
 */
export function routeFragmentClick (event, { openWikilink, openAsset, openExternal, after = () => {} }) {
  const wiki = event.target.closest('[data-wikilink]')
  if (wiki) {
    event.preventDefault()
    /* ⌘ opens it in a tab of its own, ⌥ in the side pane — beside what is
       being written rather than over it. */
    openWikilink(wiki.dataset.wikilink, {
      newTab: event.metaKey || event.ctrlKey,
      side: event.altKey
    })
    after()
    return true
  }

  const asset = event.target.closest('[data-asset]')
  if (asset) {
    event.preventDefault()
    openAsset(asset.dataset.asset)
    after()
    return true
  }

  /* Before `routeAnchor`, and without `after`: an in-page jump has not taken
     the reader anywhere else, so the surface that dismisses itself on
     navigation — the popover — should stay exactly where it is. */
  if (revealAnchorTarget(event)) return true

  if (routeAnchor(event, openExternal)) { after(); return true }
  return false
}
