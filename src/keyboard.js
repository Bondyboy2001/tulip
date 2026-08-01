/* ====================================================== language keyboard
   A strip of the letters a language has and a US keyboard does not, docked
   under the table so they can be typed without leaving it.

   It is a typing aid, not an input method. Someone studying a language
   seriously should add its real layout in System Settings and switch with
   ⌃Space — that muscle memory transfers to every other app, and this does not.
   What this is for is the letter you need once in a row of English: the ñ in
   señor, the ř you cannot find, a script you do not want a whole layout for.

   There is nothing to set up. A language folder already carries a flag and a
   name, and keysFor in the renderer turns those into a row of letters — so a
   language created a minute ago is typable a minute ago.

   A key in a script that is not Latin carries what it sounds like underneath
   it, because a row of unfamiliar shapes is not something you can pick from:
   you know you want the "th" sound long before you know that θ is the one that
   makes it.
   ================================================================== */

import { el } from './blocks.js'

/* How many keys answer to a shortcut. Nine because ⌥0 is not a tenth of
   anything, and past nine the strip is quicker to look at than to remember. */
const SHORTCUTS = 9

/** The table cell the caret is in, or null when it is anywhere else. */
function focusedCell () {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !active.isContentEditable) return null
  return active.closest('.tk-table') ? active : null
}

/**
 * One key, from its entry in the alphabet table: `θ:th` is the letter and what
 * it sounds like, a bare `ñ` is a letter that needs no gloss.
 *
 * `upper` is null when the letter has no capital — every letter of Hebrew,
 * Arabic, Thai, kana and jamo, and punctuation like ¿ in any script. Those keys
 * are left alone by Shift rather than being redrawn as themselves.
 */
function parseKey (token) {
  const at = token.indexOf(':')
  const key = at === -1 ? token : token.slice(0, at)

  /* A digraph is one letter to the language that uses it, and its capital is
     `Ll`, not `LL` — shouting it is what a naive toUpperCase does. And a letter
     whose capital is a different number of characters has no capital worth
     putting on a key: ß uppercases to SS, which is a spelling rule rather than
     a keystroke. */
  const raised = key.length > 1
    ? key[0].toUpperCase() + key.slice(1)
    : key.toUpperCase()

  return {
    key,
    hint: at === -1 ? '' : token.slice(at + 1),
    upper: raised === key || raised.length !== key.length ? null : raised
  }
}

/**
 * The strip.
 *
 * @param {{root: HTMLElement, keys: HTMLElement}} dom  the dock and the row in it
 * @returns {{setKeys: (tokens: string[]) => void, show: (on: boolean) => void}}
 */
export function mountKeyboard (dom) {
  /* The keys as data, and the buttons drawn from them. Indexed here rather than
     read back off the DOM: the Shift key sits in the same row, so the nth
     button and the nth letter are not the same thing. */
  let entries = []

  /* Shift, in its two forms. `locked` is the on-screen key, which stays down
     until pressed again — a mouse cannot hold a modifier while it clicks. `held`
     is the real Shift key, which does exactly what it does on a keyboard. Either
     one capitalises; the strip shows whichever case would be typed. */
  let locked = false
  let held = false
  const upper = () => locked !== held

  /* The cell the caret was last in. Clicking a key cannot take the focus — see
     the mousedown below — but a click anywhere else can, and coming back to the
     window at all can, so the strip remembers where it was last useful and puts
     the caret back rather than doing nothing. */
  let lastCell = null

  document.addEventListener('focusin', () => {
    const cell = focusedCell()
    if (cell) lastCell = cell
  })

  /**
   * Types one key.
   *
   * execCommand rather than rewriting the cell's text: it inserts at the caret,
   * replaces a selection the way typing does, joins the browser's own undo
   * stack, and — the part that matters here — raises `input`, which is what the
   * cell's own listener uses to write the change back to the document. Setting
   * textContent would do none of the four.
   */
  function type (entry, capital) {
    let cell = focusedCell()
    if (!cell && lastCell?.isConnected) {
      // Focusing is what swaps a cell to its source and puts the caret in it;
      // the cell's own focus handler does that synchronously, so by the next
      // line there is somewhere for the letter to go.
      lastCell.focus()
      cell = focusedCell()
    }
    if (!cell) return
    document.execCommand('insertText', false, (capital && entry.upper) || entry.key)
  }

  /** The face of every key, for the case that would be typed right now. */
  function paintCase () {
    const capital = upper()
    dom.shift.classList.toggle('is-on', capital)
    dom.shift.setAttribute('aria-pressed', String(capital))
    for (const button of dom.keys.querySelectorAll('.lang-key-face')) {
      const entry = entries[Number(button.parentElement.dataset.at)]
      button.textContent = (capital && entry.upper) || entry.key
    }
  }

  function setKeys (tokens) {
    entries = tokens.map(parseKey)
    dom.keys.replaceChildren()

    for (const [at, entry] of entries.entries()) {
      const button = el('button', 'lang-key')
      button.type = 'button'
      button.dataset.at = String(at)
      button.title = at < SHORTCUTS ? `⌥${at + 1}  ·  ⇧⌥${at + 1} for capital` : ''

      button.append(el('span', 'lang-key-face', entry.key))
      // The gloss is decoration for a reader and noise for a screen reader, so
      // it is hidden from one and the button is named for the other.
      if (entry.hint) {
        const hint = el('span', 'lang-key-hint', entry.hint)
        hint.setAttribute('aria-hidden', 'true')
        button.append(hint)
      }
      button.setAttribute('aria-label',
        entry.hint ? `Type ${entry.key}, sounds like ${entry.hint}` : `Type ${entry.key}`)

      dom.keys.append(button)
    }

    paintCase()
  }

  /* One listener for the row rather than two for every key: a strip of kana is
     fifty buttons, and fifty pairs of closures are rebuilt every time the
     language changes. The button carries its index, so the handler needs
     nothing captured. */
  const entryFor = (event) => {
    const button = event.target.closest?.('.lang-key')
    return button ? entries[Number(button.dataset.at)] : null
  }

  /* The whole point is that the caret does not move. A button takes focus on
     mousedown, and a cell that has lost focus has already written itself back
     and swapped out of source mode — so the key would land in nothing. Refused
     here rather than restored afterwards. */
  dom.root.addEventListener('mousedown', (event) => event.preventDefault())

  dom.keys.addEventListener('click', (event) => {
    const entry = entryFor(event)
    // Shift-clicking capitalises whatever the strip is currently showing, the
    // way it would in any other text field.
    if (entry) type(entry, upper() || event.shiftKey)
  })

  dom.shift.addEventListener('click', () => {
    locked = !locked
    paintCase()
  })

  /* The real Shift key drives the strip while it is down, so the letters on
     screen are the letters that would be typed. Watched only while the strip is
     on screen, and reset on blur — a window switched away from mid-chord would
     otherwise come back stuck in capitals. */
  window.addEventListener('keydown', (event) => {
    if (dom.root.hidden || event.key !== 'Shift' || held) return
    held = true
    paintCase()
  })

  const release = () => {
    if (!held) return
    held = false
    paintCase()
  }
  window.addEventListener('keyup', (event) => { if (event.key === 'Shift') release() })
  window.addEventListener('blur', release)

  /* ⌥ and a digit, read as a position on the strip rather than as the character
     the key produces: ⌥1 on a US layout is ¡, which is itself a Spanish letter,
     and matching on the character would make the shortcut mean two things. */
  window.addEventListener('keydown', (event) => {
    if (dom.root.hidden || !event.altKey || event.metaKey || event.ctrlKey) return
    const digit = /^Digit([1-9])$/.exec(event.code)
    if (!digit) return

    const entry = entries[Number(digit[1]) - 1]
    if (!entry) return
    event.preventDefault()
    type(entry, event.shiftKey)
  })

  return {
    setKeys,
    show (on) {
      dom.root.hidden = !on
      // A strip that goes away with Shift down must not come back holding it.
      if (!on) release()
    }
  }
}
