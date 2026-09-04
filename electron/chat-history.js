'use strict'

/**
 * The copilot's transcripts, merged rather than replaced.
 *
 * The panel used to send its whole history on every write — sixty notes'
 * conversations serialised, cloned across the bridge and stringified again on
 * this side, several times a minute for the length of a turn, almost always
 * because one note had gained a row. It sends the notes it has something new to
 * say about instead, and this is what puts them where they go.
 *
 * Pure, and here rather than in main.js, because it is the one piece of that
 * exchange that can be got wrong quietly: a merge that drops the wrong side
 * loses conversations, and nothing on screen would show it until the next
 * launch opened without them.
 */

/* How many notes' conversations the file keeps. The renderer holds the same
   number in memory, but the two are no longer the same set — it writes only
   what changed — so the cap on the record itself is applied here. */
const MAX_CHAT_NOTES = 60

/* How many conversations per note survive a merge. The panel trims to 20 in
   memory; the file keeps the same bound so a trim in one window cannot erase
   conversations another window still holds but has not dirtied. */
const MAX_CONVOS_PER_NOTE = 20

/**
 * The merge is by note, not by conversation: what the window holds for a note
 * is the whole truth about that note, and merging deeper would resurrect chats
 * `/new` had put away — except that a whole-note replace also drops convos the
 * writer had already trimmed from memory. So per note, union by conversation
 * id (writer wins on id collision), then trim oldest-first. Explicit removals
 * still win: they are applied before the writes, so a note renamed onto a name
 * being written in the same breath keeps the write rather than losing it to
 * its own rename.
 */
function mergeChatHistory (existing, update) {
  /* An older renderer sends the history whole, with note paths at the top
     level. Recognised by the absence of the envelope rather than by a version
     number: a bare map has no `notes` key, and no note is ever called that. */
  if (!update || typeof update !== 'object') return existing || {}
  if (!update.notes || typeof update.notes !== 'object') return update

  const merged = { ...(existing && typeof existing === 'object' ? existing : {}) }
  for (const path of Array.isArray(update.remove) ? update.remove : []) delete merged[path]
  for (const [path, entry] of Object.entries(update.notes)) {
    if (!path || !entry) continue
    const prev = merged[path]
    if (!prev || !Array.isArray(prev.convos) || !Array.isArray(entry.convos)) {
      merged[path] = entry
      continue
    }
    // Union by conversation id: the writer's version wins on collision, and
    // convos the writer trimmed from memory survive on disk. On equal `at`
    // the writer's order wins, so the fresh write reads first.
    const byId = new Map()
    const order = new Map()
    let seq = 0
    for (const convo of prev.convos) if (convo?.id && !byId.has(convo.id)) {
      byId.set(convo.id, convo)
      order.set(convo.id, 1e9 + (seq++))
    }
    for (const convo of entry.convos) if (convo?.id) {
      byId.set(convo.id, convo)
      order.set(convo.id, seq++)
    }
    const convos = [...byId.values()].sort((a, b) => {
      const gap = (Number(b?.at) || 0) - (Number(a?.at) || 0)
      if (gap) return gap
      return (order.get(a?.id) ?? 0) - (order.get(b?.id) ?? 0)
    }).slice(0, MAX_CONVOS_PER_NOTE)
    const hadActive = entry.active != null || prev.active != null
    const active = entry.active && byId.has(entry.active)
      ? entry.active
      : !entry.active && prev.active && byId.has(prev.active) ? prev.active : entry.active
    const next = { ...entry, convos, at: Math.max(Number(entry.at) || 0, Number(prev.at) || 0) }
    if (hadActive) next.active = active
    else delete next.active
    merged[path] = next
  }

  const paths = Object.keys(merged)
  if (paths.length <= MAX_CHAT_NOTES) return merged
  // Oldest out, by the same reading of `at` the panel sorts its own by.
  const kept = paths
    .sort((a, b) => (Number(merged[b]?.at) || 0) - (Number(merged[a]?.at) || 0))
    .slice(0, MAX_CHAT_NOTES)
  return Object.fromEntries(kept.map((path) => [path, merged[path]]))
}

module.exports = { mergeChatHistory, MAX_CHAT_NOTES, MAX_CONVOS_PER_NOTE }
