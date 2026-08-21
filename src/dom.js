/* ================================================================= dom
   The three things everything here builds pages out of: an element, an icon,
   and the escaper that lets note text be written into an HTML string.

   They lived in src/blocks.js, which is about what a fenced block becomes and
   the CodeMirror StateField boilerplate behind that. Fifteen modules imported
   them from there — the copilot panel, the find bar, the sidebar's file icons,
   the language chips, the keyboard, the callouts — none of which has anything
   to do with fences, and several of which have no business loading CodeMirror
   at all. src/headings.js is the case that made it plain: it is text scanning
   with one button in it, and rather than take that dependency it hand-wrote a
   copy of the very SVG `svgIcon` exists to own.

   Nothing here knows about the editor, the vault or the app's state, which is
   what makes it safe for any module to reach for.
   ================================================================== */

/** An element, with its class and its text — the shape all of this is built from. */
export function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Every icon this module has already built, by the description it was built
 * from. Setting `innerHTML` on an SVG runs the HTML parser, which is by far
 * the most expensive thing here — and the app draws the *same* handful of
 * shapes over and over: two buttons on each of a long note's fenced blocks,
 * a brand mark on each of them, a twist and a file kind on each sidebar row.
 * Parsed once each, then cloned, which copies already-built nodes.
 *
 * Sound because the arguments are the whole of what an icon is: two calls with
 * the same description would have produced identical elements. Every caller
 * appends what it gets and none of them mutates it, so a clone is not merely
 * equivalent — it is the same element they would have received.
 *
 * Bounded without needing to be: `markup` is a constant in this repo at every
 * call site. The one route that looks like note text — a fence naming an
 * unknown language — stops at `logoSvg`, which answers `null` for anything
 * outside its own fixed table before it ever reaches here. Keep it that way: a
 * caller that passed note text as `markup` would be a cache with no bound.
 */
const iconTemplates = new Map()

/**
 * An inline icon.
 *
 * Six places drew one before this, and each spelled out the namespace, the
 * viewBox, the aria-hidden and — for the outlined ones — the same five stroke
 * attributes. `stroke` asks for the outlined preset at a given width; `fill`
 * for the solid one.
 *
 * @param {string} markup
 * @param {{ viewBox?: string, className?: string, size?: number | null,
 *           stroke?: number | null, fill?: string | null }} [options]
 */
export function svgIcon (markup, {
  viewBox = '0 0 16 16',
  className = '',
  size = null,
  stroke = null,
  fill = null
} = {}) {
  const key = viewBox + '|' + className + '|' + size + '|' + stroke + '|' + fill + '|' + markup
  const cached = iconTemplates.get(key)
  if (cached) return cached.cloneNode(true)

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  if (className) svg.setAttribute('class', className)
  if (size != null) {
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
  }
  if (stroke != null) {
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', String(stroke))
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
  } else if (fill) {
    svg.setAttribute('fill', fill)
  }
  svg.innerHTML = markup
  iconTemplates.set(key, svg)
  return svg.cloneNode(true)
}

/* The five characters that stop note text being read as markup. Here rather
   than beside either of the two modules that write untrusted text into an HTML
   string, because a second copy of an escaper is a copy that gets fixed once. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Note text, safe to put in either an element body or a quoted attribute. */
export function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/* ------------------------------------------------------------- failures

   An `invoke` that throws reaches the renderer wrapped in Electron's own
   framing — "Error invoking remote method 'file:write': Error: …" — and if the
   handler threw a system error the sentence inside that framing is an errno
   line naming a path the reader never chose: "EACCES: permission denied, open
   '/Users/…/vault/.tulip-tmp-x9'". Neither half is a thing to put in front of
   somebody whose note would not save.

   So a message survives only if a handler in this app wrote it deliberately.
   Machine text is traded for the sentence the call site already had ready,
   which is the one that knows what was being attempted.
   ================================================================== */

/* What the common errnos mean to someone who was trying to save a file. The
   path is deliberately dropped: it is nearly always a temp file the writer
   made, so naming it explains nothing and reads as a leak. */
const ERRNO = {
  EACCES: 'Permission was refused.',
  EPERM: 'Permission was refused.',
  EROFS: 'That location is read-only.',
  ENOSPC: 'The disk is full.',
  EDQUOT: 'The disk quota is full.',
  ENOENT: 'That file is no longer there.',
  EEXIST: 'Something is already there by that name.',
  ENOTEMPTY: 'That folder is not empty.',
  EBUSY: 'That file is in use by another program.',
  EISDIR: 'That is a folder, not a file.',
  ENOTDIR: 'Part of that path is not a folder.',
  ENAMETOOLONG: 'That name is too long.',
  EMFILE: 'Too many files are open at once.',
  ENFILE: 'Too many files are open at once.',
  EXDEV: 'That move crosses disks and has to be a copy.',
  ETIMEDOUT: 'That took too long and was given up on.',
  ECONNREFUSED: 'The connection was refused.'
}

/**
 * The sentence to show for a failure, given what the call site would say.
 *
 * @param {unknown} err        whatever was thrown or rejected with
 * @param {string} [fallback]  the caller's own account of what failed
 * @returns {string}
 */
export function reason (err, fallback = 'Something went wrong.') {
  const said = typeof err === 'object' && err !== null && 'message' in err
    ? err.message
    : undefined
  const raw = String(said ?? err ?? '').trim()
  /* Electron nests its framing before the handler's own text, so the LAST
     "Error: " is where what the handler actually said begins. */
  const at = raw.lastIndexOf('Error: ')
  const text = (at === -1 ? raw : raw.slice(at + 'Error: '.length)).trim()
  if (!text) return fallback
  /* An errno line — `EACCES: permission denied, open '/…'` — is machine text
     with a path in it, so what shows is the caller's sentence and, when the
     code is one this knows, a plain account of it. Errno-shaped only: any
     capitalised word will do as the start of a deliberate message ("PDF: this
     document is encrypted."), and throwing those away left the reader with the
     bare fallback and none of the explanation the handler wrote. */
  const errno = /^(E[A-Z]{2,}):/.exec(text)
  if (errno) return ERRNO[errno[1]] ? `${fallback} ${ERRNO[errno[1]]}` : fallback
  /* A bare error class with nothing said in it — "TypeError", "[object
     Object]" — is framing too, just less obviously. */
  if (/^[A-Za-z]*Error$/.test(text) || text === '[object Object]') return fallback
  return text
}

/* ------------------------------------------------------------ focus trap

   Five panels in this app say `aria-modal="true"` — the quick switcher, the
   study box, Settings, the confirm dialog and the orphan list — and saying it
   is all any of them did. Tab walked straight out of the overlay and into the
   note behind it, which a mouse cannot even see: the reader was typing into a
   document that was not on screen.

   One trap for all of them rather than five wirings, keyed off the attribute
   they already carry. A panel added later is covered by having said the same
   thing every other panel says.
   ================================================================== */

const FOCUSABLE = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  '[tabindex]', '[contenteditable="true"]'
].join(',')

/** The things inside `root` that Tab can reach, in the order it reaches them. */
function focusableWithin (root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((node) => {
    if (node.disabled || node.getAttribute('tabindex') === '-1') return false
    if (node.closest('[hidden]')) return false
    // `offsetParent` is null for anything display:none, which is how every
    // panel here hides the halves of itself it is not showing.
    /* Bounded by what a dialog holds: the focusable controls of ONE modal, tens
       of nodes chosen by whoever wrote that dialog. The count cannot grow with
       the document, which is the bound the rule below is really about. */
    // eslint-disable-next-line tulip/no-layout-thrash
    return node.offsetParent !== null || node === document.activeElement
  })
}

/**
 * The modal currently on screen, if any — the last one, so a dialog raised
 * from another dialog holds the focus rather than the one underneath it.
 */
function topModal () {
  const open = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[aria-modal="true"]')])
    /* A fixed handful of dialogs exist and at most a couple are ever mounted at
       once: a constant, not a collection. */
    // eslint-disable-next-line tulip/no-layout-thrash
    .filter((node) => node.offsetParent !== null)
  return open[open.length - 1] || null
}

/**
 * Hide the page behind an open modal from assistive technology.
 *
 * The Tab trap above stops the keyboard leaving the dialog, which is only half
 * of what `aria-modal` promises. A screen reader's own cursor does not move by
 * Tab: it walks the accessibility tree, and the note, the sidebar and the tab
 * strip were all still in it — so the reader could read straight through a
 * dialog asking them a question, with no sign it was there.
 *
 * `inert` rather than `aria-hidden` alone: it takes the background out of the
 * tree AND makes it unclickable, which is what a modal already means.
 *
 * @param {Element} background  everything that is not the dialogs — the app
 *                              shell. The modals must not live inside it.
 */
export function guardModalBackground (background) {
  if (!background) return
  const modals = [...document.querySelectorAll('[aria-modal="true"]')]
  if (!modals.length) return

  const sync = () => {
    /* `hidden` rather than a layout read: these dialogs are shown and hidden by
       that attribute, and asking for geometry here would run on every open and
       close of every one of them.

       On an ancestor, though, not on the dialog itself — every one of them is
       wrapped in a backdrop element, and it is the backdrop that carries the
       attribute. Testing the dialog alone found them all permanently open. */
    /* A dialog that has put its own `aria-modal` down is not asking for any of
       this: the theme picker sits in the corner over a page it is previewing,
       and the page has to stay live under it — readable, clickable, scrollable.
       Read at sync time rather than filtered once at registration, because it
       is the same panel that is modal as the quick switcher and not modal as
       the theme picker. */
    const anyOpen = modals.some((node) =>
      node.getAttribute('aria-modal') === 'true' && !node.closest('[hidden]'))
    background.toggleAttribute('inert', anyOpen)
    background.setAttribute('aria-hidden', String(anyOpen))
  }

  const observer = new MutationObserver(sync)
  /* The dialog and everything it hangs from, since any of them could be the one
     that is toggled. A handful of nodes each, watched for one attribute. */
  for (const modal of modals) {
    for (let node = /** @type {Element | null} */ (modal); node && node !== document.body; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ['hidden', 'aria-modal'] })
    }
  }
  sync()
}

/**
 * Keep Tab inside whichever modal is open. Registered once, in the capture
 * phase so it settles the question before anything else answers it.
 */
export function trapModalFocus (target = window) {
  target.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    const modal = topModal()
    if (!modal) return
    const items = focusableWithin(modal)
    if (!items.length) return

    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    /* Focus that has already escaped — or never arrived, which is what an
       overlay opened by a click leaves behind — comes back to the near end. */
    if (!modal.contains(active)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
      return
    }
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
  }, true)
}
