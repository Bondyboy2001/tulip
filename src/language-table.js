/* ======================================================= language tables
   A language table is Markdown on disk and a deck only while it is studied.
   The file therefore stays useful in any editor, and generating flashcards
   does not leave a second collection of files to keep in sync.
   ================================================================== */

import VAULT_CONTRACT from '../electron/vault-contract.json'
import { LANGUAGE_FLAG } from './vault-paths.js'

const LANGUAGE_TABLE_SUFFIX = VAULT_CONTRACT.languageTableSuffix
const LEGACY_LANGUAGE_TABLES = new Set(
  VAULT_CONTRACT.legacyLanguageTableNames.map((name) => name.toLowerCase())
)
const LANGUAGE_TABLE_TEMPLATE = VAULT_CONTRACT.languageTableTemplates.vocabulary

export const isLanguageTablePath = (path) => {
  const parts = String(path || '').replaceAll('\\', '/').split('/')
  const name = parts.pop() || ''
  if (name.toLowerCase().endsWith(LANGUAGE_TABLE_SUFFIX)) return true
  const folder = parts.pop() || ''
  return LEGACY_LANGUAGE_TABLES.has(name.toLowerCase()) && LANGUAGE_FLAG.test(folder)
}

/**
 * Split one Markdown-table row without treating an escaped pipe as a column.
 * Outer pipes are optional, exactly as they are in GFM.
 */
function cells (line) {
  const out = []
  let cell = ''
  let escaped = false

  for (const char of String(line || '')) {
    if (escaped) {
      cell += char
      escaped = false
    } else if (char === '\\') {
      cell += char
      escaped = true
    } else if (char === '|') {
      out.push(cell)
      cell = ''
    } else {
      cell += char
    }
  }
  out.push(cell)

  if (!out[0]?.trim()) out.shift()
  if (!out[out.length - 1]?.trim()) out.pop()
  return out.map((value) => value.trim().replace(/\\\|/g, '|'))
}

const delimiter = (line) => {
  const row = cells(line)
  return row.length > 1 && row.every((value) => /^:?-{1,}:?$/.test(value))
}

/** A language document is exactly its first Markdown table. */
export function normalizeLanguageTable (markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  for (let at = 0; at < lines.length - 1; at++) {
    if (!lines[at].includes('|') || !delimiter(lines[at + 1])) continue
    let end = at + 2
    while (end < lines.length && lines[end].includes('|') && lines[end].trim()) end++
    return lines.slice(at, end).join('\n') + '\n'
  }
  return LANGUAGE_TABLE_TEMPLATE
}

/** Flashcards from the first table carrying the language-table contract. */
function languageCards (markdown) {
  const lines = String(markdown || '').split(/\r?\n/)

  for (let at = 0; at < lines.length - 1; at++) {
    const header = cells(lines[at])
    if (!delimiter(lines[at + 1])) continue

    const names = header.map((name) => name.trim().toLowerCase())
    const wordAt = names.indexOf('word')
    const englishAt = names.indexOf('english')
    if (wordAt < 0 || englishAt < 0) continue

    const cards = []
    for (let row = at + 2; row < lines.length; row++) {
      if (!lines[row].includes('|') || !lines[row].trim()) break
      const values = cells(lines[row])
      const word = values[wordAt]?.trim() || ''
      const english = values[englishAt]?.trim() || ''
      if (word && english) cards.push({ word, english })
    }
    return cards
  }

  return []
}

function shuffled (cards) {
  const next = cards.map((card) => ({ ...card }))
  for (let at = next.length - 1; at > 0; at--) {
    const swap = Math.floor(Math.random() * (at + 1))
    ;[next[at], next[swap]] = [next[swap], next[at]]
  }
  return next
}

/**
 * The study overlay owns only session state. The Markdown remains the source
 * of truth; opening it again makes a fresh deck from whatever is in the table.
 */
export function mountLanguageStudy ({ el, source, onEmpty }) {
  const state = { queue: [], total: 0, revealed: false }

  const current = () => state.queue[0] || null

  function paint () {
    const card = current()
    if (!card) {
      el.word.textContent = 'Deck complete'
      el.english.textContent = `You knew all ${state.total} ${state.total === 1 ? 'word' : 'words'}.`
      el.english.hidden = false
      el.reveal.hidden = true
      el.answerActions.hidden = true
      el.progress.textContent = 'Finished'
      return
    }

    el.word.textContent = card.word
    el.english.textContent = card.english
    el.english.hidden = !state.revealed
    el.reveal.hidden = state.revealed
    el.answerActions.hidden = !state.revealed
    const done = state.total - state.queue.length
    el.progress.textContent = `${done + 1} of ${state.total}`
  }

  function reveal () {
    if (!current() || state.revealed) return
    state.revealed = true
    paint()
  }

  function answer (remembered) {
    if (!current() || !state.revealed) return
    const card = state.queue.shift()
    if (!remembered) state.queue.push(card)
    state.revealed = false
    paint()
  }

  function close () {
    el.root.hidden = true
    state.queue = []
  }

  function open () {
    const cards = languageCards(source())
    if (!cards.length) {
      onEmpty('Add a word and its English meaning before studying.')
      return
    }
    state.queue = shuffled(cards)
    state.total = cards.length
    state.revealed = false
    el.root.hidden = false
    paint()
    el.card.focus()
  }

  el.close.addEventListener('click', close)
  el.reveal.addEventListener('click', reveal)
  el.again.addEventListener('click', () => answer(false))
  el.got.addEventListener('click', () => answer(true))
  el.card.addEventListener('click', reveal)
  el.root.addEventListener('mousedown', (event) => {
    if (event.target === el.root) close()
  })
  window.addEventListener('keydown', (event) => {
    if (el.root.hidden) return
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (!state.revealed && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault()
      reveal()
      return
    }
    if (state.revealed && (event.key === 'ArrowLeft' || event.key === '1')) {
      event.preventDefault()
      answer(false)
    } else if (state.revealed && (event.key === 'ArrowRight' || event.key === '2' || event.key === 'Enter')) {
      event.preventDefault()
      answer(true)
    }
  })

  return { open, close }
}
