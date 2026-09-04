'use strict'

/*
 * The vault search, offered to the Copilot the way the rename is: through a
 * request file, because a file tool is the one write surface every CLI has.
 * The agent writes `.tulip-copilot-search.json`, main answers by writing the
 * results file beside it and deleting the request — the agent then reads the
 * results with its ordinary file tool. What this buys over the agent's own
 * grep is Tulip's actual search: ranked results, `tag:`/`path:`/`prop:`
 * filters, quoted phrases, and the extracted text of every PDF.
 */
const REQUEST_PATH = '.tulip-copilot-search.json'
const RESULTS_PATH = '.tulip-copilot-search-results.json'

const normal = (value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
const isRequestPath = (value) => normal(value) === REQUEST_PATH

function parseRequest (source) {
  let value
  try { value = JSON.parse(String(source || '')) } catch {
    throw new Error('The Copilot search request was not valid JSON.')
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('The Copilot search request must be an object.')
  }
  const query = String(value.query || '').trim()
  if (!query) throw new Error('The Copilot search request needs a "query".')
  // Turn-scoped when the agent cooperates: a stale request file left by a
  // crash must not run as the next turn's question. Main compares `turnId`
  // against the turn that wrote the file and drops mismatches; `at` bounds
  // how long a request stays runnable.
  const turnId = typeof value.turnId === 'string' && value.turnId.length <= 120 ? value.turnId : null
  const at = Number(value.at) > 0 ? Number(value.at) : null
  return {
    query,
    turnId,
    at,
    opts: {
      caseSensitive: value.caseSensitive === true,
      wholeWord: value.wholeWord === true,
      regex: value.regex === true
    }
  }
}

const REQUEST_TTL_MS = 10 * 60 * 1000
function isStaleRequest (request, now = Date.now()) {
  return !!request?.at && (now - request.at > REQUEST_TTL_MS)
}

module.exports = { REQUEST_PATH, RESULTS_PATH, isRequestPath, parseRequest, isStaleRequest, REQUEST_TTL_MS }
