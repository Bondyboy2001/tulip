/* ============================================================= dropdown
   One menu for every choice in the app that opens.

   A native `<select>` draws its list with the operating system, not with the
   page: the popup arrived in the system font, at the system size, highlighted
   in the system's accent — a white-and-blue (or, here, a hot pink) slab in
   front of a dark, quiet window. Nothing in a stylesheet reaches it. So the
   list is drawn here instead, from the same tokens as the rest of the app, and
   the three places that used to hold a `<select>` share it.

   The menu is appended to `document.body` and positioned in viewport
   coordinates rather than parented to the control. Both of its homes clip:
   the settings pane scrolls, and the copilot popover sits above a composer
   with nowhere to spill. A layer over the whole window has neither problem —
   at the cost of having to close when anything underneath it moves, which is
   what the scroll and resize listeners below are for.
   ================================================================== */

import { el as node, svgIcon } from './dom.js'

const CARET = 'm4.6 6.3 3.4 3.4 3.4-3.4'
const TICK = 'm3.5 8.3 3 3 6-6.4'

/**
 * The one menu on screen at a time; opening a second closes the first.
 *
 * The window listeners are registered here, at import, rather than once per
 * control — and the registration order is load-bearing. The settings pane and
 * the copilot popover both take Escape on `document` in the capture phase
 * and both stop it; a listener added later would never see the key, and Escape
 * over an open menu would close the pane underneath it instead of the menu.
 * Imports run before either of them is mounted, so this one is first.
 *
 * Guarded on there being a document at all, because the modules that hold a
 * menu also hold the file formats — a notebook, a `.csv` — and the tests import
 * those under Node to read one, where nothing here has anything to listen to.
 *
 * @type {{close: (opts?: {focus?: boolean}) => void, place: () => void,
 *         keys: Record<string, () => void>, holds: (node: Node) => boolean} | null}
 */
let live = null

/* Coalesced onto a frame: `place` interleaves style writes with height reads,
   so each call is three forced reflows, and a scroll gesture delivers events
   faster than the page can be laid out. Once per frame is as often as the
   result could be seen anyway. */
let placing = 0

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (event) => {
    if (!live) return
    const run = live.keys[event.key]
    if (!run) return
    event.preventDefault()
    event.stopPropagation()
    run()
  }, true)

  document.addEventListener('click', () => live?.close())
  window.addEventListener('resize', () => live?.close())

  /* Scrolling moves the control the menu is hanging from, so the menu follows
     rather than closing: something else on the page scrolling — the copilot's
     own log settling as its panel opens — is not a reason to take the menu
     away. Capture, because the scroll that matters is the settings pane's own,
     and that one does not bubble.

     The menu's own scrolling is exempt, and that exemption is what makes a long
     list usable at all: `place` clears the height cap to measure, which for a
     list of several hundred momentarily makes the menu taller than its own
     scroller — and an element that no longer overflows has its scroll position
     reset to the top. Re-placing on every wheel tick therefore pinned the list
     to its first entry. */
  window.addEventListener('scroll', (event) => {
    if (!live) return
    if (event.target instanceof Node && live.holds(event.target)) return
    if (placing) return
    placing = requestAnimationFrame(() => { placing = 0; live?.place() })
  }, true)
}

const icon = (path, size) => svgIcon(`<path d="${path}"/>`, { size, stroke: 1.6 })

/* How many rows a list holds before the filter box appears above it. */
const FILTER_FROM = 12

/** Nothing matched, said the same way wherever a list can come up empty. */
export const NO_MATCH = 'Nothing matches that.'

/**
 * Every word typed has to appear somewhere in the text, in any order — so
 * "glm 5.2" finds `zai-coding-plan/glm-5.2` without knowing the provider.
 *
 * The query is split once and the predicate handed back, rather than re-split
 * per candidate: both callers run it across several hundred rows per keystroke.
 * An empty query matches everything, which `[].every` gives for free.
 */
export function matcher (query) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  return (text) => {
    const hay = String(text).toLowerCase()
    return words.every((word) => hay.includes(word))
  }
}

/**
 * A menu of named values.
 *
 * @param {object} [opts]
 * @param {any[]} [opts.options]
 *                  [{ value, label, icon }] — values are compared with ===, so
 *                  a numeric setting keeps its numbers and hands them back.
 *                  `icon` is a function returning a node, called afresh for the
 *                  button and for each row: one node cannot be in two places,
 *                  and the chosen option is drawn in both at once.
 * @param {any} [opts.value]
 *                  the one currently chosen
 * @param {(value: any) => void} [opts.onChange]
 *                  (value) => void, only for a value that is actually new
 * @param {string} [opts.label]
 *                  what the control is called, for a screen reader
 * @param {string} [opts.className]
 *                  extra classes for the button, for callers that size it
 * @param {boolean} [opts.search]
 *                  force the filter box on or off; by default it appears once
 *                  the list is longer than a screenful is worth scanning
 * @param {string} [opts.placeholder]
 *                  what the button says while nothing is chosen — and the
 *                  caller may hand `''` back as a choice, so a selection that
 *                  disappears can stay gone rather than turning into the first
 *                  entry. The empty string is the only value treated this way.
 * @param {() => void} [opts.onClose]
 *                  called once the menu has actually closed — Escape, an outside
 *                  click, or a pick. A caller that built the control around a
 *                  transient anchor (the embed picker stands on an invisible
 *                  button at the chip's position) takes it down here.
 * @param {() => void} [opts.onOpen]
 *                  called as the menu opens, for a list that costs something to
 *                  learn — the notebook's kernels are a question for a Jupyter
 *                  server that is not running until someone asks. It may fill
 *                  the list in later with `set`, which re-filters and re-places
 *                  a menu that is already up.
 *
 * @returns {{root: any, set: (next?: any, selected?: any) => any, value: () => any}} — `set` replaces the options and the choice at
 *          once, which is what a catalogue arriving late needs.
 */
export function dropdown ({ options = [], value, onChange, label, className = '', search = false, placeholder = '', onClose, onOpen } = {}) {
  let items = options
  /* What the menu is actually showing — `items` until something is typed. Every
     index below is into this, not into `items`, or picking the third row of a
     filtered list would choose the third model overall. Derived rather than
     stored, so no code path can forget to keep it in step. */
  let query = ''
  /* Memoised on the query and the list it filtered. Every caller of `shown`
     used to re-split the query and re-lowercase several hundred labels:
     `refilter` asks twice over and `place` a third time, and the arrow keys ask
     again for a list that has not changed at all. */
  /** @type {{query: string | null, items: any[] | null, list: any[] | null}} */
  let filtered = { query: null, items: null, list: null }
  const shown = () => {
    if (filtered.query === query && filtered.items === items) return /** @type {any[]} */ (filtered.list)
    const list = query ? items.filter(matching(matcher(query))) : items
    filtered = { query, items, list }
    return list
  }
  let chosen = value
  let at = 0

  const root = node('div', 'dd')
  const button = node('button', `dd-button ${className}`.trim())
  button.type = 'button'
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  if (label) button.setAttribute('aria-label', label)

  const text = node('span', 'dd-value')
  /* Whatever the chosen option draws in front of its name — a language's brand
     mark, for the notebook's kernels. Its own element rather than a child of
     `text`, which ellipsises. */
  const lead = node('span', 'dd-lead')
  button.append(lead, text, icon(CARET, 11))
  root.append(button)

  const menu = node('div', 'dd-menu')
  menu.setAttribute('role', 'listbox')
  if (label) menu.setAttribute('aria-label', label)
  menu.hidden = true

  /* The list is a layer of its own so the filter box can stay put while the
     options scroll under it — a search field that scrolls away is no use to a
     list long enough to need one. */
  const list = node('div', 'dd-list')
  const field = node('input', 'dd-search')
  field.type = 'text'
  field.spellcheck = false
  field.autocomplete = 'off'
  if (label) field.setAttribute('aria-label', `Filter ${label}`)

  const matching = (hit) => (item) => hit(item.label)
  const filtering = () => search || items.length > FILTER_FROM

  const itemOf = (v) => items.find((item) => item.value === v)
  const paintButton = () => {
    const item = itemOf(chosen)
    text.textContent = item?.label ?? placeholder
    button.classList.toggle('is-empty', !item)
    const drawn = item?.icon?.()
    lead.replaceChildren(...(drawn ? [drawn] : []))
  }

  function refilter () {
    at = Math.max(0, shown().findIndex((item) => item.value === chosen))
    paintMenu()
    place()
  }

  /* One listener on the container rather than two per row: a filtered list of
     four hundred was building eight hundred-odd listeners per keystroke and
     throwing them away on the next one. The row's index is on the node. */
  list.addEventListener('mouseenter', (event) => {
    const row = event.target.closest?.('.dd-option')
    if (row) { at = Number(row.dataset.at); markAt() }
  }, true)
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.dd-option')
    if (!row) return
    event.stopPropagation()
    pick(Number(row.dataset.at))
  })

  function paintMenu () {
    const visible = shown()
    list.replaceChildren(...visible.map((item, index) => {
      const row = node('button', 'dd-option')
      row.type = 'button'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(item.value === chosen))
      row.dataset.at = String(index)
      row.classList.toggle('is-at', index === at)
      const drawn = item.icon?.()
      row.append(icon(TICK, 13), ...(drawn ? [drawn] : []),
        node('span', 'dd-option-name', item.label))
      return row
    }))
    if (!visible.length) list.append(node('div', 'dd-empty', NO_MATCH))
    marked = list.children[at] || null
  }

  /* The highlight moves between two nodes rather than being re-toggled across
     every row — the arrow keys walk this one row at a time. */
  /** @type {Element | null} */
  let marked = null
  function markAt () {
    const row = list.children[at]
    if (row === marked) return
    marked?.classList.remove('is-at')
    row?.classList.add('is-at')
    marked = row || null
    row?.scrollIntoView({ block: 'nearest' })
  }

  field.addEventListener('input', () => { query = field.value; refilter() })

  /* The menu is as wide as the control and hangs below it, unless the window
     runs out first — then it hangs above, which is the whole reason this is
     measured rather than declared. */
  function place () {
    const box = button.getBoundingClientRect()
    // Lifting the cap below un-overflows the menu, and the browser zeroes the
    // scroll position of anything that no longer overflows. Kept and put back.
    const scrolled = menu.scrollTop
    menu.style.minWidth = `${Math.round(box.width)}px`
    menu.style.left = `${Math.round(box.left)}px`
    menu.style.top = '0px'
    menu.style.maxHeight = ''

    const room = { below: window.innerHeight - box.bottom - 12, above: box.top - 12 }
    const wanted = menu.offsetHeight
    const up = wanted > room.below && room.above > room.below
    menu.style.maxHeight = `${Math.max(120, Math.round(up ? room.above : room.below))}px`
    // Read back rather than reuse `wanted`: the cap above may have shortened it.
    menu.style.top = `${Math.round(up ? box.top - 6 - menu.offsetHeight : box.bottom + 6)}px`
    menu.scrollTop = scrolled

    // Nudge back inside if the control sits against the window's right edge.
    const over = menu.getBoundingClientRect().right - (window.innerWidth - 10)
    if (over > 0) menu.style.left = `${Math.round(box.left - over)}px`
  }

  /* Space and the two ends are only ours while nothing is being typed into:
     with the filter box focused they are a space, and the start and end of what
     has been typed so far. Enter still chooses, which is the whole point of
     typing three letters and pressing it. */
  const navigation = {
    Escape: () => close({ focus: true }),
    ArrowDown: () => { at = Math.min(shown().length - 1, at + 1); markAt() },
    ArrowUp: () => { at = Math.max(0, at - 1); markAt() },
    Enter: () => pick(at),
    Tab: () => close()
  }
  const keys = {
    ...navigation,
    Home: () => { at = 0; markAt() },
    End: () => { at = shown().length - 1; markAt() },
    ' ': () => pick(at)
  }

  function open () {
    live?.close()
    /* Before the list is measured, so a caller that already has the answer can
       hand it over synchronously and open at the right size; one that has to go
       and ask calls `set` when it comes back. */
    onOpen?.()
    query = ''
    field.value = ''
    at = Math.max(0, items.findIndex((item) => item.value === chosen))

    const wantsField = filtering()
    field.placeholder = `Filter ${items.length} …`
    menu.replaceChildren(...(wantsField ? [field, list] : [list]))
    paintMenu()

    document.body.append(menu)
    menu.hidden = false
    place()
    markAt()
    button.setAttribute('aria-expanded', 'true')
    // Focus goes to the box, so the list can be narrowed by typing the moment
    // it opens rather than after a click nobody would think to make.
    if (wantsField) field.focus()
    live = {
      close,
      place,
      keys: wantsField ? navigation : keys,
      holds: (node) => menu.contains(node)
    }
  }

  function close ({ focus = false } = {}) {
    if (menu.hidden) return
    menu.hidden = true
    menu.remove()
    button.setAttribute('aria-expanded', 'false')
    if (live?.close === close) live = null
    if (focus) button.focus()
    onClose?.()
  }

  const isOpen = () => !menu.hidden

  function pick (index) {
    const item = shown()[index]
    close({ focus: true })
    if (!item || item.value === chosen) return
    chosen = item.value
    paintButton()
    onChange?.(item.value)
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    isOpen() ? close() : open()
  })

  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      if (!isOpen()) { event.preventDefault(); open() }
    }
  })

  menu.addEventListener('click', (event) => event.stopPropagation())

  paintButton()

  return {
    root,
    /** Replace the list, the choice, or both. Silent — it reports nothing. */
    set (next, selected) {
      if (next) items = next
      // Explicitly, in case a caller hands back the same array with different
      // contents — identity alone would not tell the memo above anything moved.
      filtered = { query: null, items: null, list: null }
      if (arguments.length > 1) chosen = selected
      /* A selection that has become stale settles on the first entry — but an
         empty one stays empty. `''` is the caller's "nothing chosen" and a
         value to be painted as the placeholder, not a gap to paper over. */
      if (chosen !== '' && !items.some((item) => item.value === chosen)) chosen = items[0]?.value
      paintButton()
      // Whatever was typed still applies to the new list, so it is re-run
      // rather than dropped — a catalogue arriving mid-search must not clear it.
      if (isOpen()) refilter()
      return chosen
    },
    value: () => chosen
  }
}
