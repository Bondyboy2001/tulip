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

/**
 * The merge is by note, not by conversation: what the window holds for a note
 * is the whole truth about that note, and merging deeper would resurrect chats
 * `/new` had put away.
 *
 * Removals are applied before the writes, so a note renamed onto a name being
 * written in the same breath keeps the write rather than losing it to its own
 * rename.
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
    if (path && entry) merged[path] = entry
  }

  const paths = Object.keys(merged)
  if (paths.length <= MAX_CHAT_NOTES) return merged
  // Oldest out, by the same reading of `at` the panel sorts its own by.
  const kept = paths
    .sort((a, b) => (Number(merged[b]?.at) || 0) - (Number(merged[a]?.at) || 0))
    .slice(0, MAX_CHAT_NOTES)
  return Object.fromEntries(kept.map((path) => [path, merged[path]]))
}

module.exports = { mergeChatHistory, MAX_CHAT_NOTES }
