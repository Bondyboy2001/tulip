/**
 * The slash menu: type `/` at the start of a line and pick what to insert.
 *
 * A completion source rather than a popup of its own, so it gets CodeMirror's
 * keyboard handling and tooltip for free, and sits beside the `[[` note
 * completion in the same autocompletion() config. Templates are snippets: the
 * cursor lands in the first blank, and Tab walks the rest.
 *
 * The trigger is deliberately narrow — a `/` with nothing but whitespace
 * before it on the line — so writing "and/or" or a file path never opens a
 * menu. That is also Obsidian's rule, so hands trained there already know it.
 *
 * Filtering is this module's own (label + hidden aliases, so `/img` finds
 * Image and `/error` finds Danger), which is why the result says
 * `filter: false`: CodeMirror's matcher would otherwise re-filter against the
 * text from `from` — which includes the `/` — and match nothing.
 */

import { snippetCompletion, startCompletion } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { CALLOUT_KINDS } from './callouts.js'
import { LANGUAGES } from './languages.js'

/* The groups, in the order the menu shows them; within a group, commands stay
   in the order written here. */
const BLOCKS = { name: 'Blocks', rank: 0 }
const EMBEDS = { name: 'Embeds', rank: 1 }

/** One command: what the menu shows, what it answers to, what it inserts. */
function command (label, detail, aliases, section, template) {
  const completion = snippetCompletion(template, { label, detail, section, type: 'keyword' })
  return { completion, haystack: `${label} ${aliases.join(' ')}`.toLowerCase() }
}

/* Deliberately short — code, embeds and callouts, the things with syntax
   worth not remembering. Headings, lists and quotes are quicker to just
   type than to pick from a menu. */
const COMMANDS = [
  command('Code block', '```', ['fence', 'snippet', 'source', 'run'], BLOCKS,
    '```${language}\n${}\n```'),

  command('Image or file', '![[…]]', ['embed', 'picture', 'attachment', 'img', 'photo'], EMBEDS,
    '![[${name}]]'),
  command('PDF', '![[….pdf]]', ['embed', 'document', 'pages'], EMBEDS,
    '![[${file}.pdf]]'),
  command('Website', '![[https://…]]', ['embed', 'web', 'page', 'iframe', 'url', 'link'], EMBEDS,
    '![[https://${example.com}]]'),
  command('YouTube', '![[watch URL]]', ['embed', 'video', 'player', 'yt'], EMBEDS,
    '![[https://www.youtube.com/watch?v=${id}]]'),

  calloutCommand()
]

/**
 * One entry for all thirteen kinds.
 *
 * Thirteen commands filled two thirds of the menu with rows that differed only
 * in a word, and the writer still had to read them all to find the one they
 * meant. Choosing this one writes `> [!` and opens the kind list against it —
 * the same two-step the code fence already uses, where `/code` writes the
 * backticks and the language completes itself afterwards.
 *
 * Every kind's name still matches here, so `/warn` and `/tip` find the command
 * as they always did; what they no longer do is each take a row of their own.
 */
function calloutCommand () {
  const names = CALLOUT_KINDS.flatMap((k) => [k.id, ...(k.alias || [])])
  return {
    completion: {
      label: 'Callout',
      detail: '> [!…]',
      section: BLOCKS,
      type: 'keyword',
      apply: (view, _completion, from, to) => {
        view.dispatch({
          changes: { from, to, insert: '> [!' },
          selection: { anchor: from + 4 },
          userEvent: 'input.complete'
        })
        /* On the next tick, because CodeMirror closes the open completion as
           part of applying this one — asking for the kind list inside `apply`
           would be asking for something that is about to be dismissed. */
        setTimeout(() => startCompletion(view), 0)
      }
    },
    haystack: `callout aside admonition ${names.join(' ')}`
  }
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
 * Reached either by choosing Callout from the slash menu or by typing `> [!`
 * outright, which is the whole point of putting it on the syntax rather than
 * behind the command: the menu is a way in, not the only one.
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

/**
 * The completion source. Returns null whenever the text before the cursor is
 * not its trigger, so the sources beside it never fight. Re-consulted on each
 * keystroke — the filter is an includes() over forty strings.
 */
export function slashCommands (context) {
  const before = context.matchBefore(/\/[\w-]*/)
  if (!before) return null

  // Only a `/` that begins its line opens the menu. Everything before it must
  // be whitespace — mid-sentence slashes are prose, not requests.
  const line = context.state.doc.lineAt(before.from)
  if (/\S/.test(context.state.sliceDoc(line.from, before.from))) return null

  const query = before.text.slice(1).toLowerCase()
  const options = COMMANDS
    .filter((c) => !query || c.haystack.includes(query))
    .map((c) => c.completion)
  if (!options.length) return null

  /* `from` includes the slash, so choosing a command replaces it — the `/`
     was an instruction to the editor, not text for the note. */
  return { from: before.from, options, filter: false }
}

/* ------------------------------------------------------ fence languages */

/* One option per language the chip table knows, in the table's own order —
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
  const options = LANG_OPTIONS
    .filter((l) => !query || l.haystack.includes(query))
    .map((l) => l.completion)
  if (!options.length) return null

  // Only the token is replaced; the backticks stay exactly as typed.
  return { from: before.from + 3, options, filter: false }
}
