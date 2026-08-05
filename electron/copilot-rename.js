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
  return { path, name }
}

module.exports = { REQUEST_PATH, isRequestPath, parseRequest }
