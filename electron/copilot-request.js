'use strict'

/*
 * What the Copilot request files share: the search, the rename and the write
 * each arrive as a small JSON file the agent drops in the vault, and each
 * carries the turn's timestamp so a stale file left by a crash never runs as
 * the next turn's question. Three copies of the same ten-millisecond
 * comparison is how the three drift — the TTL changed in one and not the
 * others — so the clock lives here, once. The request shapes stay with their
 * owners: a search needs a query and a write needs its edits list, and one
 * parser for all three would have to know every shape to check any of them.
 */
const REQUEST_TTL_MS = 10 * 60 * 1000

const normal = (value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')

function isStaleRequest (request, now = Date.now()) {
  return !!request?.at && (now - request.at > REQUEST_TTL_MS)
}

module.exports = { REQUEST_TTL_MS, normal, isStaleRequest }
