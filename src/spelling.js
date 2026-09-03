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
/** @type {((state: any) => any)|null} */
let syntaxTree = null

/** Called by editor.js at load, with the function it already has to hand. */
/** @param {(state: any) => any} fn */
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
 * The parts of `text` that are *not* prose, sorted and merged.
 *
 * Whole-document by necessity: every one of these can span lines — a fence, a
 * display `$$…$$`, the frontmatter block — so there is no such thing as
 * deciding from one line alone whether it is prose. It is also the cheap half
 * of a pass: a tree walk and four regex scans, with nothing allocated per word.
 */
function blockedRanges (text, state) {
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

  return merge(skip)
}

/** The complement: the parts of `text` that are prose, as `[from, to]` pairs. */
function proseRanges (text, state) {
  const blocked = blockedRanges(text, state)
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
    collectWords(text, start, end, 0, found)
  }
  return found
}

/**
 * The checkable words in `text` between `start` and `end`, pushed onto `into`
 * with `base` taken off every position.
 *
 * `base` is what lets one scanner serve both callers: `wordsIn` passes 0 and
 * gets document positions, and the line scanner passes the line's start and
 * gets positions it can cache and add back to later.
 */
function collectWords (text, start, end, base, into) {
  const slice = text.slice(start, end)
  WORD.lastIndex = 0
  let hit
  while ((hit = WORD.exec(slice))) {
    const at = start + hit.index - base
    /* The possessive and any trailing punctuation the pattern swept up — a
       word at the end of a clause is `word` followed by `'s`, or by the
       hyphen of an em-dash typed as one. */
    const token = hit[0].replace(/[’'](s|S)?$/, '').replace(/-+$/, '')
    if (!token) continue

    /* Hyphenated compounds, a part at a time, each keeping its own place in
       the document so the panel can jump to the half that is wrong. */
    let offset = 0
    for (const part of token.split('-')) {
      const from = at + offset
      offset += part.length + 1
      if (!part || !checkable(part)) continue
      /* The folded form is kept beside the word rather than worked out again
         by every reader. It is what both the note's word list and the search
         for a flagged word's places are keyed on, and `toLowerCase` allocates
         a string every time it is asked — seventy thousand of them per pass on
         a long note, for an answer that cannot have changed since the line was
         scanned. */
      into.push({ word: part, lower: part.toLowerCase(), from, to: from + part.length })
    }
  }
  return into
}

/**
 * A scanner that pays for the lines that changed.
 *
 * The pass this replaces ran half a second after every pause in typing and
 * found every word in the note again — a `[\p{L}]…` match and two objects for
 * each of them — to arrive at an answer that differed from the last one by the
 * word just typed. On a long note that is the most expensive thing the app does
 * *while somebody is writing*, which is the worst moment to spend anything.
 *
 * What is cached is one line's words, at positions relative to the line, keyed
 * by the line's text together with a signature of the parts of it that are not
 * prose. Both halves of that key are needed: the same line of text is words
 * when it stands in prose and is not when it stands inside a fence, and a cache
 * that could not tell those apart would underline a program's identifiers the
 * first time somebody typed a sentence above it.
 *
 * The cache is rebuilt from the lines actually seen on each pass rather than
 * added to, so it holds the note that is open and not every state it has passed
 * through — bounded, with no eviction policy to get wrong.
 */
export function makeLineScanner () {
  /** line key -> its words, at positions relative to the line's start */
  let cache = new Map()
  /* The lines of the document `scan` last read — where each starts, and what
     it holds — as two arrays rather than one array of pairs, because a pass
     rebuilds them and nine thousand short-lived objects is a cost with nothing
     to show for it. */
  let lineAt = []
  let lineWords = []

  return {
    /** Throw the cache away — the document is one this knows nothing about. */
    forget () { cache = new Map(); lineAt = []; lineWords = [] },

    /**
     * Every distinct word in the note worth asking the dictionary about, keyed
     * on the lower-cased form and valued by the spelling actually written.
     *
     * No positions. Almost every word in a note is spelled correctly, and
     * working out where all of them are — two numbers and an object each, for
     * seventy thousand occurrences in a long note — was most of what a pass
     * cost, spent on an answer immediately filtered down to the handful that
     * are wrong. Where those few are is `places`, asked afterwards, once the
     * dictionary has said which ones anybody needs to be able to find.
     */
    scan (text, state) {
      const blocked = blockedRanges(text, state)
      const distinct = new Map()
      const next = new Map()
      lineAt = []
      lineWords = []

      let at = 0            // where this line starts
      let skip = 0          // the first blocked range that could touch it
      const relative = []   // the line's blocked parts, reused between lines

      while (at <= text.length) {
        let end = text.indexOf('\n', at)
        if (end === -1) end = text.length

        /* The blocked ranges are sorted and so are the lines, so the walk over
           them is one pass across the document rather than a search per line.
           A range that ended before this line is stepped over once and never
           looked at again. */
        while (skip < blocked.length && blocked[skip][1] <= at) skip++
        relative.length = 0
        for (let i = skip; i < blocked.length && blocked[i][0] < end; i++) {
          relative.push(Math.max(blocked[i][0], at) - at, Math.min(blocked[i][1], end) - at)
        }

        const line = text.slice(at, end)
        /* Both halves of the key are needed. The same line of text is words
           when it stands in prose and is not when it stands inside a fence, and
           a cache that could not tell those apart would underline a program's
           identifiers the first time somebody typed a sentence above it.

           The blocked parts lead and are only ever digits and commas, so the
           first space is always the separator and no two lines can collide. */
        const key = relative.length ? relative.join(',') + ' ' + line : ' ' + line
        let held = cache.get(key)
        if (held === undefined) {
          const words = []
          let from = 0
          for (let i = 0; i < relative.length; i += 2) {
            if (relative[i] > from) collectWords(line, from, relative[i], 0, words)
            from = Math.max(from, relative[i + 1])
          }
          if (from < line.length) collectWords(line, from, line.length, 0, words)
          held = words
        }
        next.set(key, held)
        lineAt.push(at)
        lineWords.push(held)
        for (const found of held) {
          if (!distinct.has(found.lower)) distinct.set(found.lower, found.word)
        }

        if (end === text.length) break
        at = end + 1
      }

      /* Rebuilt from the lines actually seen rather than added to, so the cache
         holds the note that is open and not every state it has passed through
         — bounded by the note, with no eviction policy to get wrong. */
      cache = next
      return distinct
    },

    /**
     * Where the wanted words are, in the document `scan` last read.
     *
     * `wanted` is a set of lower-cased words. The shape handed back is what the
     * panel and the underlines both read: the word as written, and every place
     * it appears, in document order.
     */
    places (wanted) {
      const groups = new Map()
      if (!wanted || !wanted.size) return groups
      for (let i = 0; i < lineWords.length; i++) {
        const at = lineAt[i]
        for (const found of lineWords[i]) {
          if (!wanted.has(found.lower)) continue
          let group = groups.get(found.lower)
          if (!group) groups.set(found.lower, (group = { word: found.word, at: [] }))
          group.at.push({ from: at + found.from, to: at + found.to })
        }
      }
      return groups
    }
  }
}
