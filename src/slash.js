/**
 * The slash key: type `/` at the start of a line and keep typing to filter.
 *
 * `/` opens the completion tooltip — the same one the `[[` note list uses —
 * with one row per thing worth inserting, and every letter after the slash
 * narrows it. `/tab` finds Table, `/img` finds Image or file, `/warn` finds
 * Callout. Choosing a row replaces the `/` and what was typed after it: the
 * slash was an instruction to the editor, never text for the note.
 *
 * Two of those rows lead somewhere rather than writing markup. Image or file
 * opens the vault's own picker — a searchable list of the note's attachments
 * and notes — and Callout writes `> [!` and opens the kind list against it.
 *
 * `![[` in the text — written by hand, or left by the picker — answers
 * keystrokes with an inline ghost of the first matching name, greyed out right
 * where the caret is; Tab takes it. That one is a decoration, never a word in
 * the file, and never a tooltip.
 *
 * The trigger is deliberately narrow — a `/` with nothing but whitespace
 * before it on the line — so writing "and/or" or a file path never opens the
 * menu. That is also Obsidian's rule, so hands trained there already know it.
 */

import { Facet, Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import { snippetCompletion, startCompletion } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { dropdown } from './dropdown.js'
import { el, svgIcon } from './dom.js'
import { CALLOUT_KINDS } from './callouts.js'
import { LANGUAGES } from './languages.js'
import { insertTable } from './table.js'

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

/* ------------------------------------------------------ the slash menu

   A completion source rather than a popup of its own, so it gets CodeMirror's
   keyboard handling and tooltip for free, and sits beside the `[[` note
   completion in the same autocompletion() config. Templates are snippets: the
   cursor lands in the first blank, and Tab walks the rest.

   Filtering is this module's own (label + hidden aliases, so `/img` finds
   Image and `/error` finds Callout), which is why the result says
   `filter: false`: CodeMirror's matcher would otherwise re-filter against the
   text from `from` — which includes the `/` — and match nothing. */

/* The groups, in the order the menu shows them; within a group, commands stay
   in the order written here. */
const BLOCKS = { name: 'Blocks', rank: 0 }
const EMBEDS = { name: 'Embeds', rank: 1 }

/** One command: what the menu shows, what it answers to, what it inserts.
 *
 * No detail column. Every row used to carry its own syntax on the right —
 * ``` beside "Code block", `![[…]]` beside "Image or file" — which is the one
 * thing a reader of this menu has already said they do not want to remember.
 * The label is the whole row. */
function command (label, aliases, section, template) {
  const completion = snippetCompletion(template, { label, section, type: 'keyword' })
  return { completion, haystack: `${label} ${aliases.join(' ')}`.toLowerCase() }
}

/** A command that does something to the view instead of writing a template.
 *  The slash and whatever was typed after it go first, so the action starts
 *  from a line with nothing on it. */
function action (label, aliases, section, run) {
  return {
    completion: {
      label,
      section,
      type: 'keyword',
      apply: (view, _completion, from, to) => {
        view.dispatch({ changes: { from, to, insert: '' }, userEvent: 'input.complete' })
        run(view, from)
      }
    },
    haystack: `${label} ${aliases.join(' ')}`.toLowerCase()
  }
}

/* Deliberately short — blocks with syntax worth not remembering, and the two
   things that are more than syntax: a table, which is a grid rather than four
   lines of pipes, and the note's properties, which go at the top of the file
   however far down the `/` was typed. Headings, lists and quotes are quicker
   to just type than to pick from a menu. */
const COMMANDS = [
  command('Code block', ['fence', 'snippet', 'source', 'run'], BLOCKS,
    '```${language}\n${}\n```'),

  /* A table is made the way ⌘⌥T makes one. Not a snippet: written as text it
     would be four lines of pipes for the writer to line up by hand, and the
     editor draws a grid over them the moment they are there. */
  action('Table', ['grid', 'rows', 'columns', 'spreadsheet', 'csv'], BLOCKS,
    (view) => insertTable(view)),

  /* One entry for all thirteen kinds: thirteen rows differed only in a word,
     and the writer still had to read them all. This writes `> [!` and opens
     the kind list against it — the same two-step the code fence uses, where
     `/code` writes the backticks and the language completes itself. Every
     kind's name still matches here, so `/warn` and `/tip` find it. */
  action('Callout', ['aside', 'admonition',
    ...CALLOUT_KINDS.flatMap((k) => [k.id, ...(k.alias || [])])], BLOCKS,
  (view, from) => {
    view.dispatch({
      changes: { from, insert: '> [!' },
      selection: { anchor: from + 4 },
      userEvent: 'input.complete'
    })
    /* On the next tick, because CodeMirror closes the open completion as part
       of applying this one — asking for the kind list inside `apply` would be
       asking for something that is about to be dismissed. */
    setTimeout(() => startCompletion(view), 0)
  }),

  /* Straight to the vault's picker: the list of things this note can actually
     embed beats a `${name}` blank the writer has to fill from memory. */
  action('Image or file', ['embed', 'picture', 'attachment', 'img', 'photo', 'pdf', 'note'],
    EMBEDS, (view, from) => openEmbedPicker(view, from, from)),

  command('Website', ['embed', 'web', 'page', 'iframe', 'url', 'link'], EMBEDS,
    '![[https://${example.com}]]'),
  command('YouTube', ['embed', 'video', 'player', 'yt'], EMBEDS,
    '![[https://www.youtube.com/watch?v=${id}]]'),

  /* Opens the note's tag editor. No placeholder YAML is written: the head is
     created only once the reader supplies an actual tag. */
  action('Tags', ['labels', 'frontmatter', 'metadata', 'yaml', 'head'], BLOCKS,
    (view) => view.dom.dispatchEvent(new CustomEvent('tulip:tags', { bubbles: true })))
]

/**
 * The completion source. Returns null whenever the text before the cursor is
 * not its trigger, so the sources beside it never fight. Re-consulted on each
 * keystroke — the filter is an includes() over a handful of strings.
 */
export function slashCommands (context) {
  const before = context.matchBefore(/\/[\w-]*/)
  if (!before) return null

  // Only a `/` that begins its line opens the menu. Everything before it must
  // be whitespace — mid-sentence slashes are prose, not requests.
  const line = context.state.doc.lineAt(before.from)
  if (/\S/.test(context.state.sliceDoc(line.from, before.from))) return null
  if (inFence(context.state, before.from)) return null

  const query = before.text.slice(1).toLowerCase()
  const options = COMMANDS
    .filter((c) => !query || c.haystack.includes(query))
    .map((c) => c.completion)
  if (!options.length) return null

  /* `from` includes the slash, so choosing a command replaces it — the `/`
     was an instruction to the editor, not text for the note. */
  return { from: before.from, options, filter: false }
}

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

/* ------------------------------------------------------------ hashtags */

/** The vault's tags, handed in by the renderer as a function so the list is
 *  read at keystroke time. May answer with a promise — the tags live in the
 *  main process — and the autocompletion machinery waits for it. */
export const tagChoices = Facet.define({ combine: (v) => v[0] || (() => []) })

/**
 * Completes a `#tag` against every tag the vault already carries.
 *
 * The trigger mirrors the vault's own hashtag grammar — a `#` after
 * whitespace or at the start of a line, then word characters — with one
 * refusal on top: a bare `#` with nothing typed yet offers nothing unless
 * asked (⌃Space). A heading begins with exactly that character, and a list
 * of every tag popping up on the way to `# Introduction` would make the
 * completion a nuisance on the syntax it shares.
 */
export async function hashTags (context) {
  const before = context.matchBefore(/#[\p{L}\p{N}/_-]*$/u)
  if (!before) return null

  const line = context.state.doc.lineAt(before.from)
  const lead = context.state.sliceDoc(line.from, before.from)
  // `word#` is prose and `##` is a heading; both leave the tag grammar.
  if (/[^\s]$/.test(lead)) return null
  if (inFence(context.state, before.from)) return null

  const query = before.text.slice(1).toLowerCase()
  if (!query && !context.explicit) return null

  const list = await context.state.facet(tagChoices)()
  const options = (list || [])
    .filter((t) => !query || t.tag.includes(query))
    .map((t) => ({
      label: `#${t.tag}`,
      detail: `${t.notes} ${t.notes === 1 ? 'note' : 'notes'}`,
      type: 'constant'
    }))
  if (!options.length) return null

  // From the `#`, so the option's label replaces the whole half-typed tag.
  return { from: before.from, options, filter: false }
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
