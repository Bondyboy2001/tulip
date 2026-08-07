/* ==================================================== where to stop reading

   A note has no size limit, and the reading view renders one in a single pass:
   markdown-it builds the whole string, the parser turns the whole string into
   nodes, and both are proportional to the document. Everything after that is
   already bounded — `.reading-body > *` carries `content-visibility: auto`, so
   layout and paint only happen for the blocks in view — which is why an 84,000
   line note opens in about 460ms rather than seizing. But it is linear, and a
   note that is linear in the megabytes eventually stops being openable.

   The honest answer is the one the grid already gives a hundred-megabyte CSV:
   show the beginning, say so, and offer the rest. That is what this file is
   for. It does not make big notes faster; it makes an enormous one open at all
   and admits what it did.

   Splitting markdown is not splitting text. Two constructs span blank lines
   and mean nothing when cut in half:

     - a fenced code block, whose closing fence may be thousands of lines below
       its opening one, and whose contents may be markdown that would then be
       rendered as markdown;
     - a display maths block, `$$ … $$`, for the same reason.

   So the cut is made at a blank line that is outside both. There is always
   one, eventually; where there is not — a single enormous fence — the note is
   shown whole rather than broken, because a broken fence is worse than a slow
   note.

   Deliberately does NOT try to be a general chunker for progressive rendering.
   Reference definitions (`[label]: /url`), footnotes and this app's equation
   numbering are all facts about a whole document: render it in pieces and a
   link defined at the bottom stops resolving at the top. A prefix that says it
   is a prefix has no such problem, because nobody is being told it is the
   whole note. */

/** A ``` or ~~~ fence, opening or closing, at the start of a line. */
const FENCE = /^(\s{0,3})(`{3,}|~{3,})/

/**
 * The offset to cut `text` at so the result is a whole number of blocks.
 *
 * Looks for the last safe blank line at or before `limit`, so the prefix comes
 * in under budget rather than over it. Returns `text.length` when the whole
 * thing fits, and also when there is no safe cut to make — both mean "show all
 * of it", and the caller tells them apart by comparing with `text.length`.
 */
export function safeCut (text, limit) {
  const source = String(text ?? '')
  if (source.length <= limit) return source.length

  let at = 0            // offset of the current line
  let openFence = ''    // the fence that opened the block we are in, if any
  let inMath = false
  let cut = 0           // the best safe blank line seen so far

  const lines = source.split('\n')
  for (const line of lines) {
    const next = at + line.length + 1
    /* Past the budget and we have somewhere to stop: stop. Continuing would
       only find later cuts, which are the ones we are trying not to make. */
    if (at > limit && cut) break

    if (openFence) {
      /* A fence closes on a marker of the same kind and at least as long. A
         shorter run, or the other character, is content. */
      const close = FENCE.exec(line)
      if (close && close[2][0] === openFence[0] && close[2].length >= openFence.length) {
        openFence = ''
      }
    } else {
      const open = FENCE.exec(line)
      if (open) openFence = open[2]
      /* Display maths toggles on its own `$$` line. Counting toggles rather
         than matching pairs keeps this in step with the rest of the app, where
         an unclosed `$$` runs to the end of the note. */
      else if (line.trim() === '$$') inMath = !inMath
      else if (line.trim() === '' && !inMath && at <= limit) cut = at
    }
    at = next
  }

  /* No blank line outside a fence anywhere in budget — one enormous block.
     Cutting inside it would render a fence's contents as markdown, or leave
     half an equation. The note goes out whole. */
  return cut || source.length
}
