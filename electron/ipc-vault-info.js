'use strict'

/* ------------------------------------------------------- vault info

   The two answers the reading panes ask for on every note switch and every
   keystroke, both read straight off the index:

   - `tags:vault` — every tag in the vault and how many notes carry it, the
     inventory the `#` completion offers.
   - `links:to` — which notes point here, which ones say the name without
     pointing, and what this note points at.

   Both are cached against the index generation, so an answer can never
   outlive the text it was built from. The link-resolution table — every
   note's basename and full path — travels with them: it depends on which
   notes exist rather than on what is in them, and main asks for it to be
   dropped (forgetTables) whenever the index gains or loses a key.

   The index itself, the link scanner's pure helpers and the tag store stay
   in main.js; they arrive through the context.
   ================================================================== */

const { ipcMain } = require('electron')
const path = require('node:path')
const { HASHTAG, entryHeadTags } = require('./vault-scan')
const { hitLines } = require('./search-scan')
const { escapeRe } = require('./vault-kinds')

/**
 * @param {{
 *   getVaultPath: () => string | null,
 *   ensureIndex: () => Promise<void>,
 *   getIndex: () => Map<string, any>,
 *   getIndexGeneration: () => number,
 *   fileTags: { all: () => Promise<Record<string, string[]>> },
 *   cleanFileTags: (values: unknown) => string[],
 *   stripExt: (p: string) => string,
 *   linkTarget: (rawTarget: string, fromKey: string, tables: any) => string | null,
 *   mergeSpans: (spans: [number, number][]) => [number, number][],
 *   wordBefore: string,
 *   wordAfter: string,
 *   codeOrLink: RegExp
 * }} ctx
 */
function makeVaultInfoDomain (ctx) {
  const {
    getVaultPath, ensureIndex, getIndex, getIndexGeneration, fileTags, cleanFileTags,
    stripExt, linkTarget, mergeSpans, wordBefore, wordAfter, codeOrLink
  } = ctx

  const index = getIndex

  /** One note's row in either list, with the first few places it is shown. */
  function mentionRow (key, entry, spots) {
    return {
      path: key,
      name: entry.name,
      hits: hitLines(entry.text, spots, 6),
      total: spots.length
    }
  }

  /* The tag inventory, good for one index generation. */
  /** @type {{ tag: string, notes: number }[] | null} */
  let tagCountsCache = null
  let tagCountsAt = -1

  /**
   * Every note's basename and full path, for resolving what a link names.
   *
   * Held between asks. This is asked for on every note switch, and it depends on
   * which notes exist rather than on what is in them — so it survives every edit
   * and is dropped only when the index gains or loses a key. Building it walks
   * every path in the vault through `stripExt`, `basename` and `toLowerCase`,
   * which is not work to repeat for a click that changed nothing.
   */
  /** @type {{ byBase: Map<string, string>, byPath: Map<string, string[]> } | null} */
  let linkTableCache = null

  function linkTables () {
    if (linkTableCache) return linkTableCache
    const byBase = new Map()
    const byPath = new Map()
    /* Keys composed (NFC) as well as lowercased, because the other side of the
       lookup — `normaliseTarget` — composes what the reader typed. A note whose
       filename a sync client stored decomposed would otherwise be unfindable by
       the very link the reader wrote for it. The stored value stays the exact
       path; only the key folds. */
    for (const key of index().keys()) {
      const bare = stripExt(key)
      byPath.set(bare.toLowerCase().normalize('NFC'), key)
      const base = path.basename(bare).toLowerCase().normalize('NFC')
      if (!byBase.has(base)) byBase.set(base, [])
      byBase.get(base).push(key)
    }
    linkTableCache = { byBase, byPath }
    return linkTableCache
  }

  /* The last few answers, each good for as long as the index it was read from.
     Nothing here was cached before: the whole vault was scanned again for the
     backlinks of a note on every switch to it — A, B, back to A — and again on
     every `vault:changed`, for a pane that mostly shows the same rows. The index
     generation moves on every write to the index, the reader's own autosave
     included, so an answer can never outlive the text it was built from. */
  const linksToMemo = new Map()
  const LINKS_TO_MEMO_KEPT = 8

  function computeLinksTo (notePath) {
    const none = { linked: [], unlinked: [], outgoing: [] }

    const self = index().get(notePath)
    if (!self) return none

    const tables = linkTables()
    const name = self.name

    /* Which notes this one links to — the other direction of the same question.
       One row per distinct target, first occurrence's line. A link that names
       nothing in the vault is kept and marked missing: it is a promise of a note
       rather than a reference to one, and the pane offers to create it. Self
       links (`[[#Heading]]`) name this note and are nobody's outgoing, so they
       are left out. */
    const outgoing = []
    {
      const scanner = new RegExp(codeOrLink.source, codeOrLink.flags)
      const seen = new Map()   // identity → index into outgoing
      const spots = []         // positions of first occurrences, in document order
      for (let m = scanner.exec(self.text); m; m = scanner.exec(self.text)) {
        const { link, target } = /** @type {{ link?: string, target: string }} */ (m.groups)
        if (!link) continue
        if (target.trim().startsWith('#')) continue   // `[[#Heading]]`: this note itself
        const resolved = linkTarget(target, notePath, tables)
        if (resolved === notePath) continue
        const identity = (resolved || link.toLowerCase())
        if (seen.has(identity)) continue
        seen.set(identity, outgoing.length)
        spots.push({ order: outgoing.length, at: m.index })
        /* What to call it: the note's own name when it resolved, the target as
           written when it did not — "Fundamentals" rather than
           "fundamentales 2" is the point of resolving. */
        const bare = target.split('#')[0].split('|')[0].trim()
        outgoing.push({
          target,
          path: resolved,
          name: resolved ? index().get(resolved)?.name || path.basename(stripExt(resolved)) : bare,
          missing: !resolved
        })
      }
      /* First occurrence per target — the place a click lands on. Counted here
         rather than through `hitLines`, which would collapse two links sharing a
         line into one row and misnumber every target after them. */
      let lineAt = 1
      let scanned = 0
      for (const spot of spots) {
        for (let i = self.text.indexOf('\n', scanned); i !== -1 && i < spot.at; i = self.text.indexOf('\n', i + 1)) lineAt++
        scanned = spot.at
        outgoing[spot.order].line = lineAt
      }
    }

    /* The name in prose. Whole-word, so a note called "Set" is not found inside
       every "Settings" in the vault — the same lookarounds the search's
       whole-word switch uses, and for the same reason.

       `present` is the same pattern without `g`, for rejecting a note outright.
       It has to be a regex and not `text.toLowerCase().includes(name)`: that
       lowercases a copy of every note in the vault on every note switch, which
       is megabytes of garbage per click. A case-insensitive regex scans the
       string where it lies. */
    let mention
    let present
    try {
      const body = `${wordBefore}${escapeRe(name)}${wordAfter}`
      mention = new RegExp(body, 'giu')
      present = new RegExp(body, 'iu')
    } catch {
      return none
    }

    /* A copy per ask. The shared one is global, and `rewriteLinks` drives it
       through `String.replace` — borrowing it here would mean two readers of one
       `lastIndex`. */
    const scanner = new RegExp(codeOrLink.source, codeOrLink.flags)

    const linked = []
    const unlinked = []

    for (const [key, entry] of index()) {
      if (key === notePath) continue
      /* The cheap rejection first, and it rejects nearly everything: a note that
         never says the name can hold neither a link to it nor a mention of it,
         and answering that costs one scan rather than three. */
      if (!entry.text || !present.test(entry.text)) continue

      const aimed = []
      /* Code spans, fenced blocks, and every wikilink — whether or not it points
         here. All of them are places where the name is already spoken for, so
         none of them can also be an unlinked mention. */
      const claimed = []

      scanner.lastIndex = 0
      for (let m = scanner.exec(entry.text); m; m = scanner.exec(entry.text)) {
        claimed.push([m.index, m.index + m[0].length])
        const groups = /** @type {{ link?: string, target: string }} */ (m.groups)
        if (!groups.link) continue
        if (linkTarget(groups.target, key, tables) === notePath) aimed.push(m.index)
      }
      if (aimed.length) linked.push(mentionRow(key, entry, aimed))

      /* Tags are spoken for too. `#project/tulip` names the note as surely as
         the prose does, but it is already a piece of structure — offering it as
         a link waiting to be made would be asking to turn a tag into something
         it was deliberately not. */
      HASHTAG.lastIndex = 0
      for (let m = HASHTAG.exec(entry.text); m; m = HASHTAG.exec(entry.text)) {
        claimed.push([m.index, m.index + m[0].length])
      }

      const spans = mergeSpans(claimed)
      const bare = []
      mention.lastIndex = 0
      for (let m = mention.exec(entry.text); m; m = mention.exec(entry.text)) {
        if (!inside(spans, m.index)) bare.push(m.index)
      }
      if (bare.length) unlinked.push(mentionRow(key, entry, bare))
    }

    const rank = (a, b) => b.total - a.total || a.name.localeCompare(b.name)
    linked.sort(rank)
    unlinked.sort(rank)

    return { linked: linked.slice(0, 200), unlinked: unlinked.slice(0, 200), outgoing: outgoing.slice(0, 200) }
  }

  /** Whether an offset sits inside any of the spans, which are sorted —
   *  found by bisection, the way it was written. */
  function inside (spans, at) {
    let lo = 0
    let hi = spans.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (at < spans[mid][0]) hi = mid - 1
      else if (at >= spans[mid][1]) lo = mid + 1
      else return true
    }
    return false
  }

  function register () {
    ipcMain.handle('tags:vault', async () => {
      if (!getVaultPath()) return []
      await ensureIndex()
      if (tagCountsCache && tagCountsAt === getIndexGeneration()) return tagCountsCache

      const taken = getIndexGeneration()
      const counts = new Map()
      const assigned = await fileTags.all()
      for (const tags of Object.values(assigned)) {
        for (const tag of cleanFileTags(tags) || []) counts.set(tag, (counts.get(tag) || 0) + 1)
      }
      for (const [key, entry] of index()) {
        if (!entry.text) continue
        const seenHere = new Set(cleanFileTags(assigned[key]))
        /* The head counts the same as the prose. A note that declares
           `tags: [book]` is a book-note whether or not it also says `#book`, and
           the inventory the `#` completion offers has to know the names a reader
           has already used — otherwise the tag they set in the Info pane is not
           offered back to them anywhere. */
        for (const tag of entryHeadTags(entry)) {
          if (seenHere.has(tag)) continue
          seenHere.add(tag)
          counts.set(tag, (counts.get(tag) || 0) + 1)
        }
        HASHTAG.lastIndex = 0
        for (let m = HASHTAG.exec(entry.text); m; m = HASHTAG.exec(entry.text)) {
          const tag = m[2].toLowerCase()
          if (seenHere.has(tag)) continue
          seenHere.add(tag)
          counts.set(tag, (counts.get(tag) || 0) + 1)
        }
      }

      const table = [...counts]
        .map(([tag, notes]) => ({ tag, notes }))
        .sort((a, b) => b.notes - a.notes || a.tag.localeCompare(b.tag))
      /* Only if nothing moved across the await above: a count taken partly before
         an edit and partly after describes a vault that never existed, and holding
         it would keep saying so. */
      if (getIndexGeneration() === taken) {
        tagCountsCache = table
        tagCountsAt = taken
      }
      return table
    })

    ipcMain.handle('links:to', async (_e, notePath) => {
      const none = { linked: [], unlinked: [], outgoing: [] }
      if (!getVaultPath() || !notePath) return none
      await ensureIndex()
      const held = linksToMemo.get(notePath)
      if (held && held.generation === getIndexGeneration() && held.vault === getVaultPath()) return held.answer
      const answer = computeLinksTo(notePath)
      linksToMemo.delete(notePath)
      linksToMemo.set(notePath, { generation: getIndexGeneration(), vault: getVaultPath(), answer })
      while (linksToMemo.size > LINKS_TO_MEMO_KEPT) linksToMemo.delete(linksToMemo.keys().next().value)
      return answer
    })
  }

  /** The set of notes changed — the table is rebuilt on the next ask. */
  function forgetTables () {
    linkTableCache = null
  }

  return { register, forgetTables }
}

module.exports = { makeVaultInfoDomain }
