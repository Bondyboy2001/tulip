/* ================================================================ find
   Find and replace, in the app's own controls rather than the library's.

   CodeMirror's stock panel is replaced wholesale — not for the look, which
   could have been restyled, but for the timing. The stock panel commits the
   query on `keyup` and then stops: nothing moves until Enter is pressed. The
   pause between typing a word and seeing where it is reads as the editor
   being slow, when in fact the editor was never asked to do anything. Here
   the first match is selected as the query is typed, the way the browser's
   own find does it, so there is nothing to wait for.

   Three things keep that from costing what it looks like it should:

     · the query and the jump to its first match travel in ONE transaction,
       so a keystroke redraws the document once rather than twice;
     · the match tally is counted on an animation frame, so a fast typist's
       run of keystrokes settles into a single count rather than one per
       character;
     · matches are scrolled to with `nearest`, so stepping through a run of
       them moves the page as little as it can get away with. Centring each
       one in turn is what makes stepping feel like being thrown around.

   The panel searches from where the cursor was when it opened, not from
   wherever the last keystroke left the selection. Without that, typing
   `t-h-e` walks forward through three different matches and the view lurches
   with every character.
   ================================================================== */

import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import {
  SearchQuery, getSearchQuery, setSearchQuery,
  findNext, findPrevious, selectMatches,
  replaceNext, replaceAll, closeSearchPanel
} from '@codemirror/search'
import { el } from './blocks.js'
import { chip, icon, tallyText, wrap } from './find-bar.js'

/* Counting stops here. A note with more matches than this does not need an
   exact number — it needs the readout to stay cheap on every keystroke. */
const LIMIT = 1000

/* Whether the replace row is showing. Deliberately module-level: within a
   session, opening find again should give you back the panel you were last
   using, and this is not worth writing to disk. */
let showReplace = false

/** How far a match is kept from the edge when it is scrolled to. */
const MARGIN = 64

const scrollTo = (range) => EditorView.scrollIntoView(range, { y: 'nearest', yMargin: MARGIN })

/**
 * The panel. One row for finding, a second for replacing that starts folded
 * away — ⌘F is overwhelmingly used to find rather than to replace, and the
 * fold is what keeps the common case down to a single line of controls.
 */
class FindPanel {
  constructor (view) {
    this.view = view
    this.frame = 0

    /* Where the search started. Reset whenever the cursor is moved by
       something other than the search itself. */
    this.origin = view.state.selection.main.from

    const q = getSearchQuery(view.state)

    this.input = el('input', 'find-input')
    this.input.placeholder = 'Find'
    this.input.value = q.search
    this.input.setAttribute('main-field', 'true')   // what the panel focuses on open
    this.input.setAttribute('aria-label', 'Find')

    this.tally = el('span', 'find-tally')
    this.tally.setAttribute('aria-live', 'polite')

    this.field = el('div', 'find-field')
    this.field.append(this.input, this.tally)

    this.replaceInput = el('input', 'find-input')
    this.replaceInput.placeholder = 'Replace'
    this.replaceInput.value = q.replace
    this.replaceInput.setAttribute('aria-label', 'Replace')

    const replaceField = el('div', 'find-field')
    replaceField.append(this.replaceInput)

    /* The options are buttons that look pressed rather than boxes that look
       ticked: three words of caption cost more room than the whole row of
       controls they qualify. The full name lives in the tooltip. */
    this.opts = {
      caseSensitive: this.chip('Aa', 'Match case', q.caseSensitive),
      regexp: this.chip('.*', 'Regular expression', q.regexp),
      wholeWord: this.chip('ab|', 'Whole word', q.wholeWord)
    }

    this.twist = this.icon('find-twist', '›', 'Replace')
    this.twist.setAttribute('aria-expanded', String(showReplace))
    this.twist.onclick = () => this.toggleReplace(!showReplace)

    const find = el('div', 'find-row')
    find.append(
      this.twist,
      this.field,
      wrap('find-chips', Object.values(this.opts)),
      this.icon('find-step', '↑', 'Previous match', () => findPrevious(view)),
      this.icon('find-step', '↓', 'Next match', () => findNext(view)),
      this.button('All', 'Select every match', () => selectMatches(view))
    )

    this.replaceRow = el('div', 'find-row is-replace')
    this.replaceRow.append(
      el('span', 'find-twist is-spacer'),               // holds the column under the twist
      replaceField,
      this.button('Replace', 'Replace this match', () => replaceNext(view)),
      this.button('Replace all', 'Replace every match', () => replaceAll(view))
    )
    this.replaceRow.hidden = !showReplace

    this.close = this.icon('find-close', '×', 'Close', () => closeSearchPanel(view))

    this.dom = el('div', 'find')
    this.dom.append(find, this.replaceRow, this.close)
    this.dom.onkeydown = (e) => this.keydown(e)

    /* `input` rather than `keyup`: a paste from the menu, a drag of text into
       the field and a dictated word all produce the first and none of them the
       second, and every one of those left the stock panel showing a query it
       was no longer searching for. */
    this.input.oninput = () => this.commit({ jump: true })
    this.replaceInput.oninput = () => this.commit({ jump: false })

    this.count()
  }

  /* ------------------------------------------------------------ pieces */

  /* Every control here hands the caret back to the query when it is done: the
     next thing you do after stepping or flipping a switch is almost always type
     more of what you are looking for. */
  chip (label, title, on) {
    return chip(label, title, on, () => { this.commit({ jump: true }); this.input.focus() })
  }

  icon (cls, glyph, title, onclick) {
    return icon(cls, glyph, title, onclick && (() => { onclick(); this.input.focus() }))
  }

  button (label, title, onclick) {
    const b = el('button', 'find-btn', label)
    b.type = 'button'
    b.title = title
    b.onclick = () => { onclick(); this.input.focus() }
    return b
  }

  toggleReplace (on) {
    showReplace = on
    this.replaceRow.hidden = !on
    this.twist.setAttribute('aria-expanded', String(on))
    ;(on ? this.replaceInput : this.input).focus()
  }

  /* ------------------------------------------------------------ the query */

  query () {
    const pressed = (b) => b.getAttribute('aria-pressed') === 'true'
    return new SearchQuery({
      search: this.input.value,
      replace: this.replaceInput.value,
      caseSensitive: pressed(this.opts.caseSensitive),
      regexp: pressed(this.opts.regexp),
      wholeWord: pressed(this.opts.wholeWord)
    })
  }

  /** The first match at or after `from`, or nothing. */
  firstFrom (q, from) {
    const hit = q.getCursor(this.view.state, from).next()
    return hit.done ? null : hit.value
  }

  /**
   * Hands the new query to the editor, and — while the query is being typed —
   * moves to the match it names.
   *
   * Both go in one transaction on purpose. Dispatched separately they are two
   * updates, and every decoration in the document is rebuilt for each.
   */
  commit ({ jump }) {
    const q = this.query()
    if (q.eq(getSearchQuery(this.view.state))) return

    const spec = { effects: [setSearchQuery.of(q)] }

    if (jump && q.valid) {
      // From where the search started, then from the top: a query that has no
      // match ahead of the cursor still has one behind it, and finding it is
      // what the wrap-around at the end of the document would have done.
      const hit = this.firstFrom(q, this.origin) || this.firstFrom(q, 0)
      if (hit) {
        spec.selection = EditorSelection.single(hit.from, hit.to)
        spec.effects.push(scrollTo(spec.selection.main))
        spec.userEvent = 'select.search'
      }
    }

    this.view.dispatch(spec)
  }

  /* ------------------------------------------------------------- the tally */

  /**
   * `3 / 47`, or as much of it as is true. The position is only shown when the
   * selection *is* one of the matches — after a plain click in the document it
   * is not, and claiming a position would be a lie about where you are.
   */
  count () {
    const q = getSearchQuery(this.view.state)
    const { state } = this.view

    this.field.classList.remove('is-bad')
    if (!this.input.value) { this.tally.textContent = ''; return }
    if (!q.valid) {
      // The only way a non-empty query is invalid is a regexp mid-typing.
      this.field.classList.add('is-bad')
      this.tally.textContent = '—'
      return
    }

    const sel = state.selection.main
    let total = 0
    let at = 0
    const cursor = q.getCursor(state)
    for (let hit = cursor.next(); !hit.done; hit = cursor.next()) {
      total++
      if (hit.value.from === sel.from && hit.value.to === sel.to) at = total
      if (total > LIMIT) break
    }

    this.tally.textContent = tallyText({ at, total, limit: LIMIT })
  }

  /* Counting is the one thing here that walks the whole note, so it is held to
     one run per frame however fast the keys arrive. */
  schedule () {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.count() })
  }

  /* ------------------------------------------------------------ the keys */

  keydown (e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearchPanel(this.view)          // hands focus back to the document
      return
    }
    if (e.key !== 'Enter') return

    if (e.target === this.replaceInput) {
      e.preventDefault()
      ;(e.metaKey || e.ctrlKey ? replaceAll : replaceNext)(this.view)
      return
    }
    if (e.target === this.input) {
      e.preventDefault()
      ;(e.shiftKey ? findPrevious : findNext)(this.view)
    }
  }

  /* ------------------------------------------------------------ the state */

  update (update) {
    const requeried = update.transactions.some((tr) =>
      tr.effects.some((eff) => eff.is(setSearchQuery)))

    /* ⌘F with the panel already open re-seeds the query from the selection,
       and a fresh note resets it. Either way the fields are no longer showing
       what is being searched for, so they are written back from the state. */
    if (requeried) {
      const q = getSearchQuery(update.state)
      if (q.search !== this.input.value) this.input.value = q.search
      if (q.replace !== this.replaceInput.value) this.replaceInput.value = q.replace
      this.opts.caseSensitive.setAttribute('aria-pressed', String(q.caseSensitive))
      this.opts.regexp.setAttribute('aria-pressed', String(q.regexp))
      this.opts.wholeWord.setAttribute('aria-pressed', String(q.wholeWord))
    }

    /* Moving the cursor by hand moves where the next typed character searches
       from. Moving it by searching does not, or the query would crawl down the
       note one character at a time as it was typed. */
    if (update.selectionSet &&
        !update.transactions.some((tr) => tr.isUserEvent('select.search'))) {
      this.origin = update.state.selection.main.from
    }

    if (requeried || update.docChanged || update.selectionSet) this.schedule()
  }

  destroy () {
    if (this.frame) cancelAnimationFrame(this.frame)
  }
}

/**
 * The search extension, configured for this app: our panel, and matches
 * scrolled to with as little movement as will show them.
 */
export const findConfig = {
  createPanel: (view) => new FindPanel(view),
  scrollToMatch: (range) => scrollTo(range)
}
