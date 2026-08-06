/* ============================================================== the tab strip
   The order of the strip, and which tabs a "close the others" takes with it.

   Index arithmetic, kept out of renderer.js and kept pure, because this is the
   one part of the strip whose mistakes are both silent and destructive. A close
   that computes one index wrong closes a document the reader meant to keep, and
   what it leaves behind looks entirely plausible — a strip of tabs, one of them
   showing. There is nothing to notice, so it has to be tested instead.

   THE INVARIANT the rest of the file is written against: pinned tabs occupy the
   front of the strip, in their own order, and every unpinned tab follows them.
   It is what makes "close to the right" mean something stable — the tabs you
   deliberately kept never drift into the range a close sweeps through — and it
   is the convention every browser has taught people to expect. Both movers
   below re-establish it, and `settled` restores it after a drag that broke it.
*/

/** How many tabs are pinned — and, by the invariant, where the unpinned start. */
export const pinCount = (tabs) => tabs.filter((t) => t.pinned).length

/**
 * `tabs` reordered so pinned ones lead, each group keeping its own order.
 *
 * Stable on purpose: this runs after a drag, and a drag that stayed inside one
 * group is a reordering the reader asked for. Only a tab carried across the
 * boundary moves back, and it moves the shortest distance that satisfies the
 * invariant rather than to wherever it started.
 *
 * @param {Array<{pinned?: boolean}>} tabs
 */
export const settled = (tabs) => [
  ...tabs.filter((t) => t.pinned),
  ...tabs.filter((t) => !t.pinned)
]

/**
 * Pin or unpin the tab at `at`, and put it where that leaves it.
 *
 * A newly pinned tab joins the end of the pinned block rather than the front:
 * pinning is "keep this one too", not "this one first". A newly unpinned tab
 * lands at the front of the unpinned block for the same reason read backwards —
 * it has just left the group it was in, and the nearest place outside it is
 * where the eye last had it.
 *
 * Returns a new array and the index the same tab now sits at, so the caller can
 * keep `tabIndex` pointing at whatever was showing.
 *
 * The tab OBJECT is carried over rather than copied, and its `pinned` is set on
 * it. A tab is an identity elsewhere in the app, not just a record: the strip's
 * buttons hold one each to survive a drag, the closed-tab stack holds the ones
 * it can put back, and an open still in flight holds the tab it is filling and
 * finds it again by `indexOf`. Handing back a copy would quietly orphan all
 * three. So this is pure in the array and deliberately not in the tab.
 *
 * @param {Array<{pinned?: boolean}>} tabs
 * @param {number} at
 * @param {boolean} pinned
 * @returns {{tabs: Array<object>, index: number}}
 */
export function repin (tabs, at, pinned) {
  const tab = tabs[at]
  if (!tab) return { tabs: tabs.slice(), index: at }

  tab.pinned = pinned
  const rest = tabs.filter((_, i) => i !== at)
  /* Measured on `rest`, after the tab has been lifted out: counting pins with
     it still in place puts a tab being unpinned one slot too far right. */
  const to = pinCount(rest)
  rest.splice(to, 0, tab)
  return { tabs: rest, index: to }
}

/**
 * The tabs a "Close others" closes: everything except `keep`, and except the
 * pinned ones.
 *
 * Pinned tabs surviving a bulk close is the whole point of pinning them — the
 * gesture means "clear this away", and a tab that was pinned is a statement
 * that it is not part of the away.
 *
 * Descending, so a caller splicing them out one at a time never invalidates an
 * index it has not used yet.
 *
 * @param {Array<{pinned?: boolean}>} tabs
 * @param {number} keep
 * @returns {number[]}
 */
export function othersOf (tabs, keep) {
  return sweep(tabs, (tab, i) => i !== keep)
}

/**
 * The tabs a "Close to the right" closes: everything after `from`, except the
 * pinned ones.
 *
 * Pinned tabs cannot in fact appear to the right of an unpinned `from` — the
 * invariant puts them all in front of it — but they can when `from` is itself
 * pinned, and there the exclusion is what stops "close to the right" on the
 * first pinned tab throwing away every other pin.
 *
 * @param {Array<{pinned?: boolean}>} tabs
 * @param {number} from
 * @returns {number[]}
 */
export function rightOf (tabs, from) {
  return sweep(tabs, (tab, i) => i > from)
}

/** Indices matching `want`, minus the pinned, highest first. */
function sweep (tabs, want) {
  const doomed = []
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (!tabs[i].pinned && want(tabs[i], i)) doomed.push(i)
  }
  return doomed
}
