/* ======================================================= language tables
   A language table is Markdown on disk and a deck only while it is studied.
   The file therefore stays useful in any editor, and generating flashcards
   does not leave a second collection of files to keep in sync.
   ================================================================== */

import VAULT_CONTRACT from '../electron/vault-contract.json'
import { LANGUAGE_FLAG } from './vault-paths.js'
import { AGAIN, HARD, GOOD, EASY, grade as gradeCard, preview, humanDays, isLeech } from './srs.js'

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

/**
 * Which two columns are the question and the answer.
 *
 * Named columns first, because a table that says `Word` and `English` means it.
 * Failing that, the first two: `Letter / combination | Sound` and
 * `Pattern / rule | Meaning / use` are the other two tables the app makes, and
 * both put the prompt in column 0 and the answer in column 1 — as does very
 * nearly every two-column table anybody writes by hand. Requiring the vocabulary
 * table's exact headings is what made the other two unstudiable, which meant two
 * of the three files created for every language were dead weight.
 *
 * A note can say so itself, in its frontmatter, when neither rule fits:
 *
 *     study-front: Term
 *     study-back: Translation
 *     study-reverse: no
 */
function columnsFor (header, options = {}) {
  const names = header.map((name) => name.trim().toLowerCase())
  const named = (want) => (want ? names.indexOf(String(want).trim().toLowerCase()) : -1)

  const front = named(options.front)
  const back = named(options.back)
  if (front >= 0 && back >= 0 && front !== back) return { front, back }

  const word = names.indexOf('word')
  const english = names.indexOf('english')
  if (word >= 0 && english >= 0) return { front: word, back: english }

  // Any two-column table reads as prompt-then-answer.
  if (names.length >= 2) return { front: 0, back: 1 }
  return null
}

/** The `key: value` lines above the first `---`, if the note opens with one. */
export function frontmatterOf (markdown) {
  const text = String(markdown || '')
  if (!/^---\r?\n/.test(text)) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const out = {}
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 1) continue
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return out
}

/**
 * Flashcards from the first table in a language note.
 *
 * Two cards per row unless the note says otherwise: recognising a word and
 * producing it are different pieces of knowledge, learned at different rates,
 * and a deck that only ever asks one way teaches you to read a language and not
 * to speak it. They schedule independently — which is why `direction` is part
 * of a card's identity in the store.
 */
export function languageCards (markdown, notePath = '') {
  const lines = String(markdown || '').split(/\r?\n/)
  const options = frontmatterOf(markdown)
  const reverse = !/^(no|false|off)$/i.test(options['study-reverse'] || '')

  for (let at = 0; at < lines.length - 1; at++) {
    const header = cells(lines[at])
    if (!delimiter(lines[at + 1])) continue

    const columns = columnsFor(header, {
      front: options['study-front'],
      back: options['study-back']
    })
    if (!columns) continue

    const cards = []
    for (let row = at + 2; row < lines.length; row++) {
      if (!lines[row].includes('|') || !lines[row].trim()) break
      const values = cells(lines[row])
      const front = values[columns.front]?.trim() || ''
      const back = values[columns.back]?.trim() || ''
      if (!front || !back) continue

      /* The term half of the id is the prompt side, whichever way the card is
         asked — so a row keeps its history when reverse cards are turned on or
         off, and the two directions of one row stay recognisably a pair. */
      cards.push({ id: `${notePath}|${front}|f`, term: front, prompt: front, answer: back, direction: 'f' })
      if (reverse) {
        cards.push({ id: `${notePath}|${front}|r`, term: front, prompt: back, answer: front, direction: 'r' })
      }
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

/* How many cards never seen before to introduce in one day. Without a cap, a
   table of four hundred words is four hundred first sights in one sitting, and
   every one of them comes back tomorrow — the classic way to abandon a deck in
   week two. */
const NEW_PER_DAY = 20

/** The start of today, so "due" means "due by the end of today" and a card is
 *  not withheld because it is scheduled for this evening. */
function endOfToday (now) {
  const date = new Date(now)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

/**
 * The queue for a session: everything overdue, then as many new cards as the
 * day's budget allows.
 *
 * Due cards come first and in order of how overdue they are, because those are
 * the ones actually about to be forgotten. New cards are shuffled in at the end
 * rather than the front: meeting twenty new words before reviewing is how a
 * session becomes too long to finish.
 */
export function buildQueue (cards, states, now, { newPerDay = NEW_PER_DAY } = {}) {
  const cutoff = endOfToday(now)
  const due = []
  const fresh = []

  for (const card of cards) {
    const state = states[card.id]
    if (isLeech(state)) continue          // set aside, not drilled — see srs.js
    if (!state || !state.reps) fresh.push(card)
    else if ((state.due || 0) <= cutoff) due.push({ card, due: state.due || 0 })
  }

  due.sort((a, b) => a.due - b.due)
  return [...due.map((entry) => entry.card), ...shuffled(fresh).slice(0, newPerDay)]
}

/**
 * The study overlay.
 *
 * The Markdown is still the source of truth for *what* is in the deck — open it
 * again and the cards are rebuilt from whatever the table says now. What has
 * changed is that *when* each card comes back is no longer thrown away when the
 * overlay closes: every answer updates the card's state and is written to the
 * vault, so a session is a step in a schedule rather than a lap of a drill.
 *
 * Answers are held until the session ends and then written in one batch — a
 * review is a burst of twenty answers in three minutes, and each one would
 * otherwise be a durable rewrite of the whole deck. The batch is also flushed
 * when the window goes away, so quitting mid-session does not lose the answers
 * already given.
 */
export function mountLanguageStudy ({ el, source, notePath, api, onEmpty, onDone }) {
  const state = { queue: [], done: 0, revealed: false, states: {}, pending: [], open: false }

  const current = () => state.queue[0] || null

  function paint () {
    const card = current()
    if (!card) {
      el.word.textContent = state.done ? 'Done for today' : 'Nothing due'
      el.english.textContent = state.done
        ? `${state.done} ${state.done === 1 ? 'card' : 'cards'} reviewed. The rest are scheduled.`
        : 'Every card here is scheduled for a later day.'
      el.english.hidden = false
      el.reveal.hidden = true
      el.answerActions.hidden = true
      el.progress.textContent = state.done ? 'Finished' : ''
      return
    }

    el.word.textContent = card.prompt
    el.english.textContent = card.answer
    el.english.hidden = !state.revealed
    el.reveal.hidden = state.revealed
    el.answerActions.hidden = !state.revealed
    el.progress.textContent = `${state.done + 1} of ${state.done + state.queue.length}`

    /* Each button says what it will do. "Good — 12d" turns an abstract
       judgement into a choice with a visible consequence, which is the single
       most useful thing a review surface can put on screen. */
    if (state.revealed) {
      const ahead = preview(state.states[card.id], Date.now())
      if (el.againWhen) el.againWhen.textContent = humanDays(ahead[AGAIN])
      if (el.hardWhen) el.hardWhen.textContent = humanDays(ahead[HARD])
      if (el.goodWhen) el.goodWhen.textContent = humanDays(ahead[GOOD])
      if (el.easyWhen) el.easyWhen.textContent = humanDays(ahead[EASY])
    }
  }

  function reveal () {
    if (!current() || state.revealed) return
    state.revealed = true
    paint()
  }

  /** Answer the card in front, and schedule it. */
  function answer (grade) {
    const card = current()
    if (!card || !state.revealed) return

    const now = Date.now()
    const next = gradeCard(state.states[card.id], grade, now)
    state.states[card.id] = next
    state.pending.push({ id: card.id, at: now, grade, state: next })

    state.queue.shift()
    state.done++
    /* Answered Again, it comes back before the session is over — the schedule
       has it returning tomorrow at the earliest, but a card just failed is one
       you have not learned yet, and finishing the session without seeing it
       again would be the drill's one genuine advantage thrown away. */
    if (grade === AGAIN) state.queue.push(card)
    state.revealed = false
    paint()
  }

  /** Everything answered since the last write, to the vault. */
  async function flush () {
    if (!state.pending.length) return
    const batch = state.pending
    state.pending = []
    try {
      await api.review.record(batch)
    } catch (err) {
      // Put them back, so the next flush — or the one at close — tries again
      // rather than the answers being lost for having been picked up.
      state.pending.unshift(...batch)
      console.error('recording the review failed', err)
    }
  }

  async function close () {
    el.root.hidden = true
    state.open = false
    state.queue = []
    await flush()
    onDone?.()
  }

  async function open () {
    const path = notePath()
    const cards = languageCards(source(), path)
    if (!cards.length) {
      onEmpty('Add a word and its meaning before studying.')
      return
    }

    try {
      state.states = await api.review.all()
    } catch {
      state.states = {}
    }

    state.queue = buildQueue(cards, state.states, Date.now())
    state.done = 0
    state.revealed = false
    state.open = true
    el.root.hidden = false
    paint()
    el.card.focus()
  }

  el.close.addEventListener('click', close)
  el.reveal.addEventListener('click', reveal)
  el.again.addEventListener('click', () => answer(AGAIN))
  el.hard?.addEventListener('click', () => answer(HARD))
  el.got.addEventListener('click', () => answer(GOOD))
  el.easy?.addEventListener('click', () => answer(EASY))
  el.card.addEventListener('click', reveal)
  el.root.addEventListener('mousedown', (event) => {
    if (event.target === el.root) close()
  })
  // Quitting mid-session must not lose the answers already given.
  window.addEventListener('beforeunload', () => { if (state.pending.length) api.review.record(state.pending) })

  window.addEventListener('keydown', (event) => {
    if (el.root.hidden) return
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (!state.revealed) {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); reveal() }
      return
    }
    /* 1–4 left to right, the way every review surface numbers them, with the
       arrows kept for the two people already used to them here. */
    const key = {
      1: AGAIN, ArrowLeft: AGAIN,
      2: HARD,
      3: GOOD, ArrowRight: GOOD, Enter: GOOD, ' ': GOOD,
      4: EASY
    }[event.key]
    if (key) { event.preventDefault(); answer(key) }
  })

  return { open, close, flush }
}
