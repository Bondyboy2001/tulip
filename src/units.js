/**
 * How big, said the way a person would say it — and said the same way
 * everywhere, so the Info pane, the file view and the environments list cannot
 * disagree about one number.
 *
 * Decimal, because that is what Finder and every other file manager shows, and
 * these figures are read beside one. There were three copies of this before,
 * and two of them divided by 1024 while labelling the result `kB` — so the
 * same file could be 1.0 kB in one pane and 1.1 kB in another, and neither was
 * the number the desktop showed.
 */
export function fileSize (bytes) {
  const n = Number(bytes) || 0
  if (n < 1000) return `${n} ${n === 1 ? 'byte' : 'bytes'}`
  const units = ['kB', 'MB', 'GB', 'TB']
  let size = n / 1000
  let at = 0
  while (size >= 1000 && at < units.length - 1) { size /= 1000; at++ }
  // One decimal place while it still says something, none once it does not.
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[at]}`
}
