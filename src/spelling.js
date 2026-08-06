/* ============================================================ spelling
   Which words in the open note are worth asking the dictionary about, and
   where each of them is.

   The checking itself happens in the main process (electron/main.js, over
   src/spellcheck.js). What is left here is the harder half: a note is not
   prose all the way down. A fenced block is a program, `$x_i$` is an equation,
   `[[Note name]]` is a filename and `https://…` is an address, and running a
   dictionary over any of them produces a panel of things that are not
   mistakes — which is how a spelling panel becomes something you switch off.

   So the skipped regions come from the document's own syntax tree wherever the
   tree knows about them, and from a small number of patterns where it does not:
   maths, wikilinks and the frontmatter block are Tulip's, not Markdown's.
   ================================================================== */

/* `syntaxTree` is handed over by the editor as it loads rather than imported
   here. It comes from @codemirror/language, which reaches @codemirror/view, and
   naming it in an import would put the whole editing stack on the startup path
   for the sake of a call that only happens when there is an editor to ask —
   see the same arrangement in highlight.js.

   Unprimed, `proseRanges` skips nothing and every word in the document is
   checked, code included. That is the honest degradation: more to look at,
   never less. */
let syntaxTree = null

/** Called by editor.js at load, with the function it already has to hand. */
export function primeSyntaxTree (fn) {
  syntaxTree ||= fn
}

/* Node names that are not prose. Markdown's parser names these; a name it does
   not produce simply never matches, which is why the list can be generous. */
const SKIP_NODES = new Set([
  'FencedCode', 'CodeBlock', 'CodeText', 'CodeMark', 'CodeInfo', 'InlineCode',
  'URL', 'Autolink', 'LinkTitle', 'HTMLTag', 'HTMLBlock', 'Comment', 'CommentBlock',
  'Entity', 'Escape', 'TaskMarker'
])

/* What the tree does not mark. Order matters only in that these are all
   scanned over the whole document independently, and overlaps are harmless —
   the ranges are merged before use.

     · `$…$` and `$$…$$`  — an equation is symbols, not words
     · `[[…]]`            — a wikilink names a file
     · a leading `---` block — frontmatter is keys and values
     · `#tag`             — a tag is a label the vault knows, not English */
const MATH = /\$\$[\s\S]*?\$\$|\$[^\n$]+\$/g
const WIKILINK = /\[\[[^\]]*\]\]/g
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/
const TAG = /(^|\s)#[^\s#]+/g

/**
 * A word, as the dictionary would be asked about it.
 *
 * Hyphenated compounds are checked a part at a time: dictionaries carry
 * "well" and "known" but not every compound anyone has made from them, and
 * flagging `well-known` teaches the panel to be ignored. The possessive is
 * likewise not part of the word — `Tulip's` is the word `Tulip`.
 */
const WORD = /[\p{L}][\p{L}’'-]*/gu

/** Ranges, sorted and merged, so a scan can walk them once. */
function merge (ranges) {
  const sorted = ranges.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0])
  const out = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else out.push([range[0], range[1]])
  }
  return out
}

/**
 * The parts of `text` that are prose, as `[from, to]` pairs.
 *
 * @param {string} text          the whole document
 * @param {import('@codemirror/state').EditorState} [state]  for the syntax tree
 */
export function proseRanges (text, state) {
  const skip = []

  if (state && syntaxTree) {
    syntaxTree(state).iterate({
      enter (node) {
        if (!SKIP_NODES.has(node.name)) return true
        skip.push([node.from, node.to])
        // Nothing inside a skipped region can bring prose back.
        return false
      }
    })
  }

  const front = FRONTMATTER.exec(text)
  if (front) skip.push([0, front[0].length])

  for (const pattern of [MATH, WIKILINK, TAG]) {
    pattern.lastIndex = 0
    let hit
    while ((hit = pattern.exec(text))) skip.push([hit.index, hit.index + hit[0].length])
  }

  const blocked = merge(skip)
  const prose = []
  let at = 0
  for (const [from, to] of blocked) {
    if (from > at) prose.push([at, from])
    at = Math.max(at, to)
  }
  if (at < text.length) prose.push([at, text.length])
  return prose
}

/**
 * Whether a token is the sort of thing a dictionary has an opinion about.
 *
 * The rejections are all the same rejection: this is not an English word being
 * used as one. An acronym is not misspelled, `getUserName` is an identifier
 * that escaped a code fence, and a two-letter word is either fine or not worth
 * a row in a panel.
 */
function checkable (word) {
  if (word.length < 3) return false
  // ALL CAPS: an acronym, a constant, or shouting. None of them are spelling.
  if (word === word.toUpperCase()) return false
  // A capital anywhere but the front is camelCase or PascalCase — code.
  if (/[\p{Lu}]/u.test(word.slice(1))) return false
  return true
}

/**
 * Every word in the note worth checking, with where it is.
 *
 * Returned in document order and not deduplicated: the panel groups them, and
 * the order they came in is the order it steps through them.
 *
 * @returns {{word: string, from: number, to: number}[]}
 */
export function wordsIn (text, state) {
  const found = []

  for (const [start, end] of proseRanges(text, state)) {
    const slice = text.slice(start, end)
    WORD.lastIndex = 0
    let hit
    while ((hit = WORD.exec(slice))) {
      const at = start + hit.index
      /* The possessive and any trailing punctuation the pattern swept up — a
         word at the end of a clause is `word` followed by `'s`, or by the
         hyphen of an em-dash typed as one. */
      let token = hit[0].replace(/[’'](s|S)?$/, '').replace(/-+$/, '')
      if (!token) continue

      /* Hyphenated compounds, a part at a time, each keeping its own place in
         the document so the panel can jump to the half that is wrong. */
      let offset = 0
      for (const part of token.split('-')) {
        const from = at + offset
        offset += part.length + 1
        if (!part || !checkable(part)) continue
        found.push({ word: part, from, to: from + part.length })
      }
    }
  }

  return found
}

/**
 * The words to ask about, and every place each one appears.
 *
 * Keyed on the lower-cased word so `The` and `the` are one row, while the row
 * shows the spelling that was actually written — a name reported in lower case
 * reads as a different mistake from the one on the page.
 *
 * @returns {Map<string, {word: string, at: {from: number, to: number}[]}>}
 */
export function groupWords (words) {
  const groups = new Map()
  for (const { word, from, to } of words) {
    const key = word.toLowerCase()
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { word, at: [] }))
    group.at.push({ from, to })
  }
  return groups
}
