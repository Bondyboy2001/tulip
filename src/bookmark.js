/* ============================================================ bookmark

   One place in a note to come back to. It lives in the note itself, as a
   comment on a line of its own, so it travels with the file — into another
   editor, a sync client, a backup — and any tool that does not know it draws
   nothing for it. The two views that do know it draw the same ribbon: a
   hairline across the page with a bookmark hanging over it. One per note: the
   second replaces the first, which is what makes it a bookmark rather than a
   list of them. */

export const BOOKMARK_LINE = '<!-- bookmark -->'

/** Whether one line of a note is the bookmark. */
export function isBookmarkLine (line) {
  return line.trim() === BOOKMARK_LINE
}

/** The 1-based line the bookmark sits on, or 0 when the note has none. */
export function bookmarkLineOf (text) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) if (isBookmarkLine(lines[i])) return i + 1
  return 0
}

/**
 * The ribbon's markup, shared by the reading view's rule and the editor's
 * widget so the two cannot drift apart: a strip with a swallowtail cut, the
 * shape a bookmark has where it hangs out of a book, and a thin lighter
 * stripe down its middle that makes it read as cloth rather than a flat tag.
 */
export function bookmarkMarkup () {
  return '<span class="bookmark-ribbon"><svg viewBox="0 0 12 20" aria-hidden="true">' +
    '<path class="bookmark-strip" d="M0 0h12v19.2l-6-4.4-6 4.4z"/>' +
    '<path class="bookmark-stripe" d="M5.1 0h1.8v14.4l-.9-.7-.9.7z"/>' +
    '</svg></span>'
}

/** Insert one bookmark above a 1-based line, normalising only its surrounding
 * blank lines. Return a minimal edit so unrelated editor ranges stay intact. */
export function bookmarkInsertion (text, line) {
  const lines = text.split('\n')
  const index = Math.max(0, Math.min(lines.length - 1, line - 1))
  const before = lines.slice(0, index).filter(line => !isBookmarkLine(line))
  const after = lines.slice(index).filter(line => !isBookmarkLine(line))
  while (before.length && !before.at(-1).trim()) before.pop()
  while (after.length && !after[0].trim()) after.shift()
  const prefix = before.length ? before.join('\n') + '\n\n' : '\n'
  const result = prefix + BOOKMARK_LINE + '\n\n' + after.join('\n')
  let from = 0
  while (from < text.length && from < result.length && text[from] === result[from]) from++
  let to = text.length
  let end = result.length
  while (to > from && end > from && text[to - 1] === result[end - 1]) { to--; end-- }
  return { from, to, insert: result.slice(from, end), anchor: prefix.length + BOOKMARK_LINE.length + 2 }
}
