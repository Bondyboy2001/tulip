import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection,
         rectangularSelection, dropCursor, highlightActiveLine } from '@codemirror/view'
import { EditorState, EditorSelection, Prec, StateEffect, StateField,
         Compartment, Facet, Transaction } from '@codemirror/state'
import { syntaxTree, HighlightStyle, syntaxHighlighting, indentOnInput,
         bracketMatching, indentUnit, foldService, codeFolding, foldEffect,
         unfoldEffect, foldedRanges, foldKeymap, StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { codeTokens, languageFor } from './highlight.js'
import { languageChip } from './languages.js'

export { openSearchPanel }
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { search, searchKeymap, openSearchPanel } from '@codemirror/search'
import { findConfig } from './find.js'
import { EXTERNAL_SCHEME, flashTarget } from './links.js'
import { autocompletion, closeBrackets, closeBracketsKeymap,
         completionKeymap, startCompletion } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags as t } from '@lezer/highlight'
import { mathPreview, equationsFor } from './math.js'
import { moneyPreview } from './money.js'
import { codeBlockKeymap, proseBrackets, codeBlockView } from './codeblock.js'
import { runBlocks } from './runblocks.js'
import { propertiesPreview } from './properties.js'
import {
  languageTableMode, tableAssetResolver, tableCursorGuard, tablePreview,
  tableSearchHighlight, insertTable, fitAllColumns
} from './table.js'
import {
  findEmbeds, specForEmbed, renderEmbed, destroyEmbeds, withEmbedSize,
  embedResizeGrip, wireEmbedResize
} from './assets.js'
import { calloutHead, calloutIcon } from './callouts.js'
import {
  slashEmbed, openEmbedPicker, fenceLanguages, calloutKinds,
  embedChoices as embedChoicesFacet
} from './slash.js'
import { mermaidBlocks } from './mermaid.js'
import { tikzBlocks, tikzNote } from './tikz.js'
import { svgBlocks } from './svg.js'
import { headingsFor, blockReferences, blockReferenceOnLine } from './headings.js'
import { findInlineHighlights } from './marks.js'
import { findCitations } from './citations.js'
import { fileDiff, withinLines } from './linediff.js'

/* ---------------------------------------------------------------- theme */

const tulipTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', height: '100%' },
  '.cm-gutters': { display: 'none' },
  /* Padding cancelled by an equal negative margin: the highlight band extends
     past the text on both sides without shifting the text itself.

     24px, matching .cm-content's own padding, and not a smaller bleed: CodeMirror
     draws multi-line selections out to `contentRect edge + this padding` (it
     reads the first .cm-line's computed style — see rectanglesForRange in
     @codemirror/view). At 24px that edge is exactly where a code block's frame
     sits, so a selection through a block ends flush with the frame; at 10px it
     jutted 14px past the frame on both sides and read as broken. */
  '.cm-line': { padding: '0 24px', margin: '0 -24px' },
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
    // The measure, or the room there is — whichever is less, so a zoomed-in
    // window narrows the column instead of running it off the right edge.
    maxWidth: 'min(var(--measure), 100%)',
    marginInline: 'auto',
    padding: '0 24px',
    caretColor: 'var(--accent)'
  },
  /* TeX is source, not prose with live Markdown decorations. Give it the full
     half-pane and the code face while keeping the ordinary note measure and
     typography untouched. */
  '&.is-tex .cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13.5px',
    lineHeight: '1.62'
  },
  '&.is-tex .cm-content': { maxWidth: 'none', marginInline: '0' },
  // CodeMirror's base theme paints a black caret and injects itself after our
  // stylesheet, so on a dark background the cursor disappeared entirely. Theme
  // rules outrank the base theme, which is why these live here and not in CSS.
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px'
  },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  /* A rendered table replaces its source lines with one block widget, but
     CodeMirror still owns a document selection at the hidden boundary.
     Suppress the cursor itself in the theme layer: unlike the page stylesheet,
     this is injected alongside CodeMirror's cursor rules and cannot lose to
     their adopted stylesheet. The focused contenteditable cell continues to
     draw its ordinary, line-height caret.

     Keyed on the grid holding focus rather than on the note being a language
     one: a language note is an ordinary Markdown file that may have prose
     above its table, and prose needs its caret. */
  '&.has-table-cell-focus .cm-cursor': { display: 'none' },
  /* Both states, and the focused one spelled out the long way on purpose.
     CodeMirror's base theme paints the focused selection with
     `.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
     — four classes. A plain `&.cm-focused .cm-selectionBackground` is three,
     so the base rule outranked it and every focused selection came out in
     CodeMirror's stock light-theme lavender (rgb(215,212,240)) rather than the
     theme's own. Unfocused it looked right, which is what made it easy to
     miss. Matching the shape of the rule matches its specificity, and theme
     styles are injected after the base ones, so this one wins. */
  '.cm-selectionBackground': { background: 'var(--sel)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
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
  // Where the copilot just wrote. It fades rather than clears, so a run of
  // edits reads as a hand moving down the page.
  '.cm-agentEdit': {
    background: 'var(--agent-flash)',
    borderRadius: '2px',
    transition: 'background .9s var(--ease)'
  },
  /* A Copilot edit is shown as a familiar diff without putting any of the
     removed text back into the Markdown. Added source lines are the real
     document; removed ones are read-only block widgets beside them. */
  '.cm-agent-added-line': {
    position: 'relative',
    background: 'color-mix(in srgb, var(--code-added) 14%, transparent)',
    boxShadow: 'inset 3px 0 0 color-mix(in srgb, var(--code-added) 72%, transparent)'
  },
  '.cm-agent-added-line::before': {
    content: '"+"',
    position: 'absolute',
    left: '7px',
    color: 'var(--code-added)',
    fontFamily: 'var(--font-mono)',
    fontWeight: '650',
    zIndex: 'var(--z-sticky)',
    userSelect: 'none'
  },
  /* The words that moved, marked the way the panel's diff card marks them: a
     deeper wash of the line's colour over what actually changed. */
  '.cm-agent-word-added': {
    background: 'color-mix(in srgb, var(--code-added) 34%, transparent)',
    borderRadius: '2px'
  },
  '.cm-agent-word-removed': {
    background: 'color-mix(in srgb, var(--code-removed) 34%, transparent)',
    borderRadius: '2px'
  },
  '.cm-agent-working-line': {
    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    boxShadow: 'inset 3px 0 0 color-mix(in srgb, var(--accent) 65%, transparent)'
  },
  '.cm-agent-typing-cursor': {
    display: 'inline-block',
    width: '2px',
    height: '1.18em',
    margin: '0 1px',
    verticalAlign: '-0.18em',
    borderRadius: '1px',
    background: 'var(--accent)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)'
  },
  '.cm-agent-deleted': {
    margin: '1px -24px',
    color: 'var(--code-removed)',
    background: 'color-mix(in srgb, var(--code-removed) 13%, transparent)',
    boxShadow: 'inset 3px 0 0 color-mix(in srgb, var(--code-removed) 72%, transparent)',
    fontFamily: 'var(--font-body)',
    fontSize: '17px',
    lineHeight: '1.68'
  },
  '.cm-agent-deleted-line': {
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr)',
    padding: '0 24px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
  },
  '.cm-agent-diff-mark': {
    color: 'color-mix(in srgb, var(--code-removed) 75%, transparent)',
    fontFamily: 'var(--font-mono)',
    userSelect: 'none'
  },
  /* Deleted widgets next to a fenced-code line belong to that fence. Match
     its typography and gutter instead of inheriting the prose diff's larger
     body type. */
  '.cm-agent-deleted:has(+ .tk-code-block), .tk-code-block + .cm-agent-deleted': {
    margin: '1px 0',
    borderInline: '1px solid var(--line-soft)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12.5px',
    lineHeight: '1.62'
  },
  '.cm-agent-deleted:has(+ .tk-code-block) .cm-agent-deleted-line, .tk-code-block + .cm-agent-deleted .cm-agent-deleted-line': {
    gridTemplateColumns: 'calc(2ch + 16px) minmax(0, 1fr)',
    padding: '0 12px'
  },
  '.cm-agent-deleted:has(+ .tk-code-block) .cm-agent-diff-mark, .tk-code-block + .cm-agent-deleted .cm-agent-diff-mark': {
    paddingRight: '16px',
    textAlign: 'right'
  },

  /* The completion tooltip — the `[[` note list and the slash menu. Styled
     here rather than in styles.css for the same adoptedStyleSheets reason as
     the cursor above: the library's base theme lands after the document's
     sheets, so its light-grey card and monospace rows beat any plain rule of
     equal specificity. Theme rules carry the editor's own scope class and
     win. */
  '.cm-tooltip': {
    background: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: '8px',
    boxShadow: '0 10px 30px -10px rgb(0 0 0 / .5)',
    overflow: 'hidden'
  },
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    maxHeight: '17em',
    minWidth: '176px',
    maxWidth: '260px'
  },
  /* A list of short labels, so the row is only as tall as one: the menu is
     read by scanning down a column of names, and every pixel between them is
     one more the eye has to travel. The selected row is a rounded band inside
     the card's padding rather than a stripe across it — the same shape the
     sidebar and the quick switcher use for the row you are on. */
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 9px',
    borderRadius: '5px',
    color: 'var(--ink-soft)',
    lineHeight: '1.4',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--accent-dim)',
    color: 'var(--ink)'
  },
  // The group headers the slash menu sets — quiet, like the sidebar's labels.
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section': {
    padding: '7px 9px 3px',
    fontSize: '9.5px',
    fontWeight: '650',
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    color: 'var(--faint)',
    borderBottom: 'none',
    opacity: '1'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section:first-child': {
    paddingTop: '3px'
  },
  /* Only the lists whose right-hand column says something the label does not —
     a language's spelled-out name beside its id. The slash menu carries no
     detail at all: a column of `![[…]]` beside "Image or file" was syntax
     shown to someone who opened a menu precisely so they would not have to
     know it. */
  '.cm-completionDetail': {
    float: 'right',
    marginLeft: '18px',
    fontStyle: 'normal',
    fontSize: '11px',
    color: 'var(--faint)'
  }
})

/* Markdown's own tags come first; the code tokens after them own everything
   inside a fence. The two sets are disjoint, so neither has to out-specify
   the other. */
const highlight = HighlightStyle.define([
  { tag: t.processingInstruction, class: 'tk-mark' },
  /* Emphasis carries a colour of its own — warm for bold, cool for italic —
     so the two are told apart at a glance rather than by weight and slant
     alone, which a serif at reading size gives away only faintly.

     Classes rather than styles, for all three: the line being edited strips
     the rendering off every one of them (see .tk-strong, .tk-em and .tk-strike
     in styles.css), and a style declared here would be a generated class name
     nothing in the stylesheet can name to override. */
  { tag: t.strong, class: 'tk-strong' },
  { tag: t.emphasis, class: 'tk-em' },
  { tag: t.strikethrough, class: 'tk-strike' },
  { tag: t.link, class: 'tk-link' },
  { tag: t.url, class: 'tk-mark' },
  { tag: t.monospace, class: 'tk-inline-code' },
  { tag: t.heading, fontWeight: '600' },
  { tag: t.quote, color: 'var(--ink-soft)' },
  // t.list covers a whole list item, not just its mark, so colouring it here
  // tinted every task's text. The bullet gets its colour from BulletWidget.
  /* The `---` under the cursor. A *text* colour, not --line: the hairline
     border colour vanishes into the active-line band on dark themes. */
  { tag: t.contentSeparator, class: 'tk-mark' },
  ...codeTokens
])

/* -------------------------------------------------------- live preview */

const HEADING = /^ATXHeading(\d)$/
const HIDDEN_MARKS = new Set([
  'HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark',
  'LinkMark', 'QuoteMark', 'SubscriptMark', 'SuperscriptMark'
])

/**
 * The note's name, and the place it is renamed.
 *
 * A field rather than a line of text: the title is the file's name, so typing
 * over it is the rename — the same edit the sidebar's row makes, made where the
 * name is actually being read. An `<input>` rather than a contenteditable div,
 * because the editor's own content is contenteditable and CodeMirror would take
 * every keystroke inside one for a change to the document; an input's value is
 * not part of the DOM it watches.
 */
class TitleWidget extends WidgetType {
  constructor (text, rename, flag = '', editable = true) {
    super()
    this.text = text
    this.rename = rename
    this.flag = flag
    this.canRename = editable
  }
  eq (other) {
    return other.text === this.text &&
      other.flag === this.flag &&
      other.canRename === this.canRename
  }
  toDOM () {
    const h = document.createElement('div')
    h.className = 'tk-title'
    // Not the editor's text, so the caret cannot land in it by arrowing off the
    // top of the document, and CodeMirror leaves what is inside alone.
    h.contentEditable = 'false'

    const input = document.createElement('input')
    input.className = 'tk-title-field'
    input.type = 'text'
    input.value = this.text
    input.spellcheck = false
    input.setAttribute('aria-label', 'Note name')
    input.readOnly = !this.canRename
    if (!this.canRename) {
      input.classList.add('is-locked')
      input.setAttribute('aria-readonly', 'true')
      input.title = 'Rename language tables from the file explorer'
    }
    h.append(input)

    if (this.flag) {
      const flag = document.createElement('span')
      flag.className = 'tk-title-flag'
      flag.textContent = this.flag
      flag.setAttribute('aria-label', 'Language country flag')
      h.append(flag)
    }

    const was = this.text
    const rename = this.rename
    /* Leaving the field is what commits it, and both keys leave: Enter as it
       stands, Escape with the old name put back — which the unchanged test then
       reads as nothing having been asked for. One commit site, so there is no
       second one to keep in step. */
    input.addEventListener('blur', () => {
      const next = input.value.trim()
      if (!next || next === was) { input.value = was; return }
      rename?.(next)
    })
    input.addEventListener('keydown', (event) => {
      // The editor's keymap is bound to the whole content area; a name being
      // typed is not a document being edited.
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); input.value = was }
      else if (event.key !== 'Enter') return
      event.preventDefault()
      input.blur()
    })
    return h
  }
  ignoreEvent () { return true }
}

class LangChipWidget extends WidgetType {
  constructor (info, label, rest = '') {
    super()
    this.info = info
    this.label = label
    this.rest = rest
  }

  eq (other) {
    return other.info === this.info && other.label === this.label && other.rest === this.rest
  }

  toDOM (view) {
    const chip = languageChip(this.info, { label: this.label })
    if (!chip) return document.createElement('span')
    chip.classList.add('tk-lang-chip')
    chip.title = 'Change language'

    /* The chip is also the way to a different language: a click puts the
       caret at the end of the token it stands for — which brings the raw
       text back — and opens the fence completion over it. Asked for rather
       than typed at, the completion offers the whole list (see
       fenceLanguages), and picking one replaces the word. */
    chip.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const pos = view.posAtDOM(chip)
      const line = view.state.doc.lineAt(pos)
      const token = /^(\s*(?:```|~~~)\s*)(\S+)/.exec(line.text)
      if (!token) return
      view.dispatch({ selection: { anchor: line.from + token[1].length + token[2].length } })
      view.focus()
      startCompletion(view)
    })

    if (!this.rest) return chip
    /* What the fence said after its language, the same as the reading view's
       header shows it. Beside the chip, not inside it: the words are not part
       of the language control a click on the chip is. */
    const slot = document.createElement('span')
    slot.append(chip)
    const rest = document.createElement('span')
    rest.className = 'code-info'
    rest.textContent = this.rest
    slot.append(rest)
    return slot
  }

  ignoreEvent () { return true }
}

/* Resolving an embed needs the vault's file list, which lives in the renderer.
   A facet carries it in rather than a module-level variable, so the decoration
   builder stays a function of editor state. */

/* The same bridge for the other thing `![[…]]` can name: a note. Kept apart
   from the asset resolver because they answer differently — an attachment
   resolves relative to the note's folder, a note by name across the vault. */
const embedNoteResolver = Facet.define({ combine: (v) => v[0] || (() => null) })

/* A picture deliberately keeps its geometry when the caret crosses its line.
   This is the explicit way through that rule: the image's own source button
   names the exact replaced range that should open as Markdown. */
const embedSourceEffect = StateEffect.define()

/* What a line may hold beside an embed and still count as holding only that
   embed: indentation, a bullet, a quote mark, and the two halves of the link
   a badge is usually written inside. */
const LINE_FURNITURE = /^(?:\s|[-*+>]|\[|\]\([^()\s]*\))*$/

/**
 * A picture, standing where its markup was written.
 *
 * The widget is deliberately the whole match: an embed is one object, and
 * leaving `![[` visible beside the image it produced would be showing the
 * scaffolding next to the building. The line you are editing still shows its
 * source, the same rule the rest of the live preview follows.
 */
class EmbedWidget extends WidgetType {
  /**
   * @param spec the shape `embedSpec()` returns — see src/assets.js
   * @param figure whether the embed is the whole line, and so stands on one of
   *   its own rather than in a row — the editing view's answer to the question
   *   `standsAlone` answers about a paragraph in src/renderer.js
   */
  constructor (spec, figure) { super(); this.spec = spec; this.figure = figure }

  // Compared field by field rather than by identity: a fresh spec object is
  // built on every decoration pass, and an identity check would re-create the
  // <img> — and re-decode the picture — on every keystroke.
  eq (other) {
    const a = this.spec
    const b = other.spec
    /* `url` and not just `path`: a remote embed has no path, and a YouTube one
       has a fixed label too, so without this every video in a note compared
       equal to every other and editing the id left the old player running. */
    return a.kind === b.kind && a.path === b.path && a.url === b.url &&
           a.label === b.label && a.alt === b.alt &&
           a.width === b.width && a.height === b.height && a.page === b.page &&
           a.start === b.start && a.anchor === b.anchor &&
           this.figure === other.figure
  }

  toDOM (view) {
    // The height of a picture is unknown until it decodes, and CodeMirror has
    // already measured the line by then. Asking for a re-measure is what keeps
    // the cursor and the scrollbar from sitting a picture too high — and it is
    // the one thing here the reading view has no equivalent of.
    const embed = renderEmbed(this.spec, () => view.requestMeasure())
    if (this.spec.kind === 'image') {
      const host = sizerFor(embed, view)
      if (this.figure) host.classList.add('is-figure')
      return host
    }
    if (this.figure) embed.classList.add('is-figure')
    return embed
  }

  // An embedded PDF holds a parsed document; CodeMirror says when the widget
  // is gone for good, and that is the moment to let the document go too.
  destroy (dom) { destroyEmbeds(dom) }

  // Clicks have to reach the media controls and the file chip — but the
  // image controls are the widget's own, and the editor starting a text
  // selection under either one would fight the click or drag.
  ignoreEvent (event) {
    return event.target instanceof Element && !!event.target.closest(
      '.tk-embed-control, .tk-embed-grip, ' +
      '.transclude-edit, .transclude-source, .transclude-edit-controls'
    )
  }
}

/**
 * A picture the pointer can resize. Dragging the handle writes the width back
 * into the note as the `|400` suffix both views already read — the size is a
 * fact about the note, not about this session, so it survives the round trip
 * through disk and shows the same in the reading view.
 */
function sizerFor (img, view) {
  const host = document.createElement('span')
  host.className = 'tk-embed-sizer'

  const source = document.createElement('button')
  source.type = 'button'
  source.className = 'tk-embed-control tk-embed-source'
  source.title = 'Show this image’s Markdown'
  source.setAttribute('aria-label', 'Show this image’s Markdown')
  source.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="m6 4-4 4 4 4M10 4l4 4-4 4" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'

  /* The second control: change what the picture embeds. Same corner, one
     button over from the source reveal — clicking the picture itself stays
     free for caret placement, and this is the explicit "click into it" the
     placeholder chip already offers. */
  const change = document.createElement('button')
  change.type = 'button'
  change.className = 'tk-embed-control tk-embed-change'
  change.title = 'Choose what to embed'
  change.setAttribute('aria-label', 'Choose what to embed')
  change.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M7 2.5 3.5 6 7 9.5M9 2.5l3.5 3.5L9 9.5" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'

  const grip = embedResizeGrip()
  host.append(img, change, source, grip)

  /* Keep the editor's caret where it is until the click selects the exact
     source range below. Otherwise mousedown first moves it to whichever side
     of the replacement CodeMirror happens to hit-test. */
  change.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  change.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const range = embedRangeAtDOM(view, host)
    if (range) openEmbedPicker(view, range.from, range.to)
  })

  /* Same for the source reveal: keep the caret put until the click selects
     the exact range below. */
  source.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  source.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    revealEmbedSource(view, host)
  })

  wireEmbedResize(grip, {
    image: img,
    host,
    /* No wider than the column it sits in: past that a CSS cap holds the
       picture still while the number in the note keeps growing, which reads as
       a dead drag. */
    limit: () => {
      const line = host.closest('.cm-line')
      if (!line) return Infinity
      const style = getComputedStyle(line)
      return line.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0)
    },
    commit: (width) => commitEmbedWidth(view, host, width),
    // A picture that changed height changed the height of its line with it.
    settle: () => view.requestMeasure()
  })

  return host
}

/** The embed under one image widget, as absolute document positions. */
function embedRangeAtDOM (view, host) {
  const pos = view.posAtDOM(host)
  if (pos == null || pos < 0) return null
  const line = view.state.doc.lineAt(pos)
  const at = pos - line.from
  const embed = findEmbeds(line.text).find((entry) => entry.from <= at && at < entry.to)
  return embed
    ? { from: line.from + embed.from, to: line.from + embed.to, embed }
    : null
}

/** Replace the picture with, and select, the exact Markdown that produced it. */
function revealEmbedSource (view, host) {
  const range = embedRangeAtDOM(view, host)
  if (!range) return
  view.dispatch({
    selection: EditorSelection.range(range.from, range.to),
    effects: embedSourceEffect.of({ from: range.from, to: range.to }),
    scrollIntoView: true
  })
  view.focus()
}

/**
 * Show the reader the equation a reference points at.
 *
 * The caret is deliberately left where it is. A rendered equation gives up its
 * source when the caret enters it, so selecting the label — which is what a
 * click on `\eqref{clt}` used to do — replaced the very thing the reference was
 * asking to be shown with the TeX that draws it. Scrolling to the equation and
 * washing it in the accent colour says where it is and leaves it standing; it
 * is also exactly what the reading view does with the same click, which is the
 * point (see `revealAnchorTarget` in src/links.js).
 */
function revealEquation (view, label) {
  const at = view.state.doc.toString().indexOf(`\\label{${label}}`)
  if (at === -1) return
  view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) })
  /* The widget exists only once CodeMirror has drawn the line carrying it, and
     a moment ago that line may have been outside the viewport entirely — so
     the element is looked for after the scroll, not before it. */
  view.requestMeasure({
    read: () => view.dom.querySelector(`[data-equation="${CSS.escape(label)}"]`),
    write: (found) => flashTarget(found)
  })
}

/**
 * Show the reader the other end of a footnote.
 *
 * The same move as `revealEquation`, for the same reason: a marker asks where
 * its note is, and the answer is to put it on screen and wash it in the accent
 * colour rather than to move the caret there. Clicking `[^1]` goes down to the
 * definition; clicking the definition goes back up to the first marker, which
 * is what the reading view's back-arrow does.
 */
function revealFootnote (view, id, { toDefinition }) {
  const text = view.state.doc.toString()
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  /* A definition is `[^id]:` at the head of a line; a marker is the same span
     anywhere else. Written as one regex so the two searches cannot drift. */
  const pattern = toDefinition
    ? new RegExp(`^\\[\\^${escaped}\\]:`, 'm')
    : new RegExp(`(?<!^)\\[\\^${escaped}\\]|^\\[\\^${escaped}\\](?!:)`, 'm')
  const at = text.search(pattern)
  if (at === -1) return
  view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) })
  const selector = toDefinition
    ? `[data-footnote-def="${CSS.escape(id)}"]`
    : `[data-footnote-ref="${CSS.escape(id)}"]`
  /* Looked for after the scroll, not before it: the line carrying the mark may
     have been outside the viewport, in which case CodeMirror had not drawn it.
     A marker can appear more than once, so the one nearest the scroll target
     wins rather than whichever the document holds first. */
  view.requestMeasure({
    read: () => {
      const found = [...view.dom.querySelectorAll(selector)]
      if (found.length < 2) return found[0] || null
      return found.reduce((best, el) => {
        const pos = view.posAtDOM(el)
        return Math.abs(pos - at) < Math.abs(view.posAtDOM(best) - at) ? el : best
      })
    },
    write: (found) => flashTarget(found)
  })
}

/**
 * Rewrite the embed standing under `host` with a new width. The document
 * position is asked for at commit time, not captured at build time — edits
 * above the picture move it, and a stale offset would rewrite someone else's
 * text.
 */
function commitEmbedWidth (view, host, width) {
  const range = embedRangeAtDOM(view, host)
  if (!range) return
  view.dispatch({
    changes: {
      from: range.from,
      to: range.to,
      insert: withEmbedSize(range.embed, width)
    },
    userEvent: 'input'
  })
}

/* The kind-mark standing where `[!warning]` was written. It carries the icon
   the reading view draws and nothing else — the title after it is the author's
   own text and stays exactly as typed. */
class CalloutIconWidget extends WidgetType {
  constructor (kind) { super(); this.kind = kind }
  eq (other) { return other.kind.id === this.kind.id }
  toDOM () {
    const host = document.createElement('span')
    host.className = `tk-callout-mark is-${this.kind.tone}`
    host.title = this.kind.label
    host.append(calloutIcon(this.kind))
    return host
  }
  ignoreEvent () { return true }
}

/** The disclosure beside a heading. CodeMirror owns the folded range; this
 *  widget only presents the direct control for it. */
class HeadingFoldWidget extends WidgetType {
  constructor (range, folded) {
    super()
    this.range = range
    this.folded = folded
  }
  eq (other) {
    return other.folded === this.folded &&
      other.range.from === this.range.from &&
      other.range.to === this.range.to
  }
  toDOM (view) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tk-heading-fold'
    button.innerHTML =
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3.5 4.5 2.5 3 2.5-3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    button.classList.toggle('is-folded', this.folded)
    button.setAttribute('aria-expanded', String(!this.folded))
    button.setAttribute('aria-label', this.folded ? 'Expand section' : 'Fold section')
    button.title = this.folded ? 'Expand section' : 'Fold section'
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({
        effects: (this.folded ? unfoldEffect : foldEffect).of(this.range)
      })
    })
    return button
  }
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

/* An ordered item's number, drawn as a small accent-coloured circle — the
   same rendering the reading view builds from the list-item counter, so the
   two views agree on what a numbered list looks like. */
class OrderedMarkWidget extends WidgetType {
  constructor (num) { super(); this.num = num }
  eq (other) { return other.num === this.num }
  toDOM () {
    const dot = document.createElement('span')
    dot.className = 'tk-olnum'
    dot.textContent = this.num
    return dot
  }
}

class EquationRefWidget extends WidgetType {
  constructor (label, shown) {
    super()
    this.label = label
    this.shown = shown
  }

  eq (other) { return other.label === this.label && other.shown === this.shown }

  toDOM () {
    const link = document.createElement('a')
    link.className = 'tk-eq-ref'
    link.dataset.equationRef = this.label
    link.textContent = this.shown
    link.href = `#eq-${encodeURIComponent(this.label).replaceAll('%', '_')}`
    return link
  }

  ignoreEvent () { return false }
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

/* Every line a selection touches shows its raw markup, not just the line the
   head landed on: selecting two list items and getting source for one of them
   and prose for the other reads as a bug, because nothing about the selection
   marks the two lines as different.

   This span used to be narrowed to the head alone, because expanding it made a
   drag through a long note progressively replace the selected region with
   source: link targets wrapped, line heights changed under the pointer, and the
   next mouse event was hit-tested against a document that had moved. That is
   fixed at its cause instead — see the plugin's pointer guard below, which
   holds the rebuild until the button comes up, so no drag ever runs against
   geometry that is shifting underneath it.

   Spans rather than a set of line numbers, because ⌘A is a selection too: a set
   would hold an entry per line of the note and be re-joined into a signature on
   every selection change. */
function selectionLines (state) {
  const spans = []
  for (const r of state.selection.ranges) {
    spans.push([state.doc.lineAt(r.from).number, state.doc.lineAt(r.to).number])
  }
  return {
    has: (n) => spans.some(([a, b]) => n >= a && n <= b),
    signature: spans.map(([a, b]) => `${a}-${b}`).join(',')
  }
}

/* Is everything between two positions concealed — not merely overlapped by a
   hidden range, but covered end to end, with no visible character left in the
   gap? `between` walks the set in order and hands back every range that touches
   the span, including one that began before it, so the test is whether the
   covered edge ever falls short of where the next range starts. */
function fullyHidden (hidden, from, to) {
  if (to <= from) return false
  let edge = from
  hidden.between(from, to, (a, b) => {
    if (a > edge) return false
    if (b > edge) edge = b
  })
  return edge >= to
}

/**
 * A selection drawn over a rendered line meant "everything I could see". The
 * moment the line opens up, the characters that were concealed appear inside
 * the span it was drawn across — so dragging to the end of `- [6.5 Struct]`
 * left `(#6.5%20Struct)` unselected, on a line the user had selected to the end
 * of, and the highlight stopped in the middle of what was now one link.
 *
 * So each end is carried out over the run it was resting against, but only when
 * that run is concealed the whole way to the line's edge: a selection that
 * stops among visible words stops exactly where it was put.
 *
 * Returns null when nothing moved, which is the ordinary case — the dispatch
 * then carries the reveal alone rather than a selection change that reads as
 * one in the history.
 */
function widenOverHidden (state, hidden) {
  let moved = false
  const ranges = state.selection.ranges.map((r) => {
    if (r.empty) return r
    const first = state.doc.lineAt(r.from)
    const last = state.doc.lineAt(r.to)
    const from = fullyHidden(hidden, first.from, r.from) ? first.from : r.from
    const to = fullyHidden(hidden, r.to, last.to) ? last.to : r.to
    if (from === r.from && to === r.to) return r
    moved = true
    // The direction is the user's, and reversing it would send the next
    // shift-arrow back over the text they just selected.
    return r.anchor <= r.head
      ? EditorSelection.range(from, to)
      : EditorSelection.range(to, from)
  })
  return moved ? EditorSelection.create(ranges, state.selection.mainIndex) : null
}

/** The source range beneath one heading, stopping before its next peer. */
function headingFoldRange (state, heading, list) {
  let last = state.doc.lines
  for (const next of list) {
    if (next.line > heading.line && next.level <= heading.level) {
      last = next.line - 1
      break
    }
  }
  if (last <= heading.line) return null
  const from = state.doc.line(heading.line).to
  const to = state.doc.line(last).to
  return to > from ? { from, to } : null
}

const foldedExactly = (state, range) => {
  let found = false
  foldedRanges(state).between(range.from, range.from, (from, to) => {
    if (from === range.from && to === range.to) found = true
  })
  return found
}

/** Let CodeMirror's fold commands and state use Markdown heading sections. */
const headingFoldService = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const list = headingsFor(state.doc)
  const heading = list.find((entry) => entry.line === line.number)
  return heading ? headingFoldRange(state, heading, list) : null
})

/**
 * Decorations are rebuilt from the visible ranges on every relevant update.
 * Markup is hidden unless the cursor sits on that line — the line you are
 * editing always shows its true source, everything else reads as prose.
 */
function buildDecorations (view, imageSource = null) {
  const { state } = view
  const ranges = []
  const hidden = []

  const activeLines = selectionLines(state)
  /* All three of these used to be computed here, from a fresh
     `state.doc.toString()`, on every rebuild — and a rebuild happens on every
     keystroke *and* every scroll. That is a copy of the whole note, a
     line-by-line heading scan, and a character-by-character maths scan, before
     any of the visible-range work below begins. They are facts about the
     document rather than about the viewport, so each is now asked of a cache
     keyed on the document itself and computed at most once per version.

     The equations are lazier still. They are wanted only by the `\eqref`
     branch far below, which most notes never reach, so the index is not built
     unless something asks for it. */
  const documentHeadings = headingsFor(state.doc)
  let equationCache = null
  const equations = () => (equationCache ||= equationsFor(state.doc))

  const isActive = (pos) => activeLines.has(state.doc.lineAt(pos).number)

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
          /* Code is not prose, so the platform's spelling checker is turned off
             over it — otherwise every identifier in a `ripgrep` or a `useState`
             is underlined as a mistake. Fenced blocks are also covered by a
             line decoration further down, which catches the blank lines inside
             them; this covers inline spans, indented blocks, and the fences'
             own text. */
          ranges.push(
            Decoration.mark({ attributes: { spellcheck: 'false' } })
              .range(node.from, node.to)
          )
          // The whole span is claimed, so its interior — the block's own
          // language tokens, the densest part of the tree — need not be walked.
          return false
        }
      }
    })
  }
  /* `codeRanges` is finished before the first question is asked of it, and the
     tree is walked in document order over ascending viewport ranges — so it is
     sorted, and the spans do not overlap, because a fence's interior is never
     descended into. That is enough to answer by bisection instead of scanning:
     the last span starting before `to` is the only one that can reach `from`.

     The two lists below stay linear on purpose. They are appended to *between*
     queries, so keeping them sorted would cost an insertion for every claim and
     give the scan back what the search saved. */
  const inCode = (from, to) => {
    let lo = 0
    let hi = codeRanges.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (codeRanges[mid][0] < to) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && codeRanges[lo - 1][1] > from
  }

  /* Wikilinks run next. lezer parses [[Note]] as a regular link, so if the main
     tree pass went first it would hide the brackets as LinkMarks and this pass
     would find nothing left to claim. */
  const claimed = []
  const isClaimed = (from, to) => claimed.some(([a, b]) => from < b && to > a)

  /* Embeds come first of all, because `![[picture.png]]` contains a perfectly
     good wikilink and the pass below would otherwise render the `[[…]]` half of
     it as a link, leaving a stray `!` in front. Claiming the whole match here
     settles which of the two it is. */
  const resolve = state.facet(tableAssetResolver)
  const resolveNote = state.facet(embedNoteResolver)

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

        /* An embed with no target is the slash placeholder — `![[ ]]`, the
           chip the slash key leaves behind. It is an instruction to choose,
           not a missing picture, so the live preview stays off it; the slash
           module's own field draws the chip. Claimed so the brackets are not
           decorated as a link underneath it. */
        if (!embed.src.trim()) continue

        const spec = specForEmbed(embed, { resolve, resolveNote })
        if (spec.kind === 'image' &&
            imageSource?.from === start && imageSource?.to === end) continue
        /* A picture keeps its geometry while the caret passes its line. Turning
           a full-width image into one short source line and back made the whole
           document collapse and expand under the pointer. Raw view remains the
           place to edit an image's Markdown target; live Editing view keeps the
           picture stable. A transclusion is taller still, so it holds its
           ground on the same reasoning. Other embed kinds keep the existing
           active-line source behaviour. */
        if (active && spec.kind !== 'image' && spec.kind !== 'note') continue

        /* A YouTube embed starts as a poster card and only becomes a guest
           after its own Play click, so it is no more of a wall to edit around
           than a local video. General web pages and PDFs are live guests from
           the outset and still stay as source in Editing view. */
        if (spec.kind === 'web' || spec.kind === 'pdf') continue

        /* Whether the picture is the whole line — a figure, standing on a line
           of its own — or one of several, which is how a row of badges is
           written. What may remain beside it is furniture: indentation, a
           bullet, a quote mark, or the brackets of the link a badge sits in.
           The reading view asks the same of a paragraph; see `standsAlone` in
           src/renderer.js. */
        const figure = LINE_FURNITURE.test(
          line.text.slice(0, embed.from) + line.text.slice(embed.to))

        ranges.push(Decoration.replace({ widget: new EmbedWidget(spec, figure) }).range(start, end))
        hidden.push([start, end])
      }

      /* Footnotes are claimed here, before the tree pass, for the same reason
         wikilinks are: a note that defines `[^1]:` at the foot makes `[^1]`
         above it a valid shortcut reference link, so lezer parses it as a Link
         and the pass below would hide its brackets as LinkMarks. Claiming the
         span settles that it is a footnote, and marks it as one. */
      for (const m of line.text.matchAll(/\[\^[^\]\s]+\]/g)) {
        const start = line.from + m.index
        const end = start + m[0].length
        if (inCode(start, end) || isClaimed(start, end)) continue
        claimed.push([start, end])
        // `[^1]:` at the head of a line is the definition, which is a label
        // rather than a reference and should not be lifted into superscript.
        const definition = m.index === 0 && line.text[m.index + m[0].length] === ':'
        const id = m[0].slice(2, -1)
        ranges.push(
          Decoration.mark({
            class: definition ? 'tk-footnote-def' : 'tk-footnote',
            /* The id rides on the mark so a click can find the other end of the
               pair without re-reading the document under the mouse. */
            attributes: definition ? { 'data-footnote-def': id } : { 'data-footnote-ref': id }
          }).range(start, end)
        )
      }

      for (const cite of findCitations(line.text)) {
        const start = line.from + cite.from
        const end = line.from + cite.to
        if (inCode(start, end) || isClaimed(start, end)) continue
        claimed.push([start, end])
        ranges.push(Decoration.mark({ class: 'tk-citation' }).range(start, end))
      }

      for (const m of line.text.matchAll(/\\(eqref|ref)\{([^{}\n]+)\}/g)) {
        const start = line.from + m.index
        const end = start + m[0].length
        if (inCode(start, end) || isClaimed(start, end)) continue
        claimed.push([start, end])
        const label = m[2].trim()
        if (active) {
          ranges.push(
            Decoration.mark({
              class: 'tk-eq-ref-source',
              attributes: { 'data-equation-ref': label }
            }).range(start, end)
          )
        } else {
          const tag = equations().get(label)?.tag || label
          ranges.push(
            Decoration.replace({
              widget: new EquationRefWidget(label, m[1] === 'eqref' ? `(${tag})` : tag)
            }).range(start, end)
          )
          hidden.push([start, end])
        }
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

  /* What has already been decorated, for the nodes that span more than a line.
     The tree is walked once per visible range, and a range boundary falls
     wherever a block widget stands — a displayed `$$…$$` is one — so a quote
     with maths in it is entered once for the part above and once for the part
     below. Everything it draws was then drawn twice: two line decorations per
     line (the class arrived doubled), and two callout icons on its title. */
  const painted = new Set()
  const once = (node) => {
    const key = `${node.name}@${node.from}`
    if (painted.has(key)) return false
    painted.add(key)
    return true
  }

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name

        /* Clicking into a code span shows its source, the way clicking into
           bold or italic shows the asterisks. The backticks come back on their
           own — CodeMark is in HIDDEN_MARKS, which already spares the active
           line — but the chip around them did not, so a span you were editing
           was still drawn as a rendered pill with the markup sitting inside it.
           This undoes the pill for as long as the caret is on the line. The
           highlighter paints .tk-inline-code from the syntax tag and cannot be
           told about the selection, so the class is layered over the top. */
        if (name === 'InlineCode' && isActive(node.from)) {
          ranges.push(Decoration.mark({ class: 'tk-code-raw' }).range(node.from, node.to))
          return
        }

        const heading = HEADING.exec(name)
        if (heading) {
          const line = state.doc.lineAt(node.from)
          const entry = documentHeadings.find((item) => item.line === line.number)
          const fold = entry && headingFoldRange(state, entry, documentHeadings)
          const folded = fold ? foldedExactly(state, fold) : false
          ranges.push(
            Decoration.line({
              class: `tk-h${heading[1]}${folded ? ' is-heading-collapsed' : ''}`
            }).range(line.from)
          )
          if (fold) {
            ranges.push(
              Decoration.widget({
                widget: new HeadingFoldWidget(fold, folded),
                side: -1
              }).range(line.from)
            )
          }
          return
        }

        if (name === 'Blockquote') {
          /* A quote inside a quote is already painted. The enclosing blockquote
             decorated every line between its own ends, this one included, so
             descending would put a second set of edges partway down the bubble
             — a seam across the middle of it, where the reader sees one quote.
             Skipping the whole node keeps it one shape. */
          for (let up = node.node.parent; up; up = up.parent) {
            if (up.name === 'Blockquote') return false
          }
          /* And once per quote, however many visible ranges it is split across.
             `return`, not `return false`: the quote's own decorations are all
             drawn on the first visit, but its children have not been — a fence
             or a nested quote below the split still has to be entered, and
             refusing to descend here was the fence inside a callout losing its
             block entirely.

             Named `once` rather than `first`, which the branch below declares
             for the quote's own first line: a const shadowing it in this block
             is not merely a shadow at the point of this call, it is a temporal
             dead zone and a ReferenceError that takes every decoration in the
             document down with it. */
          if (!once(node)) return

          /* A blockquote whose first line names a kind is a callout, not a
             quotation — see src/callouts.js, which the reading view reads the
             same table from. The marker is hidden the way every other piece of
             markup here is: everywhere except the line you are editing. */
          const opening = state.doc.lineAt(node.from)
          const prefix = /^[ \t]*(?:>[ \t]?)+/.exec(opening.text)?.[0] || ''
          const body = opening.text.slice(prefix.length)
          const head = calloutHead(body)

          const first = opening.number
          const last = state.doc.lineAt(node.to).number

          for (let n = first; n <= last; n++) {
            const line = state.doc.line(n)
            if (!head) {
              /* The ends are marked so the quote can be drawn as one shape
                 rather than a stack of bands — the top line carries the
                 rounded top, the bottom line the tail. A one-line quote is
                 both at once. Same arrangement as a callout's edges below. */
              const edge = (n === first ? ' tk-quote-top' : '') +
                           (n === last ? ' tk-quote-bottom' : '')
              ranges.push(Decoration.line({ class: `tk-quote${edge}` }).range(line.from))
              continue
            }
            const edge = (n === first ? ' tk-callout-top' : '') +
                         (n === last ? ' tk-callout-bottom' : '')
            ranges.push(
              Decoration.line({ class: `tk-callout is-${head.kind.tone}${edge}` }).range(line.from)
            )
          }

          if (head && !activeLines.has(first)) {
            // The offsets are measured off the raw line rather than the trimmed
            // copy the matcher was handed, or a callout written with a space
            // after its `>` would hide one character too few.
            const lead = body.length - body.trimStart().length
            const markFrom = opening.from + prefix.length + lead
            ranges.push(
              Decoration.widget({ widget: new CalloutIconWidget(head.kind), side: -1 })
                .range(markFrom)
            )
            hide(markFrom, markFrom + head.markLength)

            /* The title, set as the label the reading view sets it as — the
               kind's colour, the app's sans, a size down. It is still the
               author's own characters, marked rather than replaced, so it
               reverts to plain text the moment the caret arrives on the line.
               Without this the head read at exactly the weight of the body
               under it, and the two views disagreed about what a callout is. */
            const titleFrom = markFrom + head.markLength
            if (titleFrom < opening.to) {
              ranges.push(
                Decoration.mark({ class: `tk-callout-label is-${head.kind.tone}` })
                  .range(titleFrom, opening.to)
              )
            }
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
              // Nothing in a fence is prose, so nothing in one is misspelled:
              // the checker underlines every identifier in the block otherwise.
              Decoration.line({
                class: `tk-code-block${edge}`,
                attributes: { spellcheck: 'false' }
              }).range(state.doc.line(n).from)
            )
          }
          return
        }

        if (name === 'HorizontalRule' && !isActive(node.from)) {
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
          // A finished task reads as finished, not just as a ticked box. The
          // rule is drawn over the task's own words and nothing else: as a line
          // decoration it covered the whole line box, and a nested item's
          // leading indent is part of that — a stroke hanging in the margin to
          // the left of the checkbox, attached to nothing.
          if (/[xX]/.test(text)) {
            const line = state.doc.lineAt(node.from)
            let from = node.to
            while (from < line.to && state.doc.sliceString(from, from + 1) === ' ') from++
            if (from < line.to) {
              ranges.push(Decoration.mark({ class: 'tk-done' }).range(from, line.to))
            }
          }
          return
        }

        /* The fence's language gets a tile. On the line you are editing the raw
           token stays put — you cannot retype what you cannot see — everywhere
           else the chip stands in for it. */
        if (name === 'CodeInfo') {
          const full = state.doc.sliceString(node.from, node.to).trim()
          const info = full.split(/\s+/)[0]
          // Everything after the language travels with the chip: a manim
          // block names its scene there, and the reading view shows it too.
          const rest = full.slice(info.length).trim()
          // On the line being edited the fence is just text: ```python, plain,
          // with nothing standing beside it. A chip there competes with the
          // token it is meant to replace.
          if (isActive(node.from)) return

          ranges.push(
            Decoration.widget({ widget: new LangChipWidget(info, true, rest), side: -1 })
              .range(node.from)
          )
          hide(node.from, node.to)
          return
        }

        if (isActive(node.from)) return

        if (name === 'ListMark') {
          const mark = state.doc.sliceString(node.from, node.to)
          const number = /^\d+/.exec(mark)
          if (number) {
            ranges.push(
              Decoration.replace({ widget: new OrderedMarkWidget(number[0]) })
                .range(node.from, node.to)
            )
            hidden.push([node.from, node.to])
            return
          }
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

  /* Inline highlights and block IDs are plain text to Lezer, so the shared
     scanners claim their delimiters after the syntax-tree pass. */
  for (const { from, to } of view.visibleRanges) {
    const startLine = state.doc.lineAt(from).number
    const endLine = state.doc.lineAt(to).number

    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n)
      const active = activeLines.has(n)

      for (const mark of findInlineHighlights(line.text)) {
        const start = line.from + mark.from
        const contentFrom = line.from + mark.contentFrom
        const contentTo = line.from + mark.contentTo
        const end = line.from + mark.to
        if (inCode(start, end) ||
            isClaimed(start, contentFrom) ||
            isClaimed(contentTo, end)) continue

        ranges.push(Decoration.mark({ class: 'tk-highlight' }).range(contentFrom, contentTo))
        if (active) {
          ranges.push(Decoration.mark({ class: 'tk-mark' }).range(start, contentFrom))
          ranges.push(Decoration.mark({ class: 'tk-mark' }).range(contentTo, end))
        } else {
          hide(start, contentFrom)
          hide(contentTo, end)
        }
      }

      const block = blockReferenceOnLine(line.text)
      if (block) {
        const start = line.from + block.from
        const marker = line.from + block.markerFrom
        const end = line.from + block.to
        /* A block ID stays on screen whether or not the caret is on its line.
           Every other mark here is punctuation around text you can already
           see, so hiding it costs nothing — but this one *is* the content: it
           is the address other notes link to, and an address that appears only
           when you happen to click the line is one you cannot find, check for
           collisions, or copy without hunting. It is set small and faint (see
           .tk-block-id), which is enough to keep it out of the way of the
           prose it names. */
        if (!inCode(start, end) && !isClaimed(start, end)) {
          ranges.push(Decoration.mark({ class: 'tk-block-id' }).range(marker, end))
        }
      }

      for (const m of line.text.matchAll(/(^|\s)(#[\p{L}\p{N}][\p{L}\p{N}/_-]*)/gu)) {
        const start = line.from + m.index + m[1].length
        const end = start + m[2].length
        if (insideHidden(start, end) || isClaimed(start, end) || inCode(start, end)) continue
        // A heading's '#' is followed by a space, so it never matches here.
        ranges.push(Decoration.mark({ class: 'tk-tag' }).range(start, end))
      }

    }
  }

  return {
    decorations: Decoration.set(ranges, true),
    /* Only what conceals text is atomic. A mark leaves its characters visible
       and editable, so the caret has to be able to walk through them — with
       the whole set atomic, one Backspace after a tag ate the tag. `hidden`
       already lists exactly the concealed spans. */
    atomic: Decoration.set(hidden.map(([a, b]) => Decoration.replace({}).range(a, b)), true),
    active: activeLines.signature
  }
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor (view) {
      this.timer = null
      this.imageSource = null
      /* A selection being dragged out is the one case where re-rendering the
         selected lines is actively harmful: swapping them to source changes
         their height and wrapping, and the drag's next mouse event is then
         hit-tested against a document that moved under the pointer. So the
         rebuild waits for the button, and `held` remembers that one is owed.

         pointerdown on the editor, pointerup on the window: a drag that ends
         past the pane's edge still ends. */
      this.dragging = false
      this.held = false
      this.onDown = () => { this.dragging = true }
      this.onUp = () => {
        if (!this.dragging) return
        this.dragging = false
        if (!this.held) return
        this.held = false
        this.settle(view)
      }
      view.dom.addEventListener('pointerdown', this.onDown)
      window.addEventListener('pointerup', this.onUp)
      this.detach = () => {
        view.dom.removeEventListener('pointerdown', this.onDown)
        window.removeEventListener('pointerup', this.onUp)
      }
      Object.assign(this, buildDecorations(view, this.imageSource))
    }

    cancel () {
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
    }

    settle (view) {
      this.cancel()
      if (this.dragging) { this.held = true; return }
      this.timer = setTimeout(() => {
        this.timer = null
        /* Measured against the decorations still on screen — `this.atomic` is
           the set that concealed the text, and the rebuild this dispatch
           triggers is what takes it away. */
        const selection = widenOverHidden(view.state, this.atomic)
        view.dispatch({
          ...(selection ? { selection } : {}),
          effects: selectionRevealEffect.of(null)
        })
      }, 50)
    }

    update (update) {
      /* Keep an opened image range attached to its text while that source is
         edited. A note switch moves the selection elsewhere and clears it
         below, so the range can never leak into the next document. */
      if (this.imageSource && update.docChanged) {
        for (const tr of update.transactions) {
          this.imageSource = {
            from: tr.changes.mapPos(this.imageSource.from, -1),
            to: tr.changes.mapPos(this.imageSource.to, 1)
          }
        }
      }

      // A refresh means something the decorations read from *outside* the
      // document moved — the note's name, or the list of attachments an embed
      // resolves against. Nothing in the update itself would show that.
      const refreshed = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshEffect)))
      const settled = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(selectionRevealEffect)))
      const sourceEffect = update.transactions
        .flatMap((tr) => tr.effects)
        .find((effect) => effect.is(embedSourceEffect))
      const foldChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)))

      if (sourceEffect) {
        this.cancel()
        this.imageSource = sourceEffect.value
        Object.assign(this, buildDecorations(update.view, this.imageSource))
        return
      }

      if (this.imageSource && update.selectionSet) {
        const selected = update.state.selection.ranges.some(
          (range) => range.to >= this.imageSource.from && range.from <= this.imageSource.to
        )
        if (!selected) this.imageSource = null
      }

      if (refreshed || foldChanged || update.docChanged || update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.cancel()
        Object.assign(this, buildDecorations(update.view, this.imageSource))
      } else if (settled) {
        Object.assign(this, buildDecorations(update.view, this.imageSource))
      } else if (update.selectionSet) {
        const next = selectionLines(update.state).signature
        if (this.active === next) {
          this.cancel()
          this.held = false
          return
        }
        /* Do not swap a rendered line to source for every intermediate point
           in a drag or key-repeat run. A real edit takes the immediate branch
           above, so clicking and typing before this short settle still reveals
           the correct line before the document changes. */
        this.settle(update.view)
      }
    }

    destroy () {
      this.cancel()
      this.detach()
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: () =>
      EditorView.atomicRanges.of((view) => view.plugin(livePreview)?.atomic ?? Decoration.none)
  }
)

/* ------------------------------------------------------------ the title */

/* The title lives outside the document, so nothing in an ordinary update tells
   the plugin it changed. A rename dispatches this instead. */
const refreshEffect = StateEffect.define()
/* Selection-only motion is allowed to settle before live markup follows it.
   Kept separate from refreshEffect: an attachment/title refresh is never safe
   to delay, while a cursor passing through intermediate lines is. */
const selectionRevealEffect = StateEffect.define()

/**
 * Kept apart from the live preview: the name of the note belongs at the top of
 * the page in every view, including the raw one.
 *
 * A state field rather than a view plugin — CodeMirror refuses block
 * decorations from plugins, because a plugin cannot be consulted before the
 * viewport it would change has been measured.
 */
function titleFor (noteTitle, onRename, noteFlag, titleEditable) {
  const build = () => {
    const text = noteTitle?.()
    if (!text) return Decoration.none
    return Decoration.set([
      Decoration.widget({
        widget: new TitleWidget(
          text,
          onRename,
          noteFlag?.() || '',
          titleEditable?.() !== false
        ),
        block: true,
        side: -1
      })
        .range(0)
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

/* -------------------------------------------------- the copilot's edits */

/* Marks the span the copilot just rewrote, so a change arriving from outside
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

/* The inline review is presentation only and never enters the document or
   undo history. It remains until the Copilot review is explicitly accepted,
   so leaving the note or continuing to type cannot silently dismiss it. */
const agentDiffEffect = StateEffect.define() // { before, after } | null

class AgentDeletedWidget extends WidgetType {
  constructor (rows) { super(); this.rows = rows } // [{ text, pieces }]

  eq (other) {
    const samePieces = (a, b) => (a == null || b == null)
      ? a == b
      : a.length === b.length &&
        a.every((piece, i) => piece.text === b[i].text && piece.changed === b[i].changed)
    return other.rows.length === this.rows.length &&
      this.rows.every((row, i) =>
        row.text === other.rows[i].text && samePieces(row.pieces, other.rows[i].pieces))
  }

  toDOM () {
    const block = document.createElement('div')
    block.className = 'cm-agent-deleted'
    block.contentEditable = 'false'
    block.setAttribute('aria-label', 'Text removed by Copilot')
    for (const row of this.rows) {
      const line = document.createElement('div')
      line.className = 'cm-agent-deleted-line'
      const mark = document.createElement('span')
      mark.className = 'cm-agent-diff-mark'
      mark.textContent = '−'
      const text = document.createElement('span')
      /* On a line the copilot rewrote rather than removed from nothing, the
         words that actually moved take a deeper colour; a fully removed line
         keeps the row's flat tint. */
      if (row.pieces) {
        for (const piece of row.pieces) {
          if (!piece.changed) { text.append(piece.text); continue }
          const moved = document.createElement('span')
          moved.className = 'cm-agent-word-removed'
          moved.textContent = piece.text
          text.append(moved)
        }
      } else {
        text.textContent = row.text || ' '
      }
      line.append(mark, text)
      block.append(line)
    }
    return block
  }
  ignoreEvent () { return true }
}

function buildAgentDiff (state, change) {
  if (!change || change.before === change.after) return Decoration.none
  const { rows } = fileDiff(change.before, change.after)
  const words = withinLines(rows)
  const decorations = []

  // Added lines are already in the new document, so colour those real lines.
  rows.forEach((row, at) => {
    if (row.kind !== 'add' || row.after == null || row.after < 1 || row.after > state.doc.lines) return
    const line = state.doc.line(row.after)
    decorations.push(Decoration.line({ class: 'cm-agent-added-line' }).range(line.from))
    let caret = line.from
    for (const piece of words.get(at) || []) {
      const end = Math.min(caret + piece.text.length, line.to)
      if (piece.changed && end > caret) {
        decorations.push(Decoration.mark({ class: 'cm-agent-word-added' }).range(caret, end))
      }
      caret = end
    }
  })

  /* A run of deleted lines sits immediately before the next surviving/added
     line, or at the end of the document. This is the old half of the diff,
     drawn as a widget so copying or saving still sees only the new Markdown. */
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== 'del') { i++; continue }
    const removed = []
    while (i < rows.length && rows[i].kind === 'del') {
      removed.push({ text: rows[i].text, pieces: words.get(i) || null })
      i++
    }
    const next = rows.slice(i).find((row) => row.after != null)
    const at = next && next.after <= state.doc.lines
      ? state.doc.line(next.after).from
      : state.doc.length
    decorations.push(Decoration.widget({
      widget: new AgentDeletedWidget(removed),
      block: true,
      side: -1
    }).range(at))
  }

  return Decoration.set(decorations, true)
}

const agentDiff = StateField.define({
  create: () => Decoration.none,
  update (deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(agentDiffEffect)) return buildAgentDiff(tr.state, effect.value)
    }
    return deco.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})

/* Shown from the moment an Edit tool announces its target until its write
   lands. It points at the work without moving the user's caret or focus. */
const agentWorkingEffect = StateEffect.define() // document position | null
const agentWorking = StateField.define({
  create: () => Decoration.none,
  update (deco, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(agentWorkingEffect)) continue
      if (effect.value == null) return Decoration.none
      const at = Math.max(0, Math.min(effect.value, tr.state.doc.length))
      return Decoration.set([
        Decoration.line({ class: 'cm-agent-working-line' }).range(tr.state.doc.lineAt(at).from)
      ])
    }
    if (tr.docChanged) return Decoration.none
    return deco.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})

/* The file is patched once, then its newly inserted span is uncovered a few
   characters at a time. Keeping this as presentation rather than a stream of
   document transactions is what makes the whole Copilot write one Undo step
   and prevents autosave from ever seeing a half-written replacement. */
const agentTypingEffect = StateEffect.define() // { from, to } | null

class AgentTypingCursor extends WidgetType {
  eq () { return true }
  toDOM () {
    const cursor = document.createElement('span')
    cursor.className = 'cm-agent-typing-cursor'
    cursor.setAttribute('aria-hidden', 'true')
    return cursor
  }
  ignoreEvent () { return true }
}

const agentTyping = StateField.define({
  create: () => Decoration.none,
  update (deco, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(agentTypingEffect)) continue
      if (!effect.value) return Decoration.none
      const from = Math.max(0, Math.min(effect.value.from, tr.state.doc.length))
      const to = Math.max(from, Math.min(effect.value.to, tr.state.doc.length))
      if (to <= from) return Decoration.none
      return Decoration.set([
        Decoration.replace({ widget: new AgentTypingCursor() }).range(from, to)
      ])
    }
    // A real keystroke reveals the complete result. The animation timer sees
    // the same document change and stops before painting another frame.
    if (tr.docChanged) return Decoration.none
    return deco
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
function diffRange (a, b) {
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
   table in the "raw" view would make the view a lie, so they travel together —
   and so do a code block's line numbers, which without the frame around them
   are numbers hanging in the margin of what is meant to be plain text. */
/* The colouring travels with them. Raw view is the file as a text editor with
   no idea what markdown is would show it — leaving bold orange and inline code
   in a box is still an opinion about the markup, and the view's whole claim is
   that it has none. */
const RENDERED = [livePreview, mathPreview, tablePreview, tableCursorGuard, tableSearchHighlight,
                  moneyPreview, runBlocks, propertiesPreview,
                  mermaidBlocks, tikzBlocks, svgBlocks, codeBlockView,
                  headingFoldService, codeFolding({ placeholderText: ' … ' }),
                  keymap.of(foldKeymap),
                  ...slashEmbed]

/* Passing the language list straight to `markdown()` leaves any word it does
   not recognise unparsed, and therefore uncoloured — `manim` among them. The
   reading view resolves the same aliases through the same function. */
const fenceLanguage = (info) => languageFor(info)

/* Built once: `markdown()` assembles a full Language/parser configuration and
   these are reconfigured into every note on open. */
const MD_SOURCE = markdown({ base: markdownLanguage, codeLanguages: fenceLanguage, addKeymap: false })
const TEX_SOURCE = StreamLanguage.define(stex)

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
  // ⌘B belongs to the sidebar, so bold moves one key over.
  { key: 'Mod-Shift-b', run: (v) => wrapSelection(v, '**') },
  { key: 'Mod-i', run: (v) => wrapSelection(v, '*') },
  { key: 'Mod-Shift-x', run: (v) => wrapSelection(v, '~~') },
  { key: 'Mod-e', run: () => true },   // owned by the menu; swallow the default
  { key: 'Mod-k', run: (v) => wrapSelection(v, '[', ']()') },
  // A table is the one construct here that is never shown as source, so it is
  // also the one you cannot start by typing its markup and watching it form.
  { key: 'Mod-Alt-t', run: (v) => insertTable(v) }
]

/* ----------------------------------------------------------- the editor */

export function createEditor ({
  parent, onChange, onOpenLink, noteNames, noteTitle, onRename, resolveEmbed,
  resolveNoteEmbed, languageTable, noteFlag, titleEditable, embedChoices
}) {
  const preview = new Compartment()
  const sourceLanguage = new Compartment()
  const sourceTitle = new Compartment()
  const sourceColor = new Compartment()
  const sourceAttributes = new Compartment()
  let raw = false
  let sourceMode = 'markdown'
  let agentTypingRun = 0
  let agentTypingTimer = 0
  /* Whoever is waiting on the reveal currently running. Cancelling one means
     settling it, not dropping it: the caller has the rest of the edit to finish
     — the review diff to file, the tab to repaint, the tally to report — and a
     promise that never resolves silently abandons all of it. That is how an
     `Edited` row ends up with no diff beside it. */
  let agentTypingDone = null

  const stopAgentTyping = () => {
    agentTypingRun++
    clearTimeout(agentTypingTimer)
    const waiting = agentTypingDone
    agentTypingDone = null
    waiting?.()
  }

  const wikiCompletion = (context) => {
    const before = context.matchBefore(/\[\[[^\]]*/)
    if (!before) return null

    /* `![[` asks for something to stand in the page — an attachment or a
       note — and the slash module answers those keystrokes with its inline
       ghost instead of this tooltip. So the target of an embed never opens
       the note list; the two completions must not both claim the same `[[`. */
    if (context.state.sliceDoc(before.from - 1, before.from) === '!') return null

    /* `[[#` names a heading in this note rather than another note — the one
       target the editor can answer for on its own, since the vault's other
       notes live on the far side of the bridge. */
    if (before.text.startsWith('[[#')) {
      if (before.text.startsWith('[[#^')) {
        const wanted = before.text.slice(4).toLowerCase()
        const options = blockReferences(context.state.doc.toString())
          .filter((block) => block.id.toLowerCase().includes(wanted))
          .slice(0, 40)
          .map((block) => ({
            label: `#^${block.id}`,
            detail: `line ${block.line}`,
            type: 'text'
          }))
        if (!options.length) return null
        return { from: before.from + 2, options, validFor: /^#\^[^\]]*$/ }
      }

      const wanted = before.text.slice(3).toLowerCase()
      const options = headingsFor(context.state.doc)
        .filter((h) => h.text.toLowerCase().includes(wanted))
        .slice(0, 40)
        .map((h) => ({ label: `#${h.text}`, detail: `H${h.level}`, type: 'text' }))
      if (!options.length) return null
      return { from: before.from + 2, options, validFor: /^#[^\]]*$/ }
    }

    const query = before.text.slice(2).toLowerCase()
    const options = noteNames()
      .filter((n) => n.name.toLowerCase().includes(query))
      .slice(0, 40)
      .map((n) => ({ label: n.name, detail: n.detail || n.dir || undefined, type: 'text' }))
    if (!options.length) return null
    return { from: before.from + 2, options, validFor: /^[^\]]*$/ }
  }

  const extensions = [
        history(),
        /* A solid caret: the default 1.2 s blink reads as a flicker. */
        drawSelection({ cursorBlinkRate: 0 }),
        highlightActiveLine(),
        dropCursor(),
        rectangularSelection(),
        indentOnInput(),
        /* One indent level is four spaces — what Tab inserts, what Enter
           inside a fence deepens by, and what Backspace at the head of a code
           line removes (src/codeblock.js reads the same facet). Spaces rather
           than a tab character, so the file reads the same everywhere. */
        indentUnit.of('    '),
        bracketMatching(),
        closeBrackets(),
        /* Configured up front rather than left for `openSearchPanel` to add on
           first use: until the extension is in the state there is no query to
           seed, so the first ⌘F of a session ignored the selection and every
           one after it honoured it. */
        search(findConfig),
        EditorView.lineWrapping,
        sourceLanguage.of(MD_SOURCE),
        sourceTitle.of(titleFor(noteTitle, onRename, noteFlag, titleEditable)),
        sourceColor.of(syntaxHighlighting(highlight)),
        sourceAttributes.of(EditorView.editorAttributes.of({ class: '' })),
        /* A language note is a table editor, not a free-form buffer: the only
           way to write to it is through a cell. Typing, pasting or deleting in
           the source lines around the grid is dropped here, which is what a
           click on the blank line under the table would otherwise reach.

           Untagged transactions pass untouched — `view.patch` carries no
           userEvent, and it is how a change made on disk (a sync client, a
           link rewrite) lands in the open note; an earlier version of this
           filter swallowed those. Cell writes and row controls identify
           themselves as input.table, the copilot as input.agent, tidying as
           input.lint, and undo must stay or a mistaken cell edit is forever. */
        languageTableMode.of(languageTable || (() => false)),
        EditorState.transactionFilter.of((tr) => {
          if (!languageTable?.() || !tr.docChanged) return tr
          const event = tr.annotation(Transaction.userEvent)
          if (!event ||
              event.startsWith('input.table') ||
              event.startsWith('input.agent') ||
              event.startsWith('input.lint') ||
              event === 'undo' || event === 'redo') return tr
          return []
        }),
        // A drawing is filed under the note it belongs to, so the widgets are
        // told which note that is — the same function the title reads.
        tikzNote.of(noteTitle || (() => 'Untitled')),
        agentFlash,
        agentDiff,
        agentWorking,
        agentTyping,
        tableAssetResolver.of(resolveEmbed || (() => null)),
        embedNoteResolver.of(resolveNoteEmbed || (() => null)),
        embedChoicesFacet.of(embedChoices || (() => [])),
        // Raw view empties this compartment: same document, same history, no
        // decorations standing between you and the markup.
        preview.of(RENDERED),
        codeBlockKeymap,
        proseBrackets,
        autocompletion({
          override: [wikiCompletion, fenceLanguages, calloutKinds],
          icons: false
        }),
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
          click (event, view) {
            const el = event.target
            if (!(el instanceof HTMLElement)) return
            const equation = el.dataset.equationRef ||
              el.closest('[data-equation-ref]')?.dataset.equationRef
            if (equation) {
              event.preventDefault()
              /* A transcluded note carries its own copy of the equation, and a
                 reference inside it means that copy — not the one the note
                 doing the transcluding may also have. */
              const inFragment = el.closest('.transclude')
                ?.querySelector(`[data-equation="${CSS.escape(equation)}"]`)
              if (inFragment) {
                inFragment.scrollIntoView({ block: 'center', behavior: 'smooth' })
                flashTarget(inFragment)
                return true
              }
              revealEquation(view, equation)
              return true
            }
            /* A footnote marker is a reference like `\eqref` is, and behaves
               like one: the click says where its note is and leaves the caret
               alone. Inside a transclusion it means that copy's footnote — the
               anchor branch further down handles those. */
            if (!el.closest('.transclude')) {
              const ref = el.dataset.footnoteRef ||
                el.closest('[data-footnote-ref]')?.dataset.footnoteRef
              const def = el.dataset.footnoteDef ||
                el.closest('[data-footnote-def]')?.dataset.footnoteDef
              if (ref || def) {
                event.preventDefault()
                revealFootnote(view, ref || def, { toDefinition: Boolean(ref) })
                return true
              }
            }
            const asset = el.dataset.asset || el.closest('[data-asset]')?.dataset.asset
            if (asset) { onOpenLink({ type: 'asset', target: asset }); return true }
            /* An embed that turned out to be a URL rather than a file. It is a
               real anchor, but nothing in the editor follows anchors, so the
               click is handed over the same way every other link here is.

               A YouTube card is the exception: a plain click on one starts the
               player in place, which the card handles itself, so only the
               modified click — the one that means "not here" — is taken. */
            const card = el.closest('a.embed-yt')
            if (card) {
              if (!(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return
              onOpenLink({ type: 'url', target: card.href })
              return true
            }
            const remote = el.closest('a.embed-link')
            if (remote) { onOpenLink({ type: 'url', target: remote.href }); return true }
            /* A transcluded note carries the reading view's markup — real
               anchors included — into an editor that never had any. Left
               alone, clicking one would navigate the whole window. A web
               address goes to the browser; anything else (a footnote's own
               `#fn1`) is swallowed rather than followed. */
            const anchor = el.closest('a[href]')
            if (anchor && el.closest('.transclude')) {
              event.preventDefault()
              const href = anchor.getAttribute('href') || ''
              if (EXTERNAL_SCHEME.test(href)) onOpenLink({ type: 'url', target: anchor.href })
              return true
            }
            const wiki = el.dataset.wikilink || el.closest('[data-wikilink]')?.dataset.wikilink
            if (wiki) {
              // ⌘-click opens it in a new tab; ⌥-click in the side pane —
              // beside what you are writing rather than over it.
              onOpenLink({
                type: 'wikilink',
                target: wiki,
                newTab: event.metaKey || event.ctrlKey,
                side: event.altKey
              })
              return true
            }
            if (el.classList.contains('tk-link') && (event.metaKey || event.ctrlKey)) {
              const text = el.textContent || ''
              if (/^https?:/.test(text)) { onOpenLink({ type: 'url', target: text }); return true }
            }
          }
        }),
        EditorView.updateListener.of((update) => {
          /* Nothing is handed over: the document is the editor's, and copying
             it out as a string on every keystroke cost a note-sized allocation
             per character for the sake of one status-bar readout. Whoever
             needs the text reads it from the state when they need it. */
          if (update.docChanged) {
            agentTypingRun++
            onChange()
          }
        })
  ]

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: '', extensions })
  })

  /* The selection is not painted on the text — it is a layer of absolutely
     positioned rectangles, measured once and redrawn only when CodeMirror
     believes the geometry moved. CodeMirror watches its scroller for that, and
     the scroller is not what changes here: the writing column is a max-width on
     the content inside it, so turning "Readable line length" off, picking a
     different line width, or dragging a pane divider all reflow the text while
     leaving the scroller exactly the width it was.

     The layer therefore kept rectangles measured against the old column, and a
     selection inside a code block came out overhanging the block it belongs to
     — the band still as wide as the column had been. Watching the content
     element is watching the thing that actually resizes. */
  const columnObserver = new ResizeObserver(() => view.requestMeasure())
  columnObserver.observe(view.contentDOM)
  const destroy = view.destroy.bind(view)
  view.destroy = () => { columnObserver.disconnect(); destroy() }

  const sourceEffects = () => [
    sourceLanguage.reconfigure(sourceMode === 'tex' ? TEX_SOURCE : MD_SOURCE),
    sourceTitle.reconfigure(sourceMode === 'tex'
      ? []
      : titleFor(noteTitle, onRename, noteFlag, titleEditable)),
    sourceColor.reconfigure(raw && sourceMode !== 'tex' ? [] : syntaxHighlighting(highlight)),
    sourceAttributes.reconfigure(EditorView.editorAttributes.of({
      class: sourceMode === 'tex' ? 'is-tex is-raw' : (raw ? 'is-raw' : '')
    })),
    preview.reconfigure(raw || sourceMode === 'tex' ? [] : RENDERED)
  ]

  const markSourceMode = () => {
    view.dom.classList.toggle('is-tex', sourceMode === 'tex')
    view.dom.classList.toggle('is-raw', raw || sourceMode === 'tex')
  }

  /**
   * Each note gets a brand-new state rather than a replacing transaction, so
   * undo can never walk backwards out of this note and into the last one.
   */
  view.setDoc = (text) => {
    stopAgentTyping()
    view.setState(EditorState.create({ doc: text, extensions }))
    // A fresh state resets every compartment to its default, so the source
    // language and raw/live-preview choice have to be put back for this file.
    view.dispatch({ effects: sourceEffects() })
    // CodeMirror rebuilds its root classes with the state. This one is ours,
    // and the Copilot review marks depend on it surviving the note.
    markSourceMode()
    view.contentDOM.spellcheck = sourceMode !== 'tex' && spellcheck
  }

  /** Raw view: the file as it is on disk, monospaced, nothing hidden. */
  view.setRaw = (on) => {
    if (raw === on) return
    raw = on
    view.dispatch({ effects: sourceEffects() })
    markSourceMode()
  }

  /** The file's grammar. TeX is always source; Markdown keeps its three views. */
  view.setSourceMode = (mode) => {
    const next = mode === 'tex' ? 'tex' : 'markdown'
    if (sourceMode === next) return
    sourceMode = next
    view.dispatch({ effects: sourceEffects() })
    markSourceMode()
    view.contentDOM.spellcheck = sourceMode !== 'tex' && spellcheck
  }

  /** Redraw the parts that read from outside the document — the inline title. */
  view.refresh = () => { view.dispatch({ effects: refreshEffect.of(null) }) }

  /** Select the inline filename so a newly created document can be named. */
  view.focusTitle = () => {
    const input = view.dom.querySelector('.tk-title-field:not([readonly])')
    if (!input) return false
    input.focus()
    input.select()
    return true
  }

  /* Spelling is checked by the platform, not by us, so this is a property of
     the editable element rather than an extension. Re-applied after setDoc,
     which builds a fresh state — and therefore a fresh contentDOM. */
  let spellcheck = true
  view.setSpellcheck = (on) => {
    spellcheck = on !== false
    view.contentDOM.spellcheck = sourceMode !== 'tex' && spellcheck
  }

  /**
   * Bring the buffer to `text` as an edit rather than a replacement, and mark
   * what moved. Used when the copilot writes to the note that is open: the
   * caret stays where it was, ⌘Z still walks back through it, and the changed
   * lines remain lit until the Copilot review is accepted.
   */
  let fade = null

  const scrollToAgentEdit = (at) => {
    const pos = Math.max(0, Math.min(at, view.state.doc.length))
    view.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: 'center', yMargin: 80 })
    })
  }

  view.revealAgentEdit = (at) => {
    const pos = Math.max(0, Math.min(at, view.state.doc.length))
    view.dispatch({ effects: [
      agentWorkingEffect.of(pos),
      EditorView.scrollIntoView(pos, { y: 'center', yMargin: 80 })
    ] })
  }

  const showAgentDiff = (before, after) => {
    if (before === after) return false
    const change = diffRange(before, after)
    view.dispatch({ effects: [
      agentDiffEffect.of({ before, after }),
      agentWorkingEffect.of(null)
    ] })
    scrollToAgentEdit(change?.from || 0)
    return true
  }

  view.showAgentDiff = showAgentDiff
  view.clearAgentDiff = () => {
    view.dispatch({ effects: [
      agentDiffEffect.of(null),
      agentWorkingEffect.of(null)
    ] })
  }

  view.patch = (text, { agent = false, before = null } = {}) => {
    const current = view.state.doc.toString()
    const change = diffRange(current, text)
    const baseline = before ?? current
    if (!change) return agent && showAgentDiff(baseline, text)
    view.dispatch({
      changes: change,
      userEvent: agent ? 'input.agent' : undefined,
      effects: agent
        ? [
            agentDiffEffect.of({ before: baseline, after: text }),
            agentWorkingEffect.of(null)
          ]
        : flashEffect.of({ from: change.from, to: change.from + change.insert.length }),
      // The copilot's writing should not steal the page from someone reading
      // elsewhere in it; only a change at the caret follows the caret.
      scrollIntoView: false
    })
    if (agent) {
      scrollToAgentEdit(diffRange(baseline, text)?.from || change.from)
    } else {
      clearTimeout(fade)
      fade = setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1400)
    }
    return true
  }

  /**
   * Patch the real Markdown once, but uncover the inserted text like a cursor
   * moving through it. The returned promise is only the presentation settling;
   * the document transaction has already happened before this function yields.
   */
  view.patchAnimated = async (text, { before = null } = {}) => {
    const current = view.state.doc.toString()
    const change = diffRange(current, text)
    const baseline = before ?? current
    if (!change) return showAgentDiff(baseline, text)

    stopAgentTyping()
    const insertedTo = change.from + change.insert.length
    const glyphEnds = []
    let offset = 0
    for (const glyph of change.insert) {
      offset += glyph.length
      glyphEnds.push(offset)
    }

    view.dispatch({
      changes: change,
      userEvent: 'input.agent',
      effects: glyphEnds.length > 1
        ? agentTypingEffect.of({ from: change.from, to: insertedTo })
        : agentWorkingEffect.of(null),
      scrollIntoView: false
    })
    scrollToAgentEdit(change.from)

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (glyphEnds.length <= 1 || reduced) {
      showAgentDiff(baseline, text)
      return true
    }

    const run = ++agentTypingRun
    const duration = Math.min(4500, Math.max(260, glyphEnds.length * 16))
    const started = performance.now()

    await new Promise((resolve) => {
      agentTypingDone = resolve
      const settle = () => {
        if (agentTypingDone === resolve) agentTypingDone = null
        resolve()
      }
      /* Electron pauses animation frames for an occluded window. A short timer
         keeps a backgrounded edit from remaining concealed until the reader
         returns, while the elapsed-time calculation still skips straight to
         the right point rather than replaying every missed frame. */
      const frame = () => {
        if (run !== agentTypingRun) { settle(); return }
        const now = performance.now()
        const progress = Math.min(1, (now - started) / duration)
        const count = Math.min(glyphEnds.length, Math.floor(progress * glyphEnds.length))
        if (count >= glyphEnds.length) {
          view.dispatch({ effects: agentTypingEffect.of(null) })
          settle()
          return
        }
        const revealed = count ? glyphEnds[count - 1] : 0
        view.dispatch({
          effects: agentTypingEffect.of({ from: change.from + revealed, to: insertedTo })
        })
        agentTypingTimer = setTimeout(frame, 20)
      }
      agentTypingTimer = setTimeout(frame, 20)
    })

    if (run === agentTypingRun) showAgentDiff(baseline, text)
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

  /**
   * The note's own undo, reachable from outside the editor.
   *
   * ⌘Z is on the Edit menu, and a menu key equivalent is taken by the menu
   * before the page ever sees it — so the keymap installed above only answers
   * when something else is holding the keyboard. These are what the menu calls,
   * and they are the same commands, on the same history.
   */
  view.undo = () => undo(view)
  view.redo = () => redo(view)

  /** Give every column in the note back to its content — see fitAllColumns. */
  view.fitAllColumns = () => fitAllColumns(view)

  /** Fold every Markdown heading that owns a section, including nested ones. */
  view.foldAllHeadings = () => {
    const { state } = view
    const list = headingsFor(state.doc)
    const effects = list
      .map((heading) => headingFoldRange(state, heading, list))
      .filter((range) => range && !foldedExactly(state, range))
      .map((range) => foldEffect.of(range))
    if (effects.length) view.dispatch({ effects })
    return effects.length > 0
  }

  /** Unfold heading sections without disturbing a folded code block. */
  view.unfoldAllHeadings = () => {
    const { state } = view
    const list = headingsFor(state.doc)
    const headingRanges = new Set(list
      .map((heading) => headingFoldRange(state, heading, list))
      .filter(Boolean)
      .map(({ from, to }) => `${from}:${to}`))
    const effects = []
    foldedRanges(state).between(0, state.doc.length, (from, to) => {
      if (headingRanges.has(`${from}:${to}`)) effects.push(unfoldEffect.of({ from, to }))
    })
    if (effects.length) view.dispatch({ effects })
    return effects.length > 0
  }

  /** Put that line back at the top. */
  view.scrollToLine = (n) => {
    const { doc } = view.state
    const line = doc.line(Math.max(1, Math.min(n, doc.lines)))
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) })
  }

  return view
}
