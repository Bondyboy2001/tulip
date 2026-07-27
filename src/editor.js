import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection,
         rectangularSelection, dropCursor, highlightActiveLine } from '@codemirror/view'
import { EditorState, Prec, StateEffect, StateField, Compartment, Facet } from '@codemirror/state'
import { syntaxTree, HighlightStyle, syntaxHighlighting, indentOnInput,
         bracketMatching } from '@codemirror/language'
import { codeTokens } from './highlight.js'
import { languageChip } from './languages.js'

export { openSearchPanel }
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { autocompletion, closeBrackets, closeBracketsKeymap,
         completionKeymap } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import { mathPreview } from './math.js'
import { moneyPreview } from './money.js'
import { codeBlockKeymap, proseBrackets, codeLineNumbers } from './codeblock.js'
import { runBlocks } from './runblocks.js'
import { tablePreview } from './table.js'
import { findEmbeds, embedSpec, renderEmbed } from './assets.js'

/* ---------------------------------------------------------------- theme */

const tulipTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', height: '100%' },
  '.cm-gutters': { display: 'none' },
  // Padding cancelled by an equal negative margin: the highlight band extends
  // past the text on both sides without shifting the text itself.
  '.cm-line': { padding: '0 10px', margin: '0 -10px' },
  // CodeMirror injects its base theme into the head at runtime, after our
  // stylesheet, so a plain .cm-scroller rule loses the tie. Setting type here
  // puts it in the theme layer, which wins.
  '.cm-scroller': {
    fontFamily: 'var(--font-body)',
    fontSize: '17px',
    lineHeight: '1.68',
    padding: '40px 0 0'
  },
  '.cm-content': {
    maxWidth: 'var(--measure)',
    marginInline: 'auto',
    padding: '0 24px',
    caretColor: 'var(--accent)'
  },
  // CodeMirror's base theme paints a black caret and injects itself after our
  // stylesheet, so on a dark background the cursor disappeared entirely. Theme
  // rules outrank the base theme, which is why these live here and not in CSS.
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px'
  },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'var(--sel)'
  },
  // The line under the cursor is the one showing raw markup, so marking it
  // explains the editor's behaviour rather than just decorating it.
  '.cm-activeLine': {
    background: 'var(--active-line)',
    borderRadius: '3px'
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-dim)',
    outline: 'none'
  },
  '.cm-placeholder': { color: 'var(--faint)', fontStyle: 'italic' },
  // Where the assistant just wrote. It fades rather than clears, so a run of
  // edits reads as a hand moving down the page.
  '.cm-agentEdit': {
    background: 'var(--agent-flash)',
    borderRadius: '2px',
    transition: 'background .9s var(--ease)'
  }
})

/* Markdown's own tags come first; the code tokens after them own everything
   inside a fence. The two sets are disjoint, so neither has to out-specify
   the other. */
const highlight = HighlightStyle.define([
  { tag: t.processingInstruction, class: 'tk-mark' },
  // Emphasis carries a colour of its own — warm for bold, cool for italic —
  // so the two are told apart at a glance rather than by weight and slant
  // alone, which a serif at reading size gives away only faintly.
  { tag: t.strong, fontWeight: '650', color: 'var(--strong)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--emph)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--faint)' },
  { tag: t.link, class: 'tk-link' },
  { tag: t.url, class: 'tk-mark' },
  { tag: t.monospace, class: 'tk-inline-code' },
  { tag: t.heading, fontWeight: '600' },
  { tag: t.quote, color: 'var(--ink-soft)' },
  // t.list covers a whole list item, not just its mark, so colouring it here
  // tinted every task's text. The bullet gets its colour from BulletWidget.
  { tag: t.contentSeparator, color: 'var(--line)' },
  ...codeTokens
])

/* -------------------------------------------------------- live preview */

const HEADING = /^ATXHeading(\d)$/
const HIDDEN_MARKS = new Set([
  'HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark',
  'LinkMark', 'QuoteMark', 'SubscriptMark', 'SuperscriptMark'
])

/** The note's name, set above the first line the way Obsidian does it — the
 *  document's own title rather than a line of frontmatter pretending to be one. */
class TitleWidget extends WidgetType {
  constructor (text) { super(); this.text = text }
  eq (other) { return other.text === this.text }
  toDOM () {
    const h = document.createElement('div')
    h.className = 'tk-title'
    h.textContent = this.text
    return h
  }
  ignoreEvent () { return true }
}

class LangChipWidget extends WidgetType {
  constructor (info, label) { super(); this.info = info; this.label = label }
  eq (other) { return other.info === this.info && other.label === this.label }
  toDOM () {
    const chip = languageChip(this.info, { label: this.label })
    if (!chip) return document.createElement('span')
    chip.classList.add('tk-lang-chip')
    return chip
  }
  ignoreEvent () { return true }
}

/* Resolving an embed needs the vault's file list, which lives in the renderer.
   A facet carries it in rather than a module-level variable, so the decoration
   builder stays a function of editor state. */
const embedResolver = Facet.define({
  combine: (values) => values[0] || (() => null)
})

/**
 * A picture, standing where its markup was written.
 *
 * The widget is deliberately the whole match: an embed is one object, and
 * leaving `![[` visible beside the image it produced would be showing the
 * scaffolding next to the building. The line you are editing still shows its
 * source, the same rule the rest of the live preview follows.
 */
class EmbedWidget extends WidgetType {
  /** @param spec the shape `embedSpec()` returns — see src/assets.js */
  constructor (spec) { super(); this.spec = spec }

  // Compared field by field rather than by identity: a fresh spec object is
  // built on every decoration pass, and an identity check would re-create the
  // <img> — and re-decode the picture — on every keystroke.
  eq (other) {
    const a = this.spec
    const b = other.spec
    return a.kind === b.kind && a.path === b.path && a.label === b.label &&
           a.alt === b.alt && a.width === b.width && a.height === b.height
  }

  toDOM (view) {
    // The height of a picture is unknown until it decodes, and CodeMirror has
    // already measured the line by then. Asking for a re-measure is what keeps
    // the cursor and the scrollbar from sitting a picture too high — and it is
    // the one thing here the reading view has no equivalent of.
    return renderEmbed(this.spec, () => view.requestMeasure())
  }

  // Clicks have to reach the media controls and the file chip.
  ignoreEvent () { return false }
}

class BulletWidget extends WidgetType {
  eq () { return true }
  toDOM () {
    const dot = document.createElement('span')
    dot.className = 'tk-bullet'
    dot.textContent = '•'
    return dot
  }
}

class TaskWidget extends WidgetType {
  constructor (checked, pos) { super(); this.checked = checked; this.pos = pos }
  eq (other) { return other.checked === this.checked && other.pos === this.pos }
  toDOM (view) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'tk-task'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Completed' : 'Not completed')
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('click', (e) => {
      e.preventDefault()
      view.dispatch({
        changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' }
      })
    })
    return box
  }
  ignoreEvent () { return false }
}

/**
 * Decorations are rebuilt from the visible ranges on every relevant update.
 * Markup is hidden unless the cursor sits on that line — the line you are
 * editing always shows its true source, everything else reads as prose.
 */
function buildDecorations (view) {
  const { state } = view
  const ranges = []
  const hidden = []

  const activeLines = new Set()
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    const last = state.doc.lineAt(r.to).number
    for (let n = first; n <= last; n++) activeLines.add(n)
  }

  const isActive = (pos) => activeLines.has(state.doc.lineAt(pos).number)

  /* Frontmatter is resolved first: its closing fence would otherwise be parsed
     as a thematic break and styled as a rule. */
  let frontmatterEnd = 0
  if (state.doc.lines > 1 && state.doc.line(1).text.trim() === '---') {
    for (let n = 2; n <= Math.min(state.doc.lines, 300); n++) {
      if (state.doc.line(n).text.trim() === '---') { frontmatterEnd = n; break }
    }
  }
  const inFrontmatter = (pos) => frontmatterEnd && state.doc.lineAt(pos).number <= frontmatterEnd

  const hide = (from, to) => {
    if (to <= from) return
    ranges.push(Decoration.replace({}).range(from, to))
    hidden.push([from, to])
  }
  const insideHidden = (from, to) =>
    hidden.some(([a, b]) => from < b && to > a)

  const tree = syntaxTree(state)

  /* Code spans are collected up front: a [[ inside inline code is not a link,
     and without this the regex below happily pairs it with a ]] later in the
     line and swallows everything between. */
  const codeRanges = []
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') {
          codeRanges.push([node.from, node.to])
        }
      }
    })
  }
  const inCode = (from, to) => codeRanges.some(([a, b]) => from < b && to > a)

  /* Wikilinks run next. lezer parses [[Note]] as a regular link, so if the main
     tree pass went first it would hide the brackets as LinkMarks and this pass
     would find nothing left to claim. */
  const claimed = []
  const isClaimed = (from, to) => claimed.some(([a, b]) => from < b && to > a)

  /* Embeds come first of all, because `![[picture.png]]` contains a perfectly
     good wikilink and the pass below would otherwise render the `[[…]]` half of
     it as a link, leaving a stray `!` in front. Claiming the whole match here
     settles which of the two it is. */
  const resolve = state.facet(embedResolver)

  for (const { from, to } of view.visibleRanges) {
    const startLine = state.doc.lineAt(from).number
    const endLine = state.doc.lineAt(to).number

    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n)
      const active = activeLines.has(n)

      // One scanner, shared with the reading view — see src/assets.js. It
      // returns nothing for a line with no `![` in it, which is almost every
      // line, and this runs on every keystroke.
      for (const embed of findEmbeds(line.text)) {
        const start = line.from + embed.from
        const end = line.from + embed.to
        if (inCode(start, end) || isClaimed(start, end)) continue

        claimed.push([start, end])
        if (active) continue   // the line being edited keeps its source

        const spec = embedSpec(embed.src, { alt: embed.alt, size: embed.size, resolve })
        ranges.push(Decoration.replace({ widget: new EmbedWidget(spec) }).range(start, end))
        hidden.push([start, end])
      }

      // Brackets are excluded from the target so a stray "[[" (in code, say)
      // cannot match across the line and swallow a real link's "]]".
      for (const m of line.text.matchAll(/\[\[([^[\]|]+)(\|([^[\]]+))?\]\]/g)) {
        const start = line.from + m.index
        const end = start + m[0].length
        if (inCode(start, end) || isClaimed(start, end)) continue
        const label = m[3] || m[1]
        const target = m[1].trim()
        claimed.push([start, end])

        if (active) {
          ranges.push(
            Decoration.mark({ class: 'tk-wikilink', attributes: { 'data-wikilink': target } })
              .range(start, end)
          )
        } else {
          const labelStart = m[3] ? start + 2 + m[1].length + 1 : start + 2
          hide(start, labelStart)
          ranges.push(
            Decoration.mark({ class: 'tk-wikilink', attributes: { 'data-wikilink': target } })
              .range(labelStart, labelStart + label.length)
          )
          hide(labelStart + label.length, end)
        }
      }
    }
  }

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name

        const heading = HEADING.exec(name)
        if (heading) {
          const line = state.doc.lineAt(node.from)
          ranges.push(
            Decoration.line({ class: `tk-h${heading[1]}` }).range(line.from)
          )
          return
        }

        if (name === 'Blockquote') {
          let pos = node.from
          while (pos <= node.to) {
            const line = state.doc.lineAt(pos)
            ranges.push(Decoration.line({ class: 'tk-quote' }).range(line.from))
            if (line.to >= node.to) break
            pos = line.to + 1
          }
          return
        }

        if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(node.to).number
          /* A finished block ends on a line holding nothing but the fence. That
             line's markers are hidden, so it can be collapsed to the padding it
             reads as, and the room it was taking moves up to the last line of
             real code — where a click aimed just under the code belongs.

             A block still being typed at the end of the note has no such line:
             its last line is code, and has to stay a line of code. */
          const closed = last > first && /^\s*(```|~~~)\s*$/.test(state.doc.line(last).text)
          for (let n = first; n <= last; n++) {
            const edge =
              (n === first ? ' tk-code-top' : '') +
              (n === last ? ' tk-code-bottom' : '') +
              (closed && n === last ? ' tk-code-fence' : '') +
              (closed && n === last - 1 && n > first ? ' tk-code-last' : '')
            ranges.push(
              Decoration.line({ class: `tk-code-block${edge}` }).range(state.doc.line(n).from)
            )
          }
          return
        }

        if (name === 'HorizontalRule' && !inFrontmatter(node.from) && !isActive(node.from)) {
          const line = state.doc.lineAt(node.from)
          ranges.push(Decoration.line({ class: 'tk-hr' }).range(line.from))
          return
        }

        if (name === 'TaskMarker') {
          const text = state.doc.sliceString(node.from, node.to)
          ranges.push(
            Decoration.replace({
              widget: new TaskWidget(/[xX]/.test(text), node.from)
            }).range(node.from, node.to)
          )
          hidden.push([node.from, node.to])
          // A finished task reads as finished, not just as a ticked box.
          if (/[xX]/.test(text)) {
            const line = state.doc.lineAt(node.from)
            ranges.push(Decoration.line({ class: 'tk-done' }).range(line.from))
          }
          return
        }

        /* The fence's language gets a tile. On the line you are editing the raw
           token stays put — you cannot retype what you cannot see — everywhere
           else the chip stands in for it. */
        if (name === 'CodeInfo') {
          const info = state.doc.sliceString(node.from, node.to).trim().split(/\s+/)[0]
          // On the line being edited the fence is just text: ```python, plain,
          // with nothing standing beside it. A chip there competes with the
          // token it is meant to replace.
          if (isActive(node.from)) return

          ranges.push(
            Decoration.widget({ widget: new LangChipWidget(info, true), side: -1 })
              .range(node.from)
          )
          hide(node.from, node.to)
          return
        }

        if (isActive(node.from)) return

        if (name === 'ListMark') {
          const mark = state.doc.sliceString(node.from, node.to)
          if (/\d/.test(mark)) return   // ordered lists keep their numbering
          const after = state.doc.sliceString(node.to, Math.min(node.to + 6, state.doc.length))
          const task = /^\s*\[[ xX]\]/.exec(after)
          if (task) {
            // The checkbox is the bullet; a dash beside it is noise.
            hide(node.from, node.to + (/^\s*/.exec(after)[0].length))
          } else {
            ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
            hidden.push([node.from, node.to])
          }
          return
        }

        if (HIDDEN_MARKS.has(name)) {
          if (isClaimed(node.from, node.to)) return
          let end = node.to
          // A header's '#' owns the space after it; leaving that space behind
          // would push the heading one character off the measure.
          if (name === 'HeaderMark') {
            while (end < state.doc.length && state.doc.sliceString(end, end + 1) === ' ') end++
          }
          hide(node.from, end)
          return
        }

        if (name === 'URL' && node.node.parent?.name === 'Link' && !isClaimed(node.from, node.to)) {
          hide(node.from, node.to)
        }
      }
    })
  }

  /* Tags run last, so they can defer to anything the tree or wikilinks claimed. */
  for (const { from, to } of view.visibleRanges) {
    const startLine = state.doc.lineAt(from).number
    const endLine = state.doc.lineAt(to).number

    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n)

      for (const m of line.text.matchAll(/(^|\s)(#[\p{L}\p{N}][\p{L}\p{N}/_-]*)/gu)) {
        const start = line.from + m.index + m[1].length
        const end = start + m[2].length
        if (insideHidden(start, end) || isClaimed(start, end) || inCode(start, end)) continue
        // A heading's '#' is followed by a space, so it never matches here.
        ranges.push(Decoration.mark({ class: 'tk-tag' }).range(start, end))
      }
    }
  }

  /* Frontmatter reads as a different register from the prose below it: a
     monospace block with a rule down its left edge. */
  for (let n = 1; n <= frontmatterEnd; n++) {
    const line = state.doc.line(n)
    const edge = n === 1 ? ' tk-fm-top' : n === frontmatterEnd ? ' tk-fm-bottom' : ''
    ranges.push(Decoration.line({ class: `tk-frontmatter${edge}` }).range(line.from))
  }

  return Decoration.set(ranges, true)
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor (view) { this.decorations = buildDecorations(view) }
    update (update) {
      // A refresh means something the decorations read from *outside* the
      // document moved — the note's name, or the list of attachments an embed
      // resolves against. Nothing in the update itself would show that.
      const refreshed = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshEffect)))

      if (refreshed || update.docChanged || update.selectionSet || update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: () =>
      EditorView.atomicRanges.of((view) => view.plugin(livePreview)?.decorations ?? Decoration.none)
  }
)

/* ------------------------------------------------------------ the title */

/* The title lives outside the document, so nothing in an ordinary update tells
   the plugin it changed. A rename dispatches this instead. */
const refreshEffect = StateEffect.define()

/**
 * Kept apart from the live preview: the name of the note belongs at the top of
 * the page in every view, including the raw one.
 *
 * A state field rather than a view plugin — CodeMirror refuses block
 * decorations from plugins, because a plugin cannot be consulted before the
 * viewport it would change has been measured.
 */
function titleFor (noteTitle) {
  const build = () => {
    const text = noteTitle?.()
    if (!text) return Decoration.none
    return Decoration.set([
      Decoration.widget({ widget: new TitleWidget(text), block: true, side: -1 }).range(0)
    ])
  }

  return StateField.define({
    create: build,
    update (deco, tr) {
      if (tr.effects.some((e) => e.is(refreshEffect))) return build()
      return deco.map(tr.changes)
    },
    provide: (field) => EditorView.decorations.from(field)
  })
}

/* -------------------------------------------------- the assistant's edits */

/* Marks the span the assistant just rewrote, so a change arriving from outside
   the keyboard is seen happening rather than discovered afterwards. */
const flashEffect = StateEffect.define()   // { from, to } | null

/**
 * A state field, so the mark rides the document: text typed above the flashed
 * span moves it, and a second edit landing before the first has faded remaps
 * the first rather than leaving it stranded over the wrong words.
 */
const agentFlash = StateField.define({
  create: () => Decoration.none,
  update (deco, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(flashEffect)) continue
      if (!effect.value) return Decoration.none
      const { from, to } = effect.value
      if (to <= from) return Decoration.none
      return Decoration.set([Decoration.mark({ class: 'cm-agentEdit' }).range(from, to)])
    }
    return deco.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})

/**
 * The smallest single change that turns `a` into `b` — everything between the
 * first and last character they disagree on.
 *
 * A whole-document replacement would be simpler and is what a naive reload
 * does, but it discards the cursor, the selection, the scroll position and the
 * undo history. This keeps all four, because the parts of the note that did not
 * change are never touched. Edits scattered across a note collapse into one
 * wide span; the document still ends up right, and the flash is merely broader
 * than it strictly needs to be.
 */
export function diffRange (a, b) {
  if (a === b) return null
  const limit = Math.min(a.length, b.length)
  let start = 0
  while (start < limit && a.charCodeAt(start) === b.charCodeAt(start)) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start &&
         a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB-- }
  return { from: start, to: endA, insert: b.slice(start, endB) }
}

/* Everything that renders rather than annotates. Named once because raw view
   swaps the whole set out and back — restoring a subset here is how tables and
   equations quietly stopped coming back after a trip through ⌘3. A rendered
   table in the "raw" view would make the view a lie, so they travel together. */
const RENDERED = [livePreview, mathPreview, tablePreview, moneyPreview, runBlocks]

/* ------------------------------------------------------------ shortcuts */

function wrapSelection (view, before, after = before) {
  const changes = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to)
    const already =
      text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length
    const next = already
      ? text.slice(before.length, text.length - after.length)
      : before + text + after
    const delta = already ? -before.length : before.length
    return {
      changes: { from: range.from, to: range.to, insert: next },
      range: range.empty
        ? { anchor: range.from + before.length }
        : { anchor: range.from + delta, head: range.from + delta + (already ? next.length : text.length) }
    }
  })
  view.dispatch(changes, { scrollIntoView: true, userEvent: 'input' })
  return true
}

const markdownKeymap = [
  { key: 'Mod-b', run: (v) => wrapSelection(v, '**') },
  { key: 'Mod-i', run: (v) => wrapSelection(v, '*') },
  { key: 'Mod-Shift-x', run: (v) => wrapSelection(v, '~~') },
  { key: 'Mod-e', run: () => true },   // owned by the menu; swallow the default
  { key: 'Mod-k', run: (v) => wrapSelection(v, '[', ']()') }
]

/* ----------------------------------------------------------- the editor */

export function createEditor ({
  parent, onChange, onOpenLink, noteNames, noteTitle, resolveEmbed
}) {
  const preview = new Compartment()
  let raw = false

  const wikiCompletion = (context) => {
    const before = context.matchBefore(/\[\[[^\]]*/)
    if (!before) return null
    const query = before.text.slice(2).toLowerCase()
    const options = noteNames()
      .filter((n) => n.name.toLowerCase().includes(query))
      .slice(0, 40)
      .map((n) => ({ label: n.name, detail: n.dir || undefined, type: 'text' }))
    if (!options.length) return null
    return { from: before.from + 2, options, validFor: /^[^\]]*$/ }
  }

  const extensions = [
        history(),
        drawSelection(),
        highlightActiveLine(),
        dropCursor(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
        syntaxHighlighting(highlight),
        titleFor(noteTitle),
        agentFlash,
        embedResolver.of(resolveEmbed || (() => null)),
        // Raw view empties this compartment: same document, same history, no
        // decorations standing between you and the markup.
        preview.of(RENDERED),
        codeBlockKeymap,
        codeLineNumbers,
        proseBrackets,
        autocompletion({ override: [wikiCompletion], icons: false }),
        tulipTheme,
        Prec.high(keymap.of(markdownKeymap)),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab
        ]),
        EditorView.domEventHandlers({
          click (event) {
            const el = event.target
            if (!(el instanceof HTMLElement)) return
            const asset = el.dataset.asset || el.closest('[data-asset]')?.dataset.asset
            if (asset) { onOpenLink({ type: 'asset', target: asset }); return true }
            const wiki = el.dataset.wikilink || el.closest('[data-wikilink]')?.dataset.wikilink
            if (wiki) { onOpenLink({ type: 'wikilink', target: wiki }); return true }
            if (el.classList.contains('tk-link') && (event.metaKey || event.ctrlKey)) {
              const text = el.textContent || ''
              if (/^https?:/.test(text)) { onOpenLink({ type: 'url', target: text }); return true }
            }
          }
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString())
        })
  ]

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: '', extensions })
  })

  /**
   * Each note gets a brand-new state rather than a replacing transaction, so
   * undo can never walk backwards out of this note and into the last one.
   */
  view.setDoc = (text) => {
    view.setState(EditorState.create({ doc: text, extensions }))
    // A fresh state resets every compartment to its default, so raw view has to
    // be re-applied or opening a note would quietly drop you back into preview.
    if (raw) view.dispatch({ effects: preview.reconfigure([]) })
  }

  /** Raw view: the file as it is on disk, monospaced, nothing hidden. */
  view.setRaw = (on) => {
    if (raw === on) return
    raw = on
    view.dispatch({ effects: preview.reconfigure(on ? [] : RENDERED) })
    view.dom.classList.toggle('is-raw', on)
  }

  /** Redraw the parts that read from outside the document — the inline title. */
  view.refresh = () => { view.dispatch({ effects: refreshEffect.of(null) }) }

  /**
   * Bring the buffer to `text` as an edit rather than a replacement, and mark
   * what moved. Used when the assistant writes to the note that is open: the
   * caret stays where it was, ⌘Z still walks back through it, and the changed
   * lines light up for a moment.
   */
  let fade = null
  view.patch = (text) => {
    const change = diffRange(view.state.doc.toString(), text)
    if (!change) return false
    view.dispatch({
      changes: change,
      effects: flashEffect.of({ from: change.from, to: change.from + change.insert.length }),
      // The assistant's writing should not steal the page from someone reading
      // elsewhere in it; only a change at the caret follows the caret.
      scrollIntoView: false
    })
    clearTimeout(fade)
    fade = setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1400)
    return true
  }

  /* Reading position, expressed as a line of the file rather than a pixel
     offset. Pixels do not survive the trip to another view — the reading view
     is a different scroll container, and even edit-to-raw changes every line's
     height by unhiding the markup. The line is the one thing all three agree
     on. */

  /** The source line at the top of the visible area. 1-based. */
  view.topLine = () => {
    const box = view.scrollDOM.getBoundingClientRect()
    const pos = view.posAtCoords({ x: box.left + 8, y: box.top + 2 }, false)
    if (pos == null) return 1
    return view.state.doc.lineAt(Math.max(0, Math.min(pos, view.state.doc.length))).number
  }

  /** Put that line back at the top. */
  view.scrollToLine = (n) => {
    const { doc } = view.state
    const line = doc.line(Math.max(1, Math.min(n, doc.lines)))
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) })
  }

  return view
}
