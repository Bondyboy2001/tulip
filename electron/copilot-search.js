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
  return {
    query,
    opts: {
      caseSensitive: value.caseSensitive === true,
      wholeWord: value.wholeWord === true,
      regex: value.regex === true
    }
  }
}

module.exports = { REQUEST_PATH, RESULTS_PATH, isRequestPath, parseRequest }
