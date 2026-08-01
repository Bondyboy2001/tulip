/**
 * How long ago, said the way a person would say it — and said the same way
 * everywhere: the chat list and the history panel answer "when?" in one voice.
 *
 * Relative while the moment is still fresh enough to count in minutes, then a
 * clock time, because "3 hr ago" is arithmetic the reader has to undo and
 * "2:41 PM" is not.
 */
export function when (at) {
  if (!at) return ''
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const date = new Date(at)
  const mark = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === mark.toDateString()) return time
  mark.setDate(mark.getDate() - 1)
  if (date.toDateString() === mark.toDateString()) return `Yesterday ${time}`
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}
