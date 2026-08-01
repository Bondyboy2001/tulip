/* ============================================================= callouts
   A blockquote whose first line names a kind:

       > [!warning] Mind the gap
       > The train is not stopping here.

   which reads as an aside rather than a quotation. The syntax is Obsidian's,
   which is the one people's existing notes are already written in — including
   the `-` and `+` suffixes that make a callout start folded or foldable.

   Both views are served from this file: `calloutPlugin` for the reading view's
   markdown-it, `calloutHead` for the editing view's decorations. They read the
   same table and the same regex, so a kind that gets a colour in one gets the
   same colour in the other.
   ================================================================== */

import { svgIcon } from './blocks.js'

/* The kinds, each with the icon it is drawn with and the hue it borrows. The
   hue names a custom property rather than a colour, so a callout is themed by
   the palette like everything else. Aliases are Obsidian's own. Exported for
   the slash menu, which offers one insert command per kind. */
export const CALLOUT_KINDS = [
  { id: 'note', label: 'Note', tone: 'info', icon: 'pencil' },
  { id: 'abstract', label: 'Abstract', tone: 'info', icon: 'clipboard', alias: ['summary', 'tldr'] },
  { id: 'info', label: 'Info', tone: 'info', icon: 'info' },
  { id: 'todo', label: 'Todo', tone: 'info', icon: 'check-circle' },
  { id: 'tip', label: 'Tip', tone: 'mint', icon: 'flame', alias: ['hint', 'important'] },
  { id: 'success', label: 'Success', tone: 'mint', icon: 'check', alias: ['check', 'done'] },
  { id: 'question', label: 'Question', tone: 'amber', icon: 'help', alias: ['help', 'faq'] },
  { id: 'warning', label: 'Warning', tone: 'amber', icon: 'alert', alias: ['caution', 'attention'] },
  { id: 'failure', label: 'Failure', tone: 'rose', icon: 'cross', alias: ['fail', 'missing'] },
  { id: 'danger', label: 'Danger', tone: 'rose', icon: 'zap', alias: ['error'] },
  { id: 'bug', label: 'Bug', tone: 'rose', icon: 'bug' },
  { id: 'example', label: 'Example', tone: 'violet', icon: 'list' },
  { id: 'quote', label: 'Quote', tone: 'grey', icon: 'quote', alias: ['cite'] }
]

const INDEX = new Map()
for (const kind of CALLOUT_KINDS) {
  INDEX.set(kind.id, kind)
  for (const alias of kind.alias || []) INDEX.set(alias, kind)
}

/** An unknown kind is still a callout — it just borrows the neutral tone. */
function calloutKind (word) {
  const key = String(word || '').trim().toLowerCase()
  return INDEX.get(key) || { id: key || 'note', label: key || 'Note', tone: 'grey', icon: 'info' }
}

/* `[!kind]`, optionally folded (`-` closed, `+` open), optionally titled. The
   leading `>` markers are already gone by the time either caller applies this:
   markdown-it strips them, and the editor matches after its own quote marks. */
const CALLOUT_RE = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/

/**
 * The head of a callout, given the first line of a blockquote's contents.
 * Returns null when the line is an ordinary quotation.
 */
export function calloutHead (firstLine) {
  const m = CALLOUT_RE.exec(String(firstLine || '').trim())
  if (!m) return null
  const kind = calloutKind(m[1])
  return {
    kind,
    fold: m[2],                              // '' | '+' | '-'
    title: m[3].trim() || kind.label,
    // How much of the line the marker itself occupies, so the editor can hide
    // exactly that and leave the title standing.
    markLength: m[0].length - m[3].length
  }
}

/* Line art rather than a font: the app ships no icon set, and an emoji would
   sit at a different weight from everything around it. 16×16, currentColor. */
const PATHS = {
  pencil: '<path d="M10.4 2.9 13.1 5.6 5.9 12.8l-3.3.6.6-3.3z"/><path d="M9 4.3 11.7 7"/>',
  clipboard: '<path d="M5.6 3.2h4.8v1.9H5.6z"/><path d="M10.4 4.1h1.9v9.1H3.7V4.1h1.9"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.3v3.6M8 5.4v.5"/>',
  'check-circle': '<circle cx="8" cy="8" r="5.6"/><path d="m5.6 8.1 1.7 1.7 3.1-3.4"/>',
  flame: '<path d="M8 2.4c2.4 2.3 3.9 4 3.9 6a3.9 3.9 0 0 1-7.8 0c0-1.3.6-2.3 1.6-3.4.3 1 .8 1.5 1.4 1.7-.1-1.5.2-2.8.9-4.3z"/>',
  check: '<path d="m3.6 8.4 2.8 2.8 6-6.4"/>',
  help: '<circle cx="8" cy="8" r="5.6"/><path d="M6.4 6.5A1.7 1.7 0 0 1 9.7 7c0 1.2-1.7 1.4-1.7 2.5M8 11.4v.4"/>',
  alert: '<path d="M8 2.9 14 12.9H2z"/><path d="M8 6.6v3M8 11.2v.4"/>',
  cross: '<circle cx="8" cy="8" r="5.6"/><path d="m6.1 6.1 3.8 3.8M9.9 6.1l-3.8 3.8"/>',
  zap: '<path d="M8.9 2.2 4.1 8.9h3.3l-.5 4.9 4.9-6.7H8.5z"/>',
  bug: '<path d="M5.4 6.4a2.6 2.6 0 0 1 5.2 0v2.9a2.6 2.6 0 0 1-5.2 0z"/><path d="M6.2 4.6 5.4 3.4M9.8 4.6l.8-1.2M5.4 7.4H3.2M10.6 7.4h2.2M5.4 9.9l-1.9 1M10.6 9.9l1.9 1"/>',
  list: '<path d="M6.2 4.9h6.6M6.2 8h6.6M6.2 11.1h6.6M3.4 4.9h.01M3.4 8h.01M3.4 11.1h.01"/>',
  quote: '<path d="M6.4 4.6C4.8 5.4 3.9 6.7 3.9 8.4v3h3.4V8.2H5.6c0-1.1.3-1.9 1.3-2.5zM12.1 4.6c-1.6.8-2.5 2.1-2.5 3.8v3H13V8.2h-1.7c0-1.1.3-1.9 1.3-2.5z"/>'
}

/** The icon element for a kind, or an empty span when there is nothing to draw. */
export function calloutIcon (kind) {
  return svgIcon(PATHS[kind.icon] || PATHS.info, { className: 'callout-icon', stroke: 1.3 })
}

/* --------------------------------------------------------- markdown-it */

/**
 * Turns a marked-up blockquote into a callout.
 *
 * The rule runs after `block` and before `inline`, which is the one window
 * where the paragraph's text is still a plain string: the marker can be sliced
 * off `content` and whatever remains is parsed as ordinary markdown afterwards.
 * Running later would mean rewriting an already-parsed token tree by hand.
 */
export function calloutPlugin (md) {
  md.core.ruler.after('block', 'callouts', (state) => {
    const tokens = state.tokens

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue
      // > [!note] …  is always a paragraph's first line, so the three tokens
      // after the quote opens are the only place the marker can be.
      if (tokens[i + 1]?.type !== 'paragraph_open') continue
      const inline = tokens[i + 2]
      if (inline?.type !== 'inline') continue

      const [first, ...rest] = inline.content.split('\n')
      const head = calloutHead(first)
      if (!head) continue

      const open = tokens[i]
      const fold = head.fold
      open.tag = 'div'
      open.attrSet('class',
        `callout is-${head.kind.tone}` +
        (fold ? ' is-foldable' : '') +
        (fold === '-' ? ' is-collapsed' : ''))
      open.attrSet('data-callout', head.kind.id)

      // The matching close has to become a </div> too, and a blockquote can
      // contain another, so the depth is counted rather than assumed.
      let depth = 0
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].type === 'blockquote_open') depth++
        else if (tokens[j].type === 'blockquote_close') {
          if (depth === 0) { tokens[j].tag = 'div'; break }
          depth--
        }
      }

      const title = new state.Token('callout_title', '', 0)
      title.meta = { kind: head.kind, title: head.title, foldable: !!fold }
      title.map = open.map

      const body = rest.join('\n')
      if (body.trim()) {
        // The marker line is dropped and the rest of the paragraph stands as
        // the callout's first block. Left unparsed on purpose — the inline
        // rule has not run yet, and this is what it will read.
        inline.content = body
        tokens.splice(i + 1, 0, title)
      } else {
        // Nothing but the marker: the whole paragraph goes, or the callout
        // would open with a blank line where its first sentence should be.
        tokens.splice(i + 1, 3, title)
      }
    }
  })

  md.renderer.rules.callout_title = (tokens, i) => {
    const { kind, title, foldable } = tokens[i].meta
    const icon = calloutIcon(kind).outerHTML
    const twist = foldable
      ? svgIcon('<path d="M4.5 3 8 6l-3.5 3"/>',
        { viewBox: '0 0 12 12', className: 'callout-twist', stroke: 1.4 }).outerHTML
      : ''
    return `<div class="callout-head">${icon}` +
           `<span class="callout-title">${md.utils.escapeHtml(title)}</span>${twist}</div>` +
           '<div class="callout-body">'
  }

  /* The body div the title opened is closed by the blockquote's own close tag,
     which the rule above turned into a </div>. Stating it here rather than
     emitting a second close keeps the nesting readable in the output. */
  const closeToken = md.renderer.rules.blockquote_close
  md.renderer.rules.blockquote_close = (tokens, i, options, env, self) => {
    const isCallout = tokens[i].tag === 'div'
    const rendered = closeToken
      ? closeToken(tokens, i, options, env, self)
      : self.renderToken(tokens, i, options)
    return isCallout ? `</div>${rendered}` : rendered
  }
}
