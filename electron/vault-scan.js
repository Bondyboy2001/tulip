'use strict'

/* ==================================================== the vault-wide scan
   The loop that runs over every indexed file in the vault on every keystroke
   somebody types into the search box, and the tests it applies to each one.

   Its own module for two reasons, both of which `electron/search-scan.js`
   already gives as its own. It is pure — no filesystem, no Electron, no index
   — so it can be tested and measured without standing an app up around it. And
   it is the hot path: `search-scan.js` owns the per-note half, this owns the
   per-vault half, and between them they are the whole of what a search costs.

   ⚠️ THE THING THIS MODULE EXISTS TO GET RIGHT. The scan used to run to
   completion synchronously on the main process. Main is also what serves every
   autosave write, every watcher event and every other IPC call in the app, so a
   scan of a large vault was a stall in all of them — felt as the editor
   hesitating, which is the last place anybody would look for a search bug. And
   because nothing could interrupt it, typing a seven-letter word ran seven
   complete scans of the vault, six of whose answers were thrown away before
   anyone saw them.

   So `scanKind` yields. It gives the event loop a turn every few milliseconds,
   and it asks `stop()` whether a newer query has arrived — because the newest
   query is the only one anybody is waiting for, and the six before it are work
   nobody will ever look at.

   ⚠️ AND THE THING A CALLER MUST GET RIGHT. A scan that stopped early has not
   seen the whole vault, so its list of matching keys is not a list of
   everything that matched. Handing that to the narrowing cache in
   `electron/search-narrow.js` would make the *next*, longer query search a set
   with notes missing from it — a result list that looks complete and is not,
   which is the worst failure a search can have. `scanKind` says `stopped: true`
   and the caller must throw the whole answer away rather than record any of it.
*/

const { findSpots, hitLines } = require('./search-scan')
const { parseFrontmatter, propsOf, propValues, tagsFromProps } = require('./frontmatter.cjs')

/* A tag as it is written in prose. Exported because the vault's tag inventory
   and the unlinked-mentions scan both walk notes with it, and one expression
   for "this is a tag" is the only way those can agree with the search. */
const HASHTAG = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}/_-]*)/gu

/**
 * The tags a note's prose carries, found once and held against the entry —
 * the same arrangement as `entryProps` and `entryHeadTags` below, and for the
 * same reason: a `tag:` query asks every note on every keystroke, and the
 * walk over the whole text was the one of the three answers not remembered.
 * The entry is replaced wholesale when the note changes, so this cannot go
 * stale; `index-cache.js` keeps only the four fields it loads, so it is not
 * written to disk.
 */
function entryProseTags (entry) {
  if (entry.proseTags === undefined) {
    const tags = new Set()
    HASHTAG.lastIndex = 0
    for (let m = HASHTAG.exec(entry.text); m; m = HASHTAG.exec(entry.text)) tags.add(m[2].toLowerCase())
    entry.proseTags = tags
  }
  return entry.proseTags
}

function entryHasProseTag (entry, wanted) {
  for (const tag of entryProseTags(entry)) {
    if (tag === wanted || tag.startsWith(`${wanted}/`)) return true
  }
  return false
}

/**
 * A note's properties, parsed once and held against the entry. The object is
 * replaced wholesale by `syncIndex`/`touchIndex` when the note changes, so
 * caching on it cannot hand back stale values.
 */
function entryProps (entry) {
  if (entry.props === undefined) {
    entry.props = propsOf(parseFrontmatter(entry.text))
  }
  return entry.props
}

/**
 * The tags a note's own head declares, held against the entry the way its
 * properties are — and for the same reason: the tag filter asks once per note
 * per keystroke, and the answer changes only when the note does.
 */
function entryHeadTags (entry) {
  if (entry.headTags === undefined) entry.headTags = tagsFromProps(entryProps(entry))
  return entry.headTags
}

/** Whether a list of tag names holds `wanted`, or anything nested under it. */
const listHasTag = (tags, wanted) =>
  tags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`))

/**
 * Whether a note survives the query's filters, answered before it is read.
 *
 * Each test is skipped when nothing asked for it. Most queries carry no filter
 * at all, and lowercasing a path and a name per note per keystroke is two
 * allocations for every note in the vault to answer a question nobody asked.
 * Ordered cheapest first: the tag and property tests are the only ones that
 * walk the text, and the property one walks only its head.
 *
 * `facts` is what this *query* knows about the entry — its kind, and the tags
 * assigned to its path — as opposed to what the index holds about the note.
 *
 * Passed in rather than read off the entry because the two used to be the same
 * object: the search loop wrote `kind` and `fileTags` onto every entry in the
 * index, for every note in the vault, on every keystroke. That is a vault's
 * worth of writes into a long-lived cache to carry one query's worth of state
 * — and the state leaked, far enough that `index-cache.js` has to strip both
 * fields back out before it is allowed to write the cache to disk.
 *
 * The lowercased name and key are held against the entry the way its
 * properties are: the entry is replaced wholesale when the note changes, so a
 * cached lowercase cannot go stale — and `key` is pinned beside it, so a
 * renamed entry carrying an old object under a new key re-derives once rather
 * than answering for the wrong path. `index-cache.js` strips unknown fields
 * before writing (see the four fields it keeps), so these never reach disk.
 */
function lowerNameOf (key, entry) {
  if (entry.cacheKey !== key || entry.lowerName === undefined) {
    entry.cacheKey = key
    entry.lowerName = entry.name.toLowerCase()
    entry.lowerKey = key.toLowerCase()
  }
  return entry.lowerName
}

function lowerKeyOf (key, entry) {
  if (entry.cacheKey !== key || entry.lowerKey === undefined) {
    entry.cacheKey = key
    entry.lowerName = entry.name.toLowerCase()
    entry.lowerKey = key.toLowerCase()
  }
  return entry.lowerKey
}

/* A literal term answered without the regex engine. `termRegex` in main
   escapes the term and adds only a case flag, so for ASCII text a lowercased
   `includes` is the same answer — and a name is a few dozen characters the
   engine would otherwise be entered for. Non-ASCII keeps the regex, whose `i`
   folding and `toLowerCase` do not always agree. */
function nameHas (term, lowerName, name) {
  if (term.literalFold !== undefined) return lowerName.includes(term.literalFold)
  if (term.literal !== undefined) return name.includes(term.literal)
  return term.has.test(name)
}
function passesFilters (key, entry, filters, facts = entry) {
  if (filters.type.length && !filters.type.every((kind) => kind === facts.kind)) return false
  if (filters.path.length) {
    const where = lowerKeyOf(key, entry)
    if (!filters.path.every((p) => where.includes(p))) return false
  }
  if (filters.file.length) {
    const named = lowerNameOf(key, entry)
    if (!filters.file.every((f) => named.includes(f))) return false
  }
  if (filters.tag.length) {
    /* Three places a tag can be, asked cheapest first. The assigned list is
       already in hand; the head is a parse of the first few lines, memoised;
       the hashtag scan walks the whole note and is therefore last. */
    const assigned = facts.fileTags || []
    if (!filters.tag.every((wanted) =>
      listHasTag(assigned, wanted) ||
      listHasTag(entryHeadTags(entry), wanted) ||
      entryHasProseTag(entry, wanted))) return false
  }
  if (filters.prop.length) {
    const props = entryProps(entry)
    for (const { key: wantKey, value: wantValue } of filters.prop) {
      const prop = props.find((p) => p.key.toLowerCase() === wantKey)
      if (!prop) return false
      /* No value asked: existence. With one: equality against any of the
         property's values — one for a scalar, one per item for a list, all
         compared lowercase, so `prop:status=Reading` finds `status: reading`. */
      if (wantValue === null || wantValue === '') continue
      if (!propValues(prop).includes(wantValue)) return false
    }
  }
  return true
}

/* How long the scan may hold the event loop before letting go, and how often it
   is worth asking the clock.
 *
 * Four milliseconds is a quarter of a frame: short enough that a write, a
 * watcher event or another IPC call waiting behind the scan is served inside
 * one, and long enough that the yielding itself is not the cost. Sixty-four
 * notes between clock reads because `performance.now()` on every note in a
 * ten-thousand-note vault is a measurable fraction of the scan it is measuring.
 */
const SLICE_MS = 4
const NOTES_PER_CLOCK_READ = 64

/** A turn for everything else. `setImmediate` runs after the I/O callbacks
 *  already queued, which is exactly the work being made room for. */
const breathe = () => new Promise((resolve) => setImmediate(resolve))

/**
 * One kind's worth of the vault, scanned against a compiled query.
 *
 * @param entries    an iterable of `[key, entry]` — the whole index for this
 *                   kind, or the narrowed subset of it
 * @param query      what `compileQuery` produced
 * @param narrowed   true when `entries` is a previous answer being narrowed, in
 *                   which case the filters have already been applied to it
 * @param kindOf     (entry) => the kind to report a result as
 * @param factsFor   (key, entry) => what the query knows about this entry
 * @param limit      the size past which a file is reported unread rather than
 *                   scanned
 * @param rankHeadings  whether a term in a heading counts towards the score —
 *                   true for notes, whose headings mean something
 * @param stop       () => true when a newer query has made this one pointless
 *
 * @returns `{ keys, results, unsearched, stopped }`. `stopped` means the vault
 *          was not seen to the end, and the caller must discard everything here
 *          rather than record it — see the warning at the top of this file.
 */
async function scanKind ({
  entries, query, narrowed, kindOf, factsFor, limit, rankHeadings = false, stop = () => false
}) {
  const keys = []
  const results = []
  const unsearched = []

  let since = Date.now()
  let counted = 0

  for (const [key, entry] of entries) {
    /* The clock, and the chance to stand aside, on the same schedule. Both are
       asked between notes rather than inside one: a single note's scan is
       bounded by `MAX_INDEX_BYTES` and there is nothing useful to do in the
       middle of it. */
    if (++counted % NOTES_PER_CLOCK_READ === 0) {
      if (stop()) return { keys, results, unsearched, stopped: true }
      const now = Date.now()
      if (now - since >= SLICE_MS) {
        await breathe()
        if (stop()) return { keys, results, unsearched, stopped: true }
        since = Date.now()
      }
    }

    /* `factsFor` is one closure call plus one object per note per keystroke,
       and the only readers of what it returns are the `type` and `tag` tests
       above. A plain text query — the common case — asks neither, so the facts
       are built lazily and never at all for it. */
    const needsFacts = query.filters.type.length > 0 || query.filters.tag.length > 0
    const facts = needsFacts ? factsFor(key, entry) : entry
    if (!narrowed && !passesFilters(key, entry, query.filters, facts)) continue

    /* A filter on its own is a query: `tag:book` asks for the notes carrying
       it, and the note's opening line is the only context there is to show. */
    if (!query.terms.length) {
      keys.push(key)
      results.push({
        path: key, name: entry.name, kind: kindOf(entry),
        hits: hitLines(entry.text, [0], 1), total: 0, score: 0
      })
      continue
    }

    if (entry.size > limit) {
      unsearched.push(key)
      /* Carried forward even though it matched nothing: it passed the filters,
         and the narrower query still has to be able to report that this file
         went unread rather than quietly dropping the caveat. */
      keys.push(key)
      continue
    }

    const found = findSpots(entry.text, query.terms)
    if (!found) continue
    const hits = hitLines(entry.text, found.spots)

    /* What a file is worth, rather than how often it repeats itself. A term in
       the title is the strongest signal a vault offers — it is what someone
       typing two words is usually reaching for — and, in a note, a term in a
       heading says there is a section about it rather than a passing mention. */
    const lowerName = lowerNameOf(key, entry)
    const named = query.terms.filter((term) => nameHas(term, lowerName, entry.name)).length
    const score = found.total + named * 8 +
      (rankHeadings ? hits.filter((hit) => hit.heading).length * 3 : 0)

    keys.push(key)
    results.push({ path: key, name: entry.name, kind: kindOf(entry), hits, total: found.total, score })
  }

  return { keys, results, unsearched, stopped: false }
}

module.exports = {
  HASHTAG,
  entryProps,
  entryHeadTags,
  nameHas,
  passesFilters,
  scanKind
}
