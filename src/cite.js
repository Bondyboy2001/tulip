/**
 * Citations in a copilot reply: the page of the open document an answer came
 * from.
 *
 * Its own module because it is the one piece of the panel that can be checked
 * without a window — a regular expression and a markdown-it rule, both pure —
 * and because a bracket pattern tried at every `[` of every reply is the kind
 * of thing that is quietly widened until it starts eating links. See
 * `scripts/test-ai.mjs`, which is where the shapes it must and must not claim
 * are written down.
 */

/**
 * `[p. 12]`, `[pp. 12–14]`, `[page 12]`, and — when the answer ranges over more
 * than the document on screen — `[Paper.pdf p. 12]`. The copilot is asked for
 * this shape in the system prompt (electron/ai.js), but the pattern is
 * deliberately the one a person would write anyway: a model that has never
 * heard the instruction still lands on it half the time, and a reply from
 * before the instruction existed becomes clickable when it is read back.
 *
 * Sticky rather than anchored-and-sliced: this is tried at every `[` in a reply
 * that is re-rendered on every frame while it streams, and slicing the tail of
 * the message each time is a copy per bracket.
 */
export const CITE = /\[(?:([^[\]|<>]{1,120}?\.pdf)[,;]?\s+)?(pp?\.|pages?|p)\s*(\d{1,5})(?:\s*(?:–|—|-|to)\s*(\d{1,5}))?\]/iy

export function citePlugin (md) {
  /* After `link`, so `[p. 12](https://…)` stays the link it was written as —
     the rules are tried in order at each position, and the first to claim the
     bracket keeps it. */
  md.inline.ruler.after('link', 'cite', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x5B) return false   // '['
    CITE.lastIndex = state.pos
    const match = CITE.exec(state.src)
    if (!match) return false

    if (!silent) {
      const token = state.push('cite', '', 0)
      token.content = match[0].slice(1, -1).trim()
      token.meta = { path: match[1] || '', page: Number(match[3]) }
    }
    state.pos += match[0].length
    return true
  })

  md.renderer.rules.cite = (tokens, i) => {
    const { path, page } = tokens[i].meta
    const where = path ? ` data-cite-path="${md.utils.escapeHtml(path)}"` : ''
    return `<a class="ai-cite" href="#" data-cite-page="${page}"${where}>` +
           `${md.utils.escapeHtml(tokens[i].content)}</a>`
  }
}
