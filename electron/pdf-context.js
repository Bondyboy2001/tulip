'use strict'

/* Page-level retrieval for Copilot. The complete sidecar remains available to
 * the CLI, but the first prompt carries a small set of locally ranked pages so
 * an ordinary question does not spend a tool call and a context window reading
 * an entire book. No embeddings or network service: PDF text stays local. */

const STOP = new Set([
  'about', 'after', 'again', 'also', 'attached', 'before', 'could', 'document',
  'explain', 'from', 'have', 'into', 'page', 'paper', 'please', 'should',
  'summarise', 'summarize', 'summary', 'that', 'their', 'there', 'these', 'they',
  'this', 'those', 'what', 'when', 'where', 'which', 'with', 'would', 'your',
  /* A turn that only keeps the conversation going — thanks, continue, yes —
     has no topic to search a book for. Left out of the stoplist it would
     "rank" whole pages for the word "thanks" on every follow-up. */
  'thanks', 'thank', 'continue', 'yes', 'yeah', 'yep', 'ok', 'okay', 'sure',
  'great', 'cool', 'done', 'perfect', 'nice', 'cheers', 'right', 'correct',
  'exactly', 'got', 'go', 'next', 'more',
  /* Question scaffolding and function words. They appear on nearly every page
     of a book, so scoring on them is noise that inflates the page budget. */
  'the', 'and', 'but', 'for', 'not', 'was', 'were', 'are', 'is', 'do', 'does',
  'did', 'can', 'will', 'would', 'could', 'may', 'might', 'must', 'than',
  'then', 'too', 'very', 'just', 'its', 'his', 'her', 'them', 'say', 'says',
  'said', 'tell', 'know', 'see', 'look', 'find', 'show', 'make', 'come',
  'think', 'want', 'need', 'get', 'being', 'been', 'has', 'have', 'had',
  'who', 'whom', 'whose', 'how', 'why', 'also', 'over', 'under', 'through'
])

const PAGE = /^--- page (\d+) of (\d+) ---\s*$/gm

/* The sidecar's second line says how its text was got — see `formatPdfText` in
   src/pdf-text-layout.js, which writes it. Read here rather than sniffed for,
   because the alternative was scanning a whole book for the words "Vision OCR"
   to recover a number the header states outright, in a third module that had
   taught itself the file's wording. */
const OCR_PAGES = /^.* — \d+ pages?, .*Vision OCR on (\d+) pages?\.$/m

const ocrPagesOf = (text) => Number(String(text || '').match(OCR_PAGES)?.[1] || 0)

const folded = (text) => String(text || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()

/**
 * The sidecar, cut into pages, each carrying the folded copy it is compared
 * against.
 *
 * Folded here, once, rather than when a page is first scored. Ranking reads
 * every page of every document in play, and folding a book to compare it with
 * six words is most of what that costs — and the caller keeps these pages for
 * as long as the file behind them is unchanged, so folding at build time gets
 * exactly the reuse a memo would without one module quietly writing into
 * another's cache.
 */
function parsePages (text) {
  const source = String(text || '')
  const markers = [...source.matchAll(PAGE)]
  return markers.map((marker, index) => {
    const body = source.slice(marker.index + marker[0].length,
      markers[index + 1]?.index ?? source.length).trim()
    return {
      page: Number(marker[1]),
      pages: Number(marker[2]),
      text: body,
      folded: folded(body)
    }
  })
}

function queryTerms (query) {
  return [...new Set((folded(query).match(/[\p{L}\p{N}]{2,}/gu) || [])
    .filter((term) => !STOP.has(term) &&
      /* Words need three letters to be worth searching; a number is worth
         searching from two, because "page 42" is a real question and its
         answer lives on a page full of other numbers. */
      (/[\p{L}]/u.test(term) ? term.length >= 3 : term.length >= 2)))]
}

/* Stops at `cap`, because the caller only ever asks whether a term appears up
   to a few times — counting the rest of a page after the answer is settled is
   most of a book scanned for nothing. */
const occurrences = (text, term, cap) => {
  let count = 0
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + term.length)) {
    if (++count >= cap) break
  }
  return count
}

const TERM_CAP = 6

function scorePage (page, terms, phrase, openPage) {
  const text = page.folded
  let score = 0
  for (const term of terms) score += occurrences(text, term, TERM_CAP) * (2 + Math.min(5, term.length / 3))
  if (phrase.length >= 8 && text.includes(phrase)) score += 24
  if (openPage) score += Math.max(0, 12 - Math.abs(page.page - openPage) * 4)
  else if (page.page === 1) score += 2
  return score
}

function excerpt (page, terms, limit) {
  const source = page.text
  if (source.length <= limit) return source
  const normalized = page.folded
  const hits = terms.map((term) => normalized.indexOf(term)).filter((at) => at >= 0)
  const focus = hits.length ? Math.min(...hits) : 0
  const start = Math.max(0, Math.min(source.length - limit, focus - Math.floor(limit * 0.3)))
  const body = source.slice(start, start + limit)
  return `${start ? '…\n' : ''}${body}${start + limit < source.length ? '\n…' : ''}`
}

/* How much ranked context a question earns. A follow-up that names no topic
   ("thanks", "continue", "yes") must not pay for six pages of a book the
   conversation already holds — and a question that names one thing does not
   need the budget of one that spans several. The open page is the anchor for
   a termless question, because "summarise this page" is a real request and
   the page the reader is looking at is the one it means. */
function contextBudget (terms) {
  if (terms.length) {
    return {
      maxPages: Math.min(6, 1 + terms.length),
      maxChars: Math.min(14000, Math.max(3000, terms.length * 1200 + 2000))
    }
  }
  return { maxPages: 1, maxChars: 3000 }
}

/**
 * @param {string} query
 * @param {{path:string,textPath:string,openPage?:number,pages:{page:number,pages:number,text:string,folded:string}[]}[]} documents
 *   `pages` comes from `parsePages`. The caller holds them across turns rather
 *   than splitting the same book up again for every question.
 */
function relevantPdfContext (query, documents, { maxPages = 6, maxChars = 14000 } = {}) {
  const terms = queryTerms(query)
  const phrase = folded(query).trim()
  const budget = contextBudget(terms)
  const askedPages = maxPages !== 6 ? maxPages : budget.maxPages
  const askedChars = maxChars !== 14000 ? maxChars : budget.maxChars
  const ranked = []

  /* A question with nothing to search for is a question about the page in
     front of the reader. Scoring the whole book for it would spend the same
     CPU a real question spends to pick the page the reader is already on, so
     it is chosen directly — and a termless question with no open page has
     nothing to ground it, so it carries no ranked context at all. */
  if (!terms.length) {
    const open = (documents || []).find((document) => Number(document.openPage) > 0)
    if (!open) return ''
    const page = open.pages.find((candidate) => candidate.page === Number(open.openPage))
    if (!page) return ''
    return [
      'Relevant PDF pages selected locally from extracted text and OCR:',
      `--- ${open.path} page ${page.page} of ${page.pages} ---\n${excerpt(page, [], askedChars)}`,
      'Use these pages first. The complete page-marked text files are listed above; search or read them if the answer depends on omitted material.'
    ].join('\n\n').slice(0, askedChars + 1200)
  }

  /* Ranking carries a reference to the page, not a copy of it. A book is four
     hundred pages and six of them are used; cloning every one to hang a score
     off it allocated the whole document again, per turn, to throw away all but
     the handful that got chosen. */
  for (const document of documents || []) {
    for (const page of document.pages) {
      ranked.push({
        page,
        document,
        score: scorePage(page, terms, phrase, Number(document.openPage) || 0)
      })
    }
  }

  ranked.sort((a, b) =>
    b.score - a.score ||
    a.document.path.localeCompare(b.document.path) ||
    a.page.page - b.page.page)

  const selected = []
  const seen = new Set()
  for (const entry of ranked) {
    const key = `${entry.document.path}\u0000${entry.page.page}`
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(entry)
    if (selected.length >= askedPages) break
  }
  selected.sort((a, b) =>
    a.document.path.localeCompare(b.document.path) || a.page.page - b.page.page)

  if (!selected.length) return ''
  const perPage = Math.max(800, Math.floor(askedChars / selected.length))
  const blocks = selected.map(({ page, document }) =>
    `--- ${document.path} page ${page.page} of ${page.pages} ---\n${excerpt(page, terms, perPage)}`)
  return [
    'Relevant PDF pages selected locally from extracted text and OCR:',
    blocks.join('\n\n'),
    'Use these pages first. The complete page-marked text files are listed above; search or read them if the answer depends on omitted material.'
  ].join('\n\n').slice(0, askedChars + 1200)
}

module.exports = { ocrPagesOf, parsePages, relevantPdfContext }
