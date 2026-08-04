/** First ordered page whose measured bottom lies after `point`. `bounds` is
 *  lazy so a viewer reads layout for logarithmically many wrappers. */
export function firstPageEndingAfter (length, point, bounds) {
  let lo = 0
  let hi = length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bounds(mid).to <= point) lo = mid + 1
    else hi = mid
  }
  return lo
}
