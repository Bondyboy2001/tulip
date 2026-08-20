// @ts-check
/**
 * The side pane: a second document, standing beside the one being written.
 *
 * Not a second editor. The pane renders a note the way an embed renders one —
 * the same live frame, repainted when the file changes on disk, with Edit
 * source for a quick correction — because the case a side-by-side serves is
 * reading one document while writing another: the paper being cited, the note
 * being translated from, the plan being carried out. A true split view would
 * mean two of everything the app deliberately keeps one of — the dirty flag,
 * the save loop, the outline, the view switch — and every one of those pairs
 * is a place for the two sides to disagree about what is on disk. A window
 * onto the vault costs none of that and answers the same need.
 *
 * One document at a time. Opening another replaces what is showing, the way
 * the main view does — the pane is a place, not a stack.
 *
 * Ways in: ⌥-click any wikilink, or Open to the side on a file row or a tab.
 */

import { renderTransclusion } from './transclude.js'
import { renderEmbed, destroyEmbeds } from './assets.js'
import { routeFragmentClick } from './links.js'

let deps = null
let showing = null          // the vault-relative path on show, or null

/** The path the pane is showing, or null — for the places that must follow a
 *  document when it moves or goes. */
export function sideDoc () { return showing }

export function initSidePane (d) {
  deps = d
  // Clicks routed the way every other rendered note routes them — the pane
  // stands beside the views, where neither one's own handler reaches.
  deps.el.body.addEventListener('click', (e) => routeFragmentClick(e, deps))
}

/* An embedded PDF holds a worker and a page observer; every view calls the
   shared teardown before discarding one, and so does the pane. Note frames
   need no call — the live set prunes disconnected frames on its next refresh. */
function clearBody () {
  destroyEmbeds(deps.el.body)
  deps.el.body.replaceChildren()
}

/**
 * Put a document in the pane, opening the pane if it is closed.
 * @param {string} path  vault-relative, a note or a PDF
 * @param {{persist?: boolean, keepScroll?: boolean}} o  `keepScroll` holds the
 *   reading position across a repaint, which replaces the content wholesale.
 */
export function openToSide (path, { persist = true, keepScroll = false } = {}) {
  if (!deps || !path) return
  const top = keepScroll ? deps.el.body.scrollTop : 0
  showing = path
  clearBody()

  const restore = () => { if (top) deps.el.body.scrollTop = top }
  if (deps.isPdf(path)) {
    deps.el.body.append(renderEmbed({ kind: 'pdf', path, label: deps.label(path) }, restore))
  } else {
    /* An empty chain, not the current note's: the pane does not stand inside
       any note, and the one document it must always be allowed to show is the
       very note being edited beside it. This is why the note branch does not
       go through renderEmbed, which starts the chain at the open note. */
    deps.el.body.append(renderTransclusion({ path, anchor: null }, restore, []))
  }

  deps.el.app.dataset.side = 'open'
  if (persist) deps.remember(path)
}

export function closeSidePane ({ persist = true } = {}) {
  if (!deps) return
  showing = null
  clearBody()
  deps.el.app.dataset.side = 'closed'
  if (persist) deps.remember(null)
}

/**
 * Repaint after the app's own save. Self-writes never reach the vault
 * watcher — that is what keeps embeds from re-rendering on every autosave —
 * so without this the pane would show the note as it was when it opened.
 * Only the note that was written, and only when it is the one on show:
 * a note *transcluded into* the shown one stays as it is until an external
 * change repaints every frame, the same bargain embeds already make.
 *
 * Held back a moment rather than done per save, so a spell of writing in the
 * note the pane happens to be showing repaints it once at the end instead of
 * re-reading and re-rendering the whole document at every pause in the typing.
 */
let repaintTimer = null
export function refreshSidePane (savedPath) {
  if (savedPath !== showing || deps.isPdf(showing)) return
  clearTimeout(repaintTimer)
  repaintTimer = setTimeout(() => {
    // Skip while its Edit source field is open — a repaint would discard it.
    if (savedPath !== showing) return
    if (deps.el.body.querySelector('.transclude.is-editing')) return
    openToSide(showing, { persist: false, keepScroll: true })
  }, 600)
}
