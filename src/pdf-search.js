/**
 * Case-folded, one code unit for one code unit.
 *
 * `String.prototype.toLowerCase` is not length-preserving: a handful of
 * characters fold to more than they started as — Turkish `İ` (U+0130) becomes
 * `i` followed by a combining dot, and the Greek and Armenian ligatures do the
 * same. Folding a whole page with it therefore shifts every offset after the
 * first such character, and the offsets are the whole point: a hit found in the
 * folded page is reported as a span of the displayed one, and `itemAtOffset`
 * turns it into a height on the page. One character further along than it
 * should be is an excerpt that starts mid-word and a ⌘F that scrolls to the
 * wrong line.
 *
 * So the fold is done per code unit and the first unit of a longer answer is
 * kept — `İ` folds to `i`, which is also what a reader typing it means — and
 * anything that folds to nothing keeps what it was rather than closing up.
 */
export function foldCase (text) {
  let out = ''
  for (let at = 0; at < text.length; at++) {
    const lower = text[at].toLowerCase()
    out += lower.length === 1 ? lower : (lower[0] || text[at])
  }
  return out
}

/** Normalize one page once and translate text-item offsets into the normalized
 *  coordinate system used by PDF search. */
export function searchablePage (text, items) {
  let display = ''
  let whitespace = false
  let itemAt = 0
  const searchableItems = []

  for (let rawAt = 0; rawAt <= text.length; rawAt++) {
    while (itemAt < items.length && items[itemAt].at <= rawAt) {
      searchableItems.push({ at: display.length, y: items[itemAt].y })
      itemAt++
    }
    if (rawAt === text.length) break
    const char = text[rawAt]
    if (/\s/.test(char)) {
      if (!whitespace) display += ' '
      whitespace = true
    } else {
      display += char
      whitespace = false
    }
  }
  return { display, search: foldCase(display), items: searchableItems }
}

/** Last text item beginning at or before a normalized hit offset. */
export function itemAtOffset (items, offset) {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].at <= offset) lo = mid + 1
    else hi = mid
  }
  return lo ? items[lo - 1] : null
}
