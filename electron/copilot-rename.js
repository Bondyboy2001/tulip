'use strict'

/*
 * Copilot cannot call Electron IPC directly. Its one portable write surface is
 * a file tool, so a tiny Tulip-owned request file is the bridge: all three
 * providers can write it, main consumes it, and the actual rename still goes
 * through Tulip's link/history-aware relocation path.
 */
const REQUEST_PATH = '.tulip-copilot-rename.json'

const normal = (value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
const isRequestPath = (value) => normal(value) === REQUEST_PATH

function parseRequest (source) {
  let value
  try { value = JSON.parse(String(source || '')) } catch {
    throw new Error('The Copilot rename request was not valid JSON.')
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('The Copilot rename request must be an object.')
  }
  const path = normal(value.path).trim()
  const name = String(value.name || '').trim()
  if (!path || !name) {
    throw new Error('The Copilot rename request needs both "path" and "name".')
  }
  const turnId = typeof value.turnId === 'string' && value.turnId.length <= 120 ? value.turnId : null
  const at = Number(value.at) > 0 ? Number(value.at) : null
  return { path, name, turnId, at }
}

const REQUEST_TTL_MS = 10 * 60 * 1000
function isStaleRequest (request, now = Date.now()) {
  return !!request?.at && (now - request.at > REQUEST_TTL_MS)
}

module.exports = { REQUEST_PATH, isRequestPath, parseRequest, isStaleRequest, REQUEST_TTL_MS }
