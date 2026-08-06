/**
 * The slash key: `/` at the start of a line makes an embed, not a menu.
 *
 * The old slash menu is gone. Typing `/` with nothing but whitespace before it
 * on the line no longer opens the completion tooltip — instead the slash
 * becomes an embed placeholder, a chip standing in the text where `![[ ]]` is
 * written. Clicking the chip opens the vault's own picker: a searchable list
 * of the things a note can embed — its attachments and its notes, with "add a
 * website" and "add a YouTube video" at the top — and choosing one writes the
 * `![[…]]` that names it.
 *
 * The same syntax is what autocomplete completes against. `![[` in the text
 * — written by hand, or left by the picker — answers keystrokes with an
 * inline ghost of the first matching name, greyed out right where the caret
 * is; Tab takes it. No tooltip, ever: the candidates live in the text itself,
 * and the grey suggestion is a decoration, never a word in the file.
 *
 * The trigger is deliberately narrow — a `/` with nothing but whitespace
 * before it on the line — so writing "and/or" or a file path never makes an
 * embed. That is also Obsidian's rule, so hands trained there already know it.
 * Raw view empties the whole extension with the rest of the live preview: the
 * file as it is on disk keeps its `/` and shows the `![[ ]]` as the markup it
 * is.
 */

import { EditorState, Facet, Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import { snippetCompletion } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { dropdown } from './dropdown.js'
import { el, svgIcon } from './dom.js'
import { CALLOUT_KINDS } from './callouts.js'
import { LANGUAGES } from './languages.js'

/* The text a slash leaves in the file, and what the chip stands in for. */
const PLACEHOLDER = '![[ ]]'
const PLACEHOLDER_RE = /!\[\[\s*\]\]/g

/* The picker's two URL actions, and the skeletons they leave the caret
   inside. Everything else in the picker is a file or a note, whose `![[…]]`
   is already its whole name. */
const URL_KINDS = {
  web: { label: 'Add website URL…', insert: '![[https://' },
  youtube: { label: 'Add YouTube video…', insert: '![[https://www.youtube.com/watch?v=' }
}

/** What the picker offers and the ghost completes against: `{ label, name }`
 *  rows for every attachment and note in the vault, handed in by the renderer
 *  and read back at pick/keystroke time so the list is always current. */
export const embedChoices = Facet.define({ combine: (v) => v[0] || (() => []) })

/* ------------------------------------------------------ the placeholder */

/**
 * The chip `![[ ]]` becomes. A button, so the click has a target: it opens the
 * embed picker, and nothing else — the editor never starts a selection under
 * it (mousedown is swallowed), and `ignoreEvent` keeps CodeMirror's own
 * handlers off it the same way it stays off the image controls.
 */
class EmbedPlaceholderWidget extends WidgetType {
  constructor (from, to) {
    super()
    this.from = from
    this.to = to
  }

  eq (other) { return this.from === other.from && this.to === other.to }

  toDOM (view) {
    const button = el('button', 'tk-embed-placeholder')
    button.type = 'button'
    button.title = 'Choose what to embed'
    button.setAttribute('aria-label', 'Choose what to embed')
    button.append(
      svgIcon('<path d="M7 2.5 3.5 6 7 9.5M9 2.5l3.5 3.5L9 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>', { size: 13 }),
      el('span', null, 'Embed'),
      svgIcon('<path d="m3.5 5.5 2.5 3 2.5-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>', { size: 11 })
    )
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      openEmbedPicker(view, this.from, this.to)
    })
    return button
  }

  ignoreEvent () { return true }
}

/* Every `![[ ]]` in the document, as [from, to] pairs. The guard is the same
   one `findEmbeds` uses — a line without `![` cannot hold an embed, and almost
   every line is exactly that. */
function placeholderRanges (doc) {
  const out = []
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (!line.text.includes('![')) continue
    for (const m of line.text.matchAll(PLACEHOLDER_RE)) {
      out.push([line.from + m.index, line.from + m.index + m[0].length])
    }
  }
  return out
}

const placeholderDeco = (doc) => {
  const ranges = placeholderRanges(doc)
  if (!ranges.length) return Decoration.none
  return Decoration.set(ranges.map(([from, to]) =>
    Decoration.replace({ widget: new EmbedPlaceholderWidget(from, to) }).range(from, to)), true)
}

/* The chip is a decoration of its own rather than a kind of embed, so the
   live preview does not have to know the placeholder exists: it skips an
   empty target (one line, in editor.js) and this field draws it. */
const placeholderField = ViewPlugin.fromClass(
  class {
    constructor (view) { this.decorations = placeholderDeco(view.state.doc) }
    update (update) {
      if (update.docChanged) this.decorations = placeholderDeco(update.state.doc)
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: () => EditorView.atomicRanges.of(
      (view) => view.plugin(placeholderField)?.decorations ?? Decoration.none)
  }
)

/* ------------------------------------------------------- the picker

   One dropdown, opened from the chip or from an image's change control. The
   menu is the app's own — the same component the language picker uses — not
   the completion tooltip, and it is the only thing that ever opens in this
   flow. */

export function openEmbedPicker (view, from, to) {
  const choices = view.state.facet(embedChoices)()
  const options = [
    { value: 'web', label: URL_KINDS.web.label },
    { value: 'youtube', label: URL_KINDS.youtube.label },
    ...choices.map((choice) => ({ value: `![[${choice.name}]]`, label: choice.label }))
  ]

  /* The menu hangs from a button. The button lives inside the dropdown's own
     root, so the root is positioned instead — fixed, at the chip's spot, and
     invisible; only the menu it opens is seen, and it comes down again when
     the menu closes. */
  const coords = (() => {
    const at = view.domAtPos(from)
    const rect = at?.node?.getBoundingClientRect?.()
    if (rect && (rect.width || rect.height)) return rect
    return view.coordsAtPos(from) || view.coordsAtPos(to) ||
      view.dom.getBoundingClientRect()
  })()

  const menu = dropdown({
    options,
    value: '',
    onChange: (value) => applyEmbed(view, from, to, value),
    label: 'Embed',
    /* The menu took focus to work in; the editor wants it back the moment
       the menu is done — after a pick the embed is already written and the
       caret is inside it. */
    onClose: () => {
      menu.root.remove()
      view.focus()
    }
  })
  menu.root.style.cssText =
    'position:fixed;opacity:0;pointer-events:none;z-index:-1'
  menu.root.style.left = `${Math.round(coords.left)}px`
  menu.root.style.top = `${Math.round(coords.top)}px`
  document.body.append(menu.root)
  const button = menu.root.querySelector('button')
  button?.focus()
  button?.click()
}

/** Write the chosen embed over `[from, to]`: a whole `![[…]]` for a file or
 *  note, or the skeleton of a URL with the caret waiting after the scheme. */
function applyEmbed (view, from, to, value) {
  const url = URL_KINDS[value]
  const insert = url ? url.insert : value
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.complete'
  })
  view.focus()
}

/* ------------------------------------------------------ the slash key

   A transaction filter, not a keymap: the keymap would have to guess at
   composition and paste, while the filter sees every typed character and can
   rewrite it before anything else reacts. Two rewrites:

   `/` alone at the start of a line becomes the placeholder — the menu it used
   to open is replaced by a thing in the text to click.

   The first letter typed right after a placeholder continues it: `![[ ]]` and
   then `d` is really `![[d`, the start of a target the ghost completes. So
   typing `/diagram` end to end just works. */

const slashFilter = EditorState.transactionFilter.of((tr) => {
  /* Typed keystrokes only — a paste or a programmatic change is the author's
     own text, not a slash gesture. And not composition events: an IME's
     intermediate keystrokes are `input.type.compose`, which `isUserEvent`
     also counts as `input.type`. */
  if (!tr.docChanged || !tr.isUserEvent('input.type') ||
      tr.isUserEvent('input.type.compose')) return tr

  const rewrites = []
  let caret = null
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.length !== 1) return
    const char = inserted.sliceString(0)
    const doc = tr.startState.doc

    /* A `/` with nothing but whitespace before it on the line. */
    if (char === '/') {
      const line = doc.lineAt(fromA)
      if (/\S/.test(doc.sliceString(line.from, fromA))) return
      if (inFence(tr.startState, fromA)) return
      rewrites.push({ from: fromA, to: toA, insert: PLACEHOLDER })
      caret = fromA + PLACEHOLDER.length
      return
    }

    /* A letter right after a placeholder keeps the embed going. */
    if (/[\p{L}\p{N}_./-]/u.test(char)) {
      const line = doc.lineAt(fromA)
      if (fromA - PLACEHOLDER.length >= line.from &&
          line.text.slice(fromA - PLACEHOLDER.length, fromA) === PLACEHOLDER) {
        rewrites.push({ from: fromA - PLACEHOLDER.length, to: toA, insert: `![[${char}` })
        caret = fromA - PLACEHOLDER.length + 4
      }
    }
  })

  if (!rewrites.length) return tr
  return {
    changes: rewrites,
    ...(caret != null ? { selection: { anchor: caret } } : {}),
    userEvent: 'input.type'
  }
})

/** Whether `pos` sits inside a fenced code block — a `/` or `![[` there is
 *  code, not an instruction to the editor. Same walk fenceLanguages makes. */
function inFence (state, pos) {
  const node = syntaxTree(state).resolveInner(pos, -1)
  for (let n = node; n; n = n.parent) {
    if (n.name === 'FencedCode') return true
  }
  return false
}

/** Backspace and Delete take the whole placeholder in one press, the way they
 *  take a whole word — a chip is not six characters of typing to unwind. */
const chipKeymap = Prec.highest(keymap.of([
  { key: 'Backspace', run: (view) => deleteChip(view, -1) },
  { key: 'Delete', run: (view) => deleteChip(view, 1) }
]))

function deleteChip (view, dir) {
  if (!view.state.selection.main.empty) return false
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const rel = head - line.from
  if (dir < 0 && rel >= PLACEHOLDER.length &&
      line.text.slice(rel - PLACEHOLDER.length, rel) === PLACEHOLDER) {
    view.dispatch({
      changes: { from: head - PLACEHOLDER.length, to: head },
      userEvent: 'delete'
    })
    return true
  }
  if (dir > 0 && rel + PLACEHOLDER.length <= line.text.length &&
      line.text.slice(rel, rel + PLACEHOLDER.length) === PLACEHOLDER) {
    view.dispatch({
      changes: { from: head, to: head + PLACEHOLDER.length },
      userEvent: 'delete'
    })
    return true
  }
  return false
}

/* -------------------------------------------------- inline autocomplete

   The ghost: when the caret sits at the end of an unclosed `![[` target, the
   first matching name is greyed in where the rest of it goes, and Tab writes
   it. A state field so the suggestion is a decoration — it never enters the
   document, and the moment the caret moves the field recomputes and it is
   gone. */

const ghostDismiss = StateEffect.define()

class GhostWidget extends WidgetType {
  constructor (text) { super(); this.text = text }
  eq (other) { return this.text === other.text }
  toDOM () { return el('span', 'tk-embed-ghost', this.text) }
  ignoreEvent () { return true }
}

/** The first candidate whose name continues `query`, and the text that would
 *  finish it. A query with a `/` in it addresses the full vault-relative path;
 *  a bare name matches any file of that name anywhere — the same two rules
 *  resolution uses, so what the ghost shows is what the note will resolve. */
function firstGhostMatch (choices, query) {
  const hasSlash = query.includes('/')
  const q = query.toLowerCase()
  for (const choice of choices) {
    const name = choice.name
    const hay = hasSlash ? name : name.split('/').pop()
    if (!hay.toLowerCase().startsWith(q)) continue
    return (hasSlash ? name : hay).slice(query.length) + ']]'
  }
  return null
}

function ghostFor (state, dismissed) {
  const selection = state.selection.main
  if (!selection.empty) return null
  const head = selection.head
  const line = state.doc.lineAt(head)
  const rel = head - line.from
  const text = line.text

  /* The caret must be at the end of an unclosed `![[target` — nothing after
     it on the line may belong to the embed, or the ghost would be completing
     into the middle of something already written. */
  const at = text.lastIndexOf('![[', rel)
  if (at === -1) return null
  const query = text.slice(at + 3, rel)
  if (!query || /[\]|]/.test(query)) return null
  if (query.includes('#')) return null
  if (/^https?:/i.test(query)) return null
  if (query === dismissed) return null
  if (inFence(state, head)) return null

  const insert = firstGhostMatch(state.facet(embedChoices)(), query)
  if (!insert) return null

  return { from: head, insert, dismissed: query }
}

const ghostField = StateField.define({
  create: (state) => ghost(state, null),
  update (value, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.some((e) => e.is(ghostDismiss))) {
      return value
    }
    let dismissed = value?.dismissed ?? null
    for (const effect of tr.effects) {
      if (effect.is(ghostDismiss)) dismissed = effect.value
    }
    return ghost(tr.state, dismissed)
  },
  provide: (field) => EditorView.decorations.from(
    field,
    (value) => value?.deco ?? Decoration.none)
})

function ghost (state, dismissed) {
  const found = ghostFor(state, dismissed)
  if (!found) return null
  return {
    ...found,
    deco: Decoration.set([
      Decoration.widget({ widget: new GhostWidget(found.insert), side: 1 }).range(found.from)
    ])
  }
}

/* Tab takes the ghost; Escape puts it away until the query changes. Both are
   no-ops without one, so they never stand in the way of the editor's own Tab
   and Escape. */
const ghostKeymap = Prec.high(keymap.of([
  {
    key: 'Tab',
    run: (view) => {
      const ghost = view.state.field(ghostField, false)
      if (!ghost?.insert) return false
      view.dispatch({
        changes: { from: ghost.from, insert: ghost.insert },
        selection: { anchor: ghost.from + ghost.insert.length },
        userEvent: 'input.complete'
      })
      return true
    }
  },
  {
    key: 'Escape',
    run: (view) => {
      const ghost = view.state.field(ghostField, false)
      if (!ghost) return false
      view.dispatch({ effects: ghostDismiss.of(ghost.dismissed) })
      return true
    }
  }
]))

/* The whole extension, mounted with the rest of the live preview so raw view
   (which empties that compartment) keeps the file exactly as it is on disk. */
export const slashEmbed = [
  placeholderField,
  slashFilter,
  chipKeymap,
  ghostField,
  ghostKeymap
]

/* ------------------------------------------------ fence languages

   One option per language the chip table knows, in the table's own order —
   common things first. The id is what gets inserted; the spelled-out name
   rides on the right. Aliases match invisibly, so `rs` finds Rust. */
const LANG_OPTIONS = LANGUAGES.map((entry) => ({
  completion: {
    label: entry.id,
    detail: entry.label.toLowerCase() === entry.id ? undefined : entry.label,
    type: 'constant'
  },
  haystack: `${entry.id} ${entry.label.toLowerCase()} ${(entry.alias || []).join(' ')}`
}))

/**
 * Completes the language name on an *opening* code fence — the word after
 * the ``` you are still typing. The closing fence must not offer one, which
 * is what the syntax-tree walk below decides: a cursor whose enclosing
 * fenced block began on an earlier line is closing that block, not opening
 * a new one.
 */
export function fenceLanguages (context) {
  const before = context.matchBefore(/```[\w+#-]*$/)
  if (!before) return null

  const line = context.state.doc.lineAt(before.from)
  if (/\S/.test(context.state.sliceDoc(line.from, before.from))) return null

  const node = syntaxTree(context.state).resolveInner(context.pos, -1)
  for (let n = node; n; n = n.parent) {
    if (n.name === 'FencedCode' && context.state.doc.lineAt(n.from).number !== line.number) return null
  }

  const query = before.text.slice(3).toLowerCase()
  /* Asked for by hand — the chip's language picker, or ⌃Space over a word
     that is already complete — the list is the whole catalogue: the word
     under the caret is what is being replaced, not a prefix being finished.
     Typing afterwards re-queries implicitly and narrows as usual. */
  const options = LANG_OPTIONS
    .filter((l) => context.explicit || !query || l.haystack.includes(query))
    .map((l) => l.completion)
  if (!options.length) return null

  // Only the token is replaced; the backticks stay exactly as typed.
  return { from: before.from + 3, options, filter: false }
}

/* -------------------------------------------------------- callout kinds */

/* The nested list: what `> [!` completes to. Each kind answers to its own
   name and to Obsidian's aliases for it, so `error` finds Danger and `tldr`
   finds Abstract — the same aliases the parser accepts. */
const KIND_OPTIONS = CALLOUT_KINDS.map((kind) => ({
  completion: snippetCompletion(`[!${kind.id}] \${Title}\n> \${}`, {
    label: kind.label,
    detail: `[!${kind.id}]`,
    type: 'keyword'
  }),
  haystack: `${kind.label} ${kind.id} ${(kind.alias || []).join(' ')}`.toLowerCase()
}))

/**
 * Completes the kind inside a callout's opening marker.
 *
 * Reached by typing `> [!` outright — the slash menu used to write the marker
 * for you, but the menu only offers embeds now, and the marker was always the
 * point: the completion sits on the syntax, not behind a command.
 */
export function calloutKinds (context) {
  const before = context.matchBefore(/\[!([\w-]*)/)
  if (!before) return null

  /* Only the marker that opens a blockquote, so a literal `[!` in prose or
     inside a link's brackets is left alone. Everything between the start of
     the line and the marker must be quote marks and space. */
  const line = context.state.doc.lineAt(before.from)
  const lead = context.state.sliceDoc(line.from, before.from)
  if (!/^[ \t]*(?:>[ \t]*)+$/.test(lead)) return null

  const query = before.text.slice(2).toLowerCase()
  const options = KIND_OPTIONS
    .filter((k) => !query || k.haystack.includes(query))
    .map((k) => k.completion)
  if (!options.length) return null

  // From the `[`, so the snippet writes the whole marker and its title.
  return { from: before.from, options, filter: false }
}
