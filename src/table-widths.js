/* ============================================== table column widths
   The `<!-- tk-widths: … -->` marker: how a table's column widths are written
   into a note, read back, and turned into a <colgroup> for the reading view.

   Its own module because both views need this vocabulary and only one of them
   has an editor. table.js — the live table widget — is a CodeMirror module, and
   the reading view reaching these helpers through it put the whole editing
   stack on the startup path. Nothing here imports CodeMirror. Keep it so.
   ================================================== */

const WIDTHS = /^\s*<!--\s*tk-widths:\s*([\d\s.]*?)\s*-->\s*$/

/** The smallest a column may be made — narrower than this and the padding
 *  alone fills it, so there is nowhere left for the text. */
const MIN_COLUMN_WIDTH = 44

/** The widths a marker line names, or null if the line is not one. A column
 *  with no width of its own is written `0`, meaning "size to the content". */
function parseColumnWidths (text) {
  const found = WIDTHS.exec(text || '')
  if (!found) return null
  const widths = found[1].split(/\s+/).filter(Boolean).map(Number)
  return widths.every((w) => Number.isFinite(w) && w >= 0) ? widths : null
}

/** One column's width as CSS, in the one form both views write it. `0` is a
 *  column with no width of its own: none at all, size to the content. */
const columnWidth = (width) => (width ? `${Math.round(width)}px` : '')

/** How many columns a token stream's table has, counted off its header row.
 *  The token stream is the only place the reading view can be asked. */
function headerCells (tokens, open) {
  let cells = 0
  for (let at = open + 1; at < tokens.length; at++) {
    if (tokens[at].type === 'tr_close') break
    if (tokens[at].type === 'th_open') cells++
  }
  return cells
}

/**
 * The reading view's half of the same feature: the marker line above a table
 * is read off the token stream, hidden, and turned into the `<colgroup>` the
 * editing view draws from its own copy of the widths.
 *
 * A core rule rather than a pass over the rendered DOM, because the comment
 * does not survive that far — src/rawhtml.js drops every comment on its way
 * out, which is exactly why the marker is invisible everywhere else.
 */
export function columnWidthPlugin (md) {
  md.core.ruler.push('tk_column_widths', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i].type !== 'html_block') continue
      const widths = parseColumnWidths(tokens[i].content)
      if (!widths) continue
      if (tokens[i + 1].type !== 'table_open') continue
      /* Emptied as well as hidden: `hidden` is honoured by markdown-it's own
         token renderer, and raw HTML has a rule of its own (src/rawhtml.js)
         that never sees the flag. */
      tokens[i].hidden = true
      tokens[i].content = ''
      /* Padded to the table's real width, so a marker written when the table
         was narrower still describes every column — and so the two views agree
         about which columns are content-sized, which is what decides whether
         the grid fills its frame. */
      tokens[i + 1].meta = {
        ...(tokens[i + 1].meta || {}),
        widths: padWidths(widths, Math.max(widths.length, headerCells(tokens, i + 1)))
      }
    }
  })

  const renderOpen = md.renderer.rules.table_open ||
    ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options))

  md.renderer.rules.table_open = (tokens, i, options, env, self) => {
    const widths = tokens[i].meta?.widths
    if (!widths?.some(Boolean)) return renderOpen(tokens, i, options, env, self)
    tokens[i].attrJoin('class', 'has-column-widths')
    if (widths.some((width) => !width)) tokens[i].attrJoin('class', 'has-flexible-column')
    const cols = widths
      .map((w) => (w ? `<col style="width:${columnWidth(w)}">` : '<col>'))
      .join('')
    return `${renderOpen(tokens, i, options, env, self)}<colgroup>${cols}</colgroup>`
  }
}


/** Widths as long as the table is wide: a marker written for a narrower table
 *  — or one a column was added to since — still answers for every column. */
const padWidths = (widths, cols) =>
  Array.from({ length: cols }, (_, c) => widths[c] || 0)

export { WIDTHS, MIN_COLUMN_WIDTH, columnWidth, parseColumnWidths, padWidths, headerCells }
