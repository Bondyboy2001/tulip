/* ============================================================= headings
   One answer to "what are this note's headings and blocks, and where does
   [[Note#Anchor]] land". The outline panel, the switcher's heading mode,
   wikilink anchors, transclusions and completion after `[[#` all read from
   here, so none of them can develop a private idea of what counts as a target.

   The source is scanned rather than the syntax tree consulted: the reading
   view has no tree, and the two views must agree about the answer.
   ================================================================== */

import { svgIcon } from './dom.js'

/**
 * A heading's name, reduced to something a link can be written as. Obsidian's
 * rule: case and punctuation are ignored, runs of whitespace become one dash.
 * Matching is done on this, so `[[Note#The plan]]` finds "## The Plan!".
 */
function slugify (text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')          // the markup around a heading's words
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * Every ATX heading in a note's source, in document order.
 *
 * Fenced code is skipped, because `# not a heading` is the commonest first
 * line of a shell block. Lines are 1-based, matching everything else that
 * addresses a position in a note by line.
 *
 * @returns {{level: number, text: string, line: number, slug: string}[]}
 */
export function headings (text) {
  const lines = String(text || '').split('\n')
  const out = []

  /** @type {string | null} */
  let fence = null                        // the character a fence opened with
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      // A fence closes only on its own character: ``` does not end a ~~~ block.
      if (!fence) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      continue
    }
    if (fence) continue

    // Up to three leading spaces, as CommonMark allows — a tab instead would
    // make the line indented code, so only spaces are stepped over.
    const m = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const heading = m[2].trim()
    out.push({ level: m[1].length, text: heading, line: i + 1, slug: slugify(heading) })
  }

  return out
}

/* One document's headings, held so that repeated asking is free.

   Keyed on CodeMirror's `Text` rather than on a string, for the reason the
   maths cache gives at length: the object is shared between states whenever
   the document did not change, so identity is exactly the question. The editor
   asks on every decoration rebuild — every keystroke, and every scroll — and
   the scan is a split and two regular expressions per line of the note. One
   entry is enough; the case that matters is many asks about one document. */
/** @type {{ doc: any, found: Array<{ level: number, text: string, line: number, slug: string }> }} */
let headingCache = { doc: null, found: /** @type {any} */ (null) }

/**
 * One document's headings, held so that repeated asking is free.
 *
 * @param {any} doc  CodeMirror's `Text` for the document to scan
 * @returns {Array<{ level: number, text: string, line: number, slug: string }>} the headings, in document order
 */
export function headingsFor (doc) {
  if (headingCache.doc !== doc) {
    headingCache = { doc, found: headings(doc.toString()) }
  }
  return headingCache.found
}

/**
 * Splits `Note#Heading` into the note and the place in it. A leading `#` means
 * this note — `[[#Heading]]` is how a link inside a note names its own section.
 */
export function splitAnchor (target) {
  const raw = String(target || '')
  const at = raw.indexOf('#')
  if (at === -1) return { name: raw.trim(), anchor: '' }
  return { name: raw.slice(0, at).trim(), anchor: raw.slice(at + 1).trim() }
}

/**
 * The heading an anchor names. Slugs are tried first, then a plain
 * case-insensitive comparison, so a link written before the slug rule existed
 * — or by hand, with the punctuation left in — still resolves.
 */
export function findHeading (list, anchor) {
  if (!anchor) return null
  const wanted = slugify(anchor)
  const plain = String(anchor).trim().toLowerCase()
  return list.find((h) => h.slug === wanted) ||
         list.find((h) => h.text.toLowerCase() === plain) ||
         null
}

/* ------------------------------------------------------ block references */

const BLOCK_ID = /(?:^|[ \t]+)\^([A-Za-z0-9-]+)[ \t]*$/
const LIST_LINE = /^ {0,3}(?:[-+*]|\d+[.)])\s+/
const QUOTE_LINE = /^ {0,3}>/
const TABLE_LINE = /^\s*\|/
const BLOCK_START = /^(?: {0,3}(?:```|~~~|>|#{1,6}\s|[-+*]\s|\d+[.)]\s)| {4}\S)/

/** A block identifier at the end of one source line, or null. */
export function blockReferenceOnLine (line) {
  const text = String(line || '')
  const match = BLOCK_ID.exec(text)
  if (!match) return null
  const markerAt = match.index + match[0].indexOf('^')
  return {
    id: match[1],
    from: match.index,
    markerFrom: markerAt,
    to: text.length,
    standalone: text.slice(0, match.index).trim() === ''
  }
}

const plainParagraphLine = (line) =>
  line.trim() && !BLOCK_START.test(line) && !TABLE_LINE.test(line)

/** The first line of the source block ending at `end`. */
function blockStart (lines, end) {
  const line = lines[end] || ''

  if (LIST_LINE.test(line)) {
    let at = end
    while (at > 0 && lines[at - 1].trim() &&
           (LIST_LINE.test(lines[at - 1]) || /^ {2,}\S/.test(lines[at - 1]))) at--
    return at
  }
  if (QUOTE_LINE.test(line)) {
    let at = end
    while (at > 0 && QUOTE_LINE.test(lines[at - 1])) at--
    return at
  }
  if (TABLE_LINE.test(line)) {
    let at = end
    while (at > 0 && TABLE_LINE.test(lines[at - 1])) at--
    return at
  }
  if (!plainParagraphLine(line)) return end

  let at = end
  while (at > 0 && plainParagraphLine(lines[at - 1]) &&
         !blockReferenceOnLine(lines[at - 1])) at--
  return at
}

/**
 * Every `^block-id` outside fenced code.
 *
 * A suffix belongs to the paragraph or list line carrying it. A marker on a
 * line of its own names the immediately preceding Markdown block, which is the
 * form used to name a whole list or table.
 */
export function blockReferences (text) {
  const lines = String(text || '').split('\n')
  const out = []

  /** @type {string | null} */
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (marker) {
      if (!fence) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      continue
    }
    if (fence) continue

    const ref = blockReferenceOnLine(lines[i])
    if (!ref) continue

    let end = i
    let from = LIST_LINE.test(lines[i]) ? i : blockStart(lines, i)
    if (ref.standalone && i > 0 && lines[i - 1].trim()) {
      end = i - 1
      from = blockStart(lines, end)
    }

    const source = lines.slice(from, end + 1)
    if (!ref.standalone && end === i) {
      source[source.length - 1] = lines[i].slice(0, ref.from).trimEnd()
    }

    out.push({
      id: ref.id,
      line: from + 1,
      markerLine: i + 1,
      fromLine: from + 1,
      toLine: end + 1,
      source: source.join('\n')
    })
  }
  return out
}

/** The block named by `^id`, or null. */
export function findBlock (text, anchor) {
  const wanted = String(anchor || '').trim().replace(/^\^/, '')
  if (!wanted) return null
  return blockReferences(text).find((block) => block.id === wanted) || null
}

/**
 * The source fragment an anchor names: a heading section or one exact block.
 * Null means the anchor exists in neither namespace.
 */
export function anchoredFragment (text, anchor) {
  if (String(anchor || '').trim().startsWith('^')) {
    return findBlock(text, anchor)?.source ?? null
  }

  const list = headings(text)
  const head = findHeading(list, anchor)
  if (!head) return null
  const lines = String(text || '').split('\n')
  let end = lines.length
  for (const other of list) {
    if (other.line > head.line && other.level <= head.level) {
      end = other.line - 1
      break
    }
  }
  return lines.slice(head.line - 1, end).join('\n')
}

/**
 * The exact source range an editable transclusion owns. Unlike
 * `anchoredFragment`, a block range includes its `^block-id` marker so saving
 * an edit cannot silently destroy the address that made the embed possible.
 */
export function anchoredSourceRange (text, anchor) {
  const source = String(text || '')
  if (!anchor) return { from: 0, to: source.length, source }

  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  const lineStart = (line) => starts[Math.max(0, line - 1)] ?? source.length
  const afterLine = (line) => starts[line] ?? source.length

  if (String(anchor).trim().startsWith('^')) {
    const block = findBlock(source, anchor)
    if (!block) return null
    const from = lineStart(block.fromLine)
    const to = afterLine(block.markerLine)
    return { from, to, source: source.slice(from, to) }
  }

  const list = headings(source)
  const head = findHeading(list, anchor)
  if (!head) return null
  const next = list.find((other) => other.line > head.line && other.level <= head.level)
  const from = lineStart(head.line)
  const to = next ? lineStart(next.line) : source.length
  return { from, to, source: source.slice(from, to) }
}

/**
 * Hide a paragraph's trailing `^id` in rendered Markdown and put the identity
 * on its element. The source stays untouched; this only changes the token that
 * Markdown-it is about to render.
 */
export function blockReferencePlugin (md) {
  md.core.ruler.after('block', 'block_references', (state) => {
    for (let i = 1; i < state.tokens.length; i++) {
      const inline = state.tokens[i]
      const open = state.tokens[i - 1]
      if (inline.type !== 'inline' || open.type !== 'paragraph_open') continue

      const ref = blockReferenceOnLine(inline.content)
      if (!ref) continue
      inline.content = inline.content.slice(0, ref.from).trimEnd()
      open.attrSet('data-block-id', ref.id)
      if (ref.standalone) open.attrJoin('class', 'block-id-only')
    }
  })
}

/* --------------------------------------------------------- heading folds */

const HEADING_TAG = /^H([1-6])$/

/* The one control every heading gets, built once. Building an element runs the
   HTML parser for the chevron inside it, and a long note asks for hundreds of
   identical ones; cloning copies nodes that are already built.

   Built on first use rather than at module scope, so importing this module —
   most of which is text scanning with no DOM in it — never needs a `document`.
   The chevron comes from `svgIcon` so that one module owns what an icon is,
   and so this one gets its parse cache rather than keeping a second. */
/** @type {HTMLButtonElement | null} */
let foldTemplate = null

function foldButton () {
  if (!foldTemplate) {
    foldTemplate = document.createElement('button')
    foldTemplate.type = 'button'
    foldTemplate.className = 'heading-fold'
    foldTemplate.append(svgIcon('<path d="m3.5 4.5 2.5 3 2.5-3"/>',
      { viewBox: '0 0 12 12', stroke: 1.35 }))
    foldTemplate.setAttribute('aria-expanded', 'true')
    foldTemplate.setAttribute('aria-label', 'Fold section')
    foldTemplate.title = 'Fold section'
  }
  return /** @type {HTMLButtonElement} */ (foldTemplate.cloneNode(true))
}

/**
 * Add disclosure controls to the top-level headings under `root`.
 *
 * Siblings in a folded section get a class owned by this feature rather than a
 * `hidden` attribute, so expanding cannot accidentally reveal something that
 * another renderer intentionally hid.
 */
export function installHeadingFolds (root) {
  const children = [...(root?.children || [])]
  for (let i = 0; i < children.length; i++) {
    const heading = children[i]
    const match = HEADING_TAG.exec(heading.tagName)
    if (!match) continue

    const level = Number(match[1])
    const section = []
    for (let j = i + 1; j < children.length; j++) {
      const next = HEADING_TAG.exec(children[j].tagName)
      if (next && Number(next[1]) <= level) break
      section.push(children[j])
    }
    if (!section.length) continue

    const button = foldButton()

    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const folded = button.getAttribute('aria-expanded') === 'true'
      for (const node of section) node.classList.toggle('is-heading-folded', folded)
      heading.classList.toggle('is-heading-collapsed', folded)
      button.setAttribute('aria-expanded', String(!folded))
      button.setAttribute('aria-label', folded ? 'Expand section' : 'Fold section')
      button.title = folded ? 'Expand section' : 'Fold section'
    })

    heading.prepend(button)
    heading.classList.add('has-heading-fold')
  }
}
