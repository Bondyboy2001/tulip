// @ts-check
/* ======================================================= inline highlights
   One grammar for `==highlighted text==`, shared by the reading view and the
   editor. Markdown-it does not include this extension, and CodeMirror sees the
   equals signs as plain text, so without one owner the two views would have to
   guess independently where a highlight begins and ends.
   ================================================================== */

const escaped = (text, at) => {
  let slashes = 0
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

/**
 * A highlight beginning at `at`, or null.
 *
 * The content may contain ordinary inline Markdown, but not a newline. Markers
 * touching whitespace are left as literal equals signs, matching the way bold
 * and emphasis delimiters behave.
 */
function highlightAt (text, at) {
  const source = String(text || '')
  if (source.slice(at, at + 2) !== '==' || escaped(source, at)) return null
  if (source[at - 1] === '=' || source[at + 2] === '=' || /\s/.test(source[at + 2] || '')) return null

  for (let end = at + 3; end < source.length; end++) {
    if (source.slice(end, end + 2) !== '==' || escaped(source, end)) continue
    if (source[end - 1] === '=' || /\s/.test(source[end - 1])) continue
    if (source[end + 2] === '=') continue
    return {
      from: at,
      contentFrom: at + 2,
      contentTo: end,
      to: end + 2,
      content: source.slice(at + 2, end)
    }
  }
  return null
}

/** Every complete highlight in one line, in source order. */
export function findInlineHighlights (text) {
  const source = String(text || '')
  if (!source.includes('==')) return []
  const found = []
  for (let at = 0; at < source.length - 1;) {
    const mark = highlightAt(source, at)
    if (!mark) { at++; continue }
    found.push(mark)
    at = mark.to
  }
  return found
}

/**
 * Markdown-it extension for `==text==`.
 *
 * The inside is handed back to Markdown-it, so emphasis, links, footnotes and
 * every other inline feature remain live inside a highlight.
 */
export function highlightPlugin (md) {
  md.inline.ruler.before('emphasis', 'highlight', (state, silent) => {
    const mark = highlightAt(state.src, state.pos)
    if (!mark) return false

    if (!silent) {
      // Parse the contents in an isolated token list. Reusing the parent's
      // token list makes Markdown-it's delimiter indexes point at the wrong
      // tokens when another delimiter (for example ~~strike~~) appears on the
      // same line.
      const children = []
      state.md.inline.parse(mark.content, state.md, state.env, children)
      const token = state.push('highlight', 'mark', 0)
      token.children = children
    }
    state.pos = mark.to
    return true
  })

  md.renderer.rules.highlight = (tokens, index, options, env, renderer) => {
    return `<mark>${renderer.renderInline(tokens[index].children || [], options, env)}</mark>`
  }
}
