'use strict'

/**
 * A Copilot rejection is an inverse operation, not an arbitrary trip through
 * history. It is safe only while every target still equals the version that
 * Copilot left behind; otherwise restoring `before` would erase work made
 * after the turn by the reader, a sync client, or another editor.
 */
function restoreConflicts (operation, currentByPath) {
  if (operation?.source !== 'copilot') return []
  const current = currentByPath instanceof Map
    ? currentByPath
    : new Map(Object.entries(currentByPath || {}))
  return (operation.changes || [])
    .filter((change) => current.get(change.path) !== change.after)
    .map((change) => change.path)
}

module.exports = { restoreConflicts }
