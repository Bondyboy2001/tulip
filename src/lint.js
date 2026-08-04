/* ================================================================ lint
   The house style for a markdown file, applied rather than complained about.

   Four rules. Three about vertical space:

     1. A run of blank lines is a single blank line. None at the top of the
        file, none at the bottom, and the file ends with exactly one newline.
     2. A fenced code block has one blank line above it and one below it.
     3. A heading has one blank line above it and one below it.

   and one about the shape of the outline:

     4. Heading levels descend one at a time. `#` may be followed by `##` and
        `##` by `###`, but `#` followed by `###` is a level that was skipped,
        and the note is renumbered until nothing is skipped. Climbing back is
        free — `###` to `#` is a new section, not a mistake — and the top of a
        note is `#`, so a note whose headings start at `##` is pulled up.

   No rule ever reaches inside a code block or a maths block, which is
   what most of this file is about: finding those regions is the hard part, and
   the rules themselves are a dozen lines at the bottom.

   The answer is a list of edits rather than a rewritten string. The editor
   applies them to the open note as an ordinary change, so the caret, the
   selection, the scroll position and the undo history all survive a lint —
   a whole-document replacement discards every one of them. `lintMarkdown`
   applies the same edits to plain text, for callers with no editor.

   No imports: the renderer bundles this, and `dist/lint.cjs` is the same file
   compiled for scripts/tidy-vault.mjs, which has no bundler. One set of rules,
   so the editor and the terminal cannot come to different conclusions.
   ================================================================== */

/** A line with nothing on it but whitespace. */
const BLANK = /^[ \t]*$/

/**
 * The fence that opens a block, or null.
 *
 * Four spaces of indent would make the line indented code rather than a fence,
 * which is why the indent is capped at three — and why the cap is not merely
 * pedantry: `held` below treats those as code too, and both have to agree
 * about which kind a line is.
 */
function fenceOpen (line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m) return null
  /* A backtick fence's info string may not contain a backtick — ```` ```a`b ````
     is a paragraph, not a block. Without this an inline code span sitting alone
     on a line opens a fence and the rest of the note is read as code. */
  if (m[2][0] === '`' && m[3].includes('`')) return null
  return { indent: m[1].length, char: m[2][0], run: m[2].length }
}

/** Whether `line` closes `open`: the same character, at least as many of it. */
function fenceClose (line, open) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  return !!m && m[1][0] === open.char && m[1].length >= open.run
}

/**
 * The last line of the `$$…$$` block starting at `i`, or -1 if there is none.
 *
 * Deliberately the same three tests the reading view's block rule makes — see
 * `mathPlugin` in math.js: a block opens on `$$` at the head of a line, closes
 * on the first line whose end is `$$`, and — the one worth naming — an *unclosed*
 * `$$` is not a block at all. That last one is why a stray `$$` in a note does
 * not silently switch the linter off for everything below it.
 */
function mathEnd (lines, i) {
  const open = /^ {0,3}(\$\$|\\\[)/.exec(lines[i])
  if (!open) return -1
  const close = open[1] === '$$' ? '$$' : '\\]'
  const head = lines[i].trim().slice(2).trim()
  if (head.endsWith(close) && head.length > 2) return i   // opened and closed on one line
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim().endsWith(close)) return j
  }
  return -1
}

/**
 * The heading `line` is, or null.
 *
 * The same shape `headings` in headings.js recognises, down to the three-space
 * cap on the indent and the demand for text after the hashes — so a `#` alone
 * on a line and a `#tag` are both left out of it here too. The two must agree:
 * the outline is drawn from that one, and this one renumbers what it lists.
 */
function headingAt (line) {
  const m = /^( {0,3})(#{1,6})[ \t]+\S/.exec(line)
  return m ? { indent: m[1].length, level: m[2].length } : null
}

/**
 * The last line of the note's YAML frontmatter, or -1 when it has none.
 *
 * Only ever the very first line of the file, which is the whole of Obsidian's
 * rule for it. Worth finding for one reason: `# a comment` is a comment in YAML
 * and a heading nowhere, and renumbering one would corrupt the note's metadata.
 */
function frontmatterEnd (lines) {
  if (!/^---[ \t]*$/.test(lines[0] || '')) return -1
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) return i
  }
  return -1
}

/**
 * Which lines are inside something the rules must not touch, and where the
 * fenced blocks are.
 *
 * `held` covers the delimiters as well as the content: a fence line is not
 * somewhere a blank line may be inserted either.
 *
 * @returns {{ held: boolean[], fences: Array<{ open: number, close: number, indent: number }> }}
 */
function scan (lines) {
  const held = new Array(lines.length).fill(false)
  const fences = []
  const hold = (from, to) => { for (let k = from; k <= to; k++) held[k] = true }

  let i = 0
  while (i < lines.length) {
    const fence = fenceOpen(lines[i])
    if (fence) {
      let j = i + 1
      while (j < lines.length && !fenceClose(lines[j], fence)) j++
      // An unclosed fence runs to the end of the document, which is what both
      // CommonMark and the reading view do with one.
      const closed = j < lines.length
      const last = closed ? j : lines.length - 1
      hold(i, last)
      fences.push({ open: i, close: closed ? j : -1, indent: fence.indent })
      i = last + 1
      continue
    }

    const math = mathEnd(lines, i)
    if (math >= 0) { hold(i, math); i = math + 1; continue }

    /* The other kind of code block: four spaces of indent, opening where a
       paragraph is not already running. Held so a blank line inside one is left
       alone, since there it is part of the code.

       Generous by design. Indented list content looks exactly like this and is
       held too, so a double blank line buried deep inside a list survives a
       tidy. That is the safe direction to be wrong in — the alternative is
       editing something that turns out to have been code. */
    if (/^ {4}/.test(lines[i]) && (i === 0 || BLANK.test(lines[i - 1]))) {
      let last = i
      for (let j = i + 1; j < lines.length; j++) {
        if (/^ {4}/.test(lines[j])) { last = j; continue }
        if (BLANK.test(lines[j])) continue     // a gap inside the block, if code follows
        break
      }
      hold(i, last)
      i = last + 1
      continue
    }

    i++
  }

  return { held, fences }
}

/**
 * What has to change for `text` to follow the rules, as edits in ascending
 * order of position and never overlapping.
 *
 * @param {string} text
 * @returns {Array<{ from: number, to: number, insert: string }>}
 */
export function lintEdits (text) {
  const source = String(text)

  /* The final newline is split off first so that every entry in `lines` is a
     real line. `'a\n'.split('\n')` ends in an empty string that is not a blank
     line but the absence of one, and counting it as blank makes every tidy
     doc look as though it ends in one. */
  const ends = source.endsWith('\n')
  const body = ends ? source.slice(0, -1) : source
  const lines = body.split('\n')

  const starts = new Array(lines.length)
  for (let i = 0, at = 0; i < lines.length; i++) { starts[i] = at; at += lines[i].length + 1 }
  const lineEnd = (i) => starts[i] + lines[i].length

  const { held, fences } = scan(lines)

  /* Whitespace and nothing else. Left exactly as it is: there is no line here
     that the rules would keep, so tidying it means emptying the file, and a
     linter that empties files is not one anybody would leave switched on. */
  if (lines.every((line, i) => BLANK.test(line) && !held[i])) return []

  /** A blank line the rules are allowed to move. */
  const blank = (i) => BLANK.test(lines[i]) && !held[i]

  const edits = []

  /* Rule 2, as a set of gaps that need a blank line and have none — recorded
     by the line the gap sits above, so a block ending where the next one begins
     is one gap asked for twice rather than two newlines inserted.

     Only fences at the margin. An indented one is inside a list item, and the
     blank line this would add turns a tight list into a loose one — it would
     change how the note reads to satisfy a rule about how it looks. */
  const gaps = new Set()
  for (const fence of fences) {
    if (fence.indent > 0) continue
    if (fence.open > 0 && !BLANK.test(lines[fence.open - 1])) gaps.add(fence.open)
    if (fence.close >= 0 && fence.close < lines.length - 1 &&
        !BLANK.test(lines[fence.close + 1])) gaps.add(fence.close + 1)
  }

  /* Every heading the rules may speak for: outside code, outside maths, and
     outside the frontmatter. Rules 3 and 4 both work from this one list. */
  const heads = []
  for (let line = frontmatterEnd(lines) + 1; line < lines.length; line++) {
    if (held[line]) continue
    const heading = headingAt(lines[line])
    if (heading) heads.push({ line, ...heading })
  }

  /* Rule 3, into the same set of gaps rule 2 fills, so a heading sitting under
     a code block asks for the one blank line between them rather than two.
     Nothing is asked for against the edges of the file: rule 1 is about to take
     the blank lines there away again, and the two would argue forever. */
  for (const { line } of heads) {
    if (line > 0 && !BLANK.test(lines[line - 1])) gaps.add(line)
    if (line < lines.length - 1 && !BLANK.test(lines[line + 1])) gaps.add(line + 1)
  }

  /* Rule 1. Each run of movable blank lines is collapsed to one, or to none
     when it is the top or the bottom of the file. A run against either edge
     cannot also need rule 2's blank line — the fence it would sit against has
     a blank line above it already, which is the test rule 2 makes — so the two
     never both fire on one gap. */
  let i = 0
  while (i < lines.length) {
    if (!blank(i)) { i++; continue }
    let j = i
    while (j < lines.length && blank(j)) j++

    const leading = i === 0
    const trailing = j === lines.length
    const keep = leading || trailing ? 0 : 1

    if (j - i > keep) {
      if (trailing) {
        // From the end of the last line that stays, so the newline that ends it
        // is the one the file finishes on.
        edits.push({ from: lineEnd(i - 1), to: body.length, insert: '' })
      } else {
        edits.push({ from: starts[i + keep], to: starts[j], insert: '' })
      }
    }
    i = j
  }

  for (const gap of gaps) edits.push({ from: starts[gap], to: starts[gap], insert: '\n' })

  /* Rule 4, as the depth of a stack of the levels still open above each
     heading. A heading pops every level at or below its own — those sections
     have ended — pushes its own, and is written at whatever depth it now sits
     at. That keeps what the levels *say* while fixing what they are: two `###`
     under a `#` pop each other and both come out `##`, so they stay siblings,
     where clamping each heading to one more than the last would have made the
     second a child of the first.

     The stack's levels strictly increase, so its depth is never more than the
     level of the heading on top — a heading only ever loses hashes, never
     gains them, and nothing here can push a note past `######`. */
  const open = []
  for (const { line, indent, level } of heads) {
    while (open.length && open[open.length - 1] >= level) open.pop()
    open.push(level)
    if (open.length === level) continue
    const from = starts[line] + indent
    edits.push({ from, to: from + level, insert: '#'.repeat(open.length) })
  }

  /* One newline at the end of the file. Not while the last line is held: inside
     an unclosed code block that newline is a blank line of code, and the file
     ending without one is the smaller wrong. */
  if (!ends && !held[lines.length - 1]) {
    edits.push({ from: source.length, to: source.length, insert: '\n' })
  }

  /* An insertion only ever lands in a gap with no blank line in it, and a
     deletion only ever spans blank ones, so sorting is all that is needed to
     leave them non-overlapping — which is what a ChangeSet requires.

     The tie is between rule 3's blank line above an unindented heading and rule
     4's rewrite of that heading's hashes, which begin at the same offset. The
     shorter goes first: the blank line belongs above the heading, not inside
     the hashes it would otherwise be sorted into the middle of. */
  return edits.sort((a, b) => (a.from - b.from) || ((a.to - a.from) - (b.to - b.from)))
}

/** `text`, tidied. */
export function lintMarkdown (text) {
  const source = String(text)
  const edits = lintEdits(source)
  if (!edits.length) return source

  let out = ''
  let at = 0
  for (const edit of edits) {
    out += source.slice(at, edit.from) + edit.insert
    at = edit.to
  }
  return out + source.slice(at)
}
