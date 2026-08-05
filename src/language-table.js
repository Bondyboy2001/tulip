/* ======================================================= language tables
   A language table is Markdown on disk and a deck only while it is studied.
   The file therefore stays useful in any editor, and generating flashcards
   does not leave a second collection of files to keep in sync.

   One row is not one card. Knowing that `καρότο` means carrot, being able to
   produce `καρότο` when you want to say carrot, recognising it spoken, and
   putting it into a sentence are four different pieces of knowledge, learned at
   different rates and lost at different rates — so they are four cards, each
   with a schedule of its own. They do not all start together: a word you met
   this morning is not one you can be asked to produce, and asking anyway
   teaches nothing except that the deck is unpleasant. See `unlocked` below.
   ================================================================== */

import VAULT_CONTRACT from '../electron/vault-contract.json'
import {
  AGAIN, GOOD,
  grade as gradeCard, isLeech, isNew, isDue
} from './srs.js'
import { EXACT, judge, diff } from './study-match.js'
import { speechTag } from './speech.js'

const LANGUAGE_TABLE_SUFFIX = VAULT_CONTRACT.languageTableSuffix
const LANGUAGE_TABLE_TEMPLATE = VAULT_CONTRACT.languageTableTemplates.vocabulary

export const isLanguageTablePath = (path) =>
  String(path || '').toLowerCase().endsWith(LANGUAGE_TABLE_SUFFIX)

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

function indexOfAny (values, wanted) {
  for (const name of wanted) {
    const at = values.indexOf(name)
    if (at >= 0) return at
  }
  return -1
}

/**
 * The `---` block a note opens with, trailing newline and all, or ''.
 *
 * One reader for the two questions asked of frontmatter — what it says, and
 * where it ends — because they were answered separately and disagreed: the
 * normaliser used to keep only the table, so every `study-front:` and `lang:`
 * this file documents was deleted from the disk the first time the note was
 * opened. A setting that cannot survive being read is not a setting.
 */
function frontmatterBlock (text) {
  if (!/^---\r?\n/.test(text)) return ''
  const end = text.indexOf('\n---', 3)
  if (end < 0) return ''
  const close = text.indexOf('\n', end + 1)
  return close < 0 ? text : text.slice(0, close + 1)
}

/**
 * A language note that has no table gets one. Nothing else.
 *
 * A language table is a Markdown file with a Markdown table in it — that is the
 * whole format. A heading above the grid, a paragraph of grammar notes under
 * it, a second table: all ordinary Markdown, and all kept.
 *
 * This used to keep only the frontmatter and the first table, so everything
 * else in the file was deleted the first time it was opened; and it rewrote a
 * Vocabulary table's columns into a fixed schema on every open, which put a
 * renamed or dragged column straight back where the schema said it belonged.
 * Both were the document being told what it was allowed to be.
 */
export function normalizeLanguageTable (markdown) {
  const text = String(markdown || '')
  const lines = text.split(/\r?\n/)
  for (let at = 0; at < lines.length - 1; at++) {
    if (lines[at].includes('|') && delimiter(lines[at + 1])) return text
  }

  /* Below the frontmatter and below whatever else the note already says, with
     one blank line between — a table welded onto the end of a paragraph is not
     a table as far as Markdown is concerned. */
  const head = frontmatterBlock(text)
  const body = text.slice(head.length).replace(/\s+$/, '')
  return head + (body ? `${body}\n\n` : '') + LANGUAGE_TABLE_TEMPLATE
}

/**
 * Which columns are the question, the answer, the sentence and the aside.
 *
 * Named columns first, because a table that says `Greek` and `English` means it.
 * Failing that, the first two keep older or hand-written language tables
 * studyable: almost every such table puts the prompt in column 0 and its answer
 * in column 1.
 *
 * A note can say so itself, in its frontmatter, when none of that fits:
 *
 *     study-front: Term
 *     study-back: Translation
 *     study-example: Sentence
 *     study-reverse: no
 */
function columnsFor (header, options = {}) {
  const names = header.map((name) => name.trim().toLowerCase())
  const named = (want) => (want ? names.indexOf(String(want).trim().toLowerCase()) : -1)
  const anyOf = (...wanted) => indexOfAny(names, wanted)

  let front = named(options.front)
  let back = named(options.back)
  if (front < 0 || back < 0 || front === back) {
    const word = names.indexOf('word')
    const english = names.indexOf('english')
    if (word >= 0 && english >= 0) {
      front = word
      back = english
    } else if (english >= 0) {
      const details = new Set(['sound', 'sounds', 'example', 'sentence', 'usage', 'in context', 'notes', 'note', 'gender', 'remark'])
      const studied = names.findIndex((name, index) => index !== english && !details.has(name))
      if (studied < 0) return null
      front = studied
      back = english
    } else if (names.length >= 2) {
      // Any two-column table reads as prompt-then-answer.
      front = 0
      back = 1
    } else {
      return null
    }
  }

  /* The sentence column is what makes cloze cards possible, and the aside is
     shown after answering rather than being asked about — a gender or a
     register note is something to be reminded of, not tested on. Both are
     optional, and a table without them simply has fewer kinds of card. */
  const example = named(options.example) >= 0
    ? named(options.example)
    : anyOf('example', 'sentence', 'usage', 'in context')
  const notes = anyOf('notes', 'note', 'gender', 'remark')

  return {
    front,
    back,
    example: example === front || example === back ? -1 : example,
    notes: notes === front || notes === back ? -1 : notes
  }
}

/** The `key: value` lines above the first `---`, if the note opens with one. */
function frontmatterOf (markdown) {
  const text = String(markdown || '')
  const block = frontmatterBlock(text)
  if (!block) return {}
  const end = text.indexOf('\n---', 3)
  const out = {}
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 1) continue
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return out
}

/**
 * What this note calls its prompt and answer columns.
 *
 * For quick-add, which has a word and a meaning and needs to know which
 * headings to file them under — the tables are the user's own, and one of them
 * says `Term`/`Translation` where another says `Word`/`English`. Resolved by
 * exactly the rules the cards are, so a word added lands in the column the
 * cards will be built from.
 *
 * @returns {{front: string, back: string}|null}
 */
export function studyColumns (markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  const options = frontmatterOf(markdown)
  for (let at = 0; at < lines.length - 1; at++) {
    const header = cells(lines[at])
    if (!delimiter(lines[at + 1])) continue
    const columns = columnsFor(header, {
      front: options['study-front'],
      back: options['study-back'],
      example: options['study-example']
    })
    if (!columns) return null
    return { front: header[columns.front], back: header[columns.back] }
  }
  return null
}

/* --------------------------------------------------------- kinds of card */

/** Read it and know what it means. The first sight of every word. */
export const RECOGNISE = 'f'
/** Mean it and produce it. What "knowing a word" is usually taken to mean. */
export const PRODUCE = 'r'
/** Hear it and write it — the alphabet and the sounds, which reading never
 *  tests and which nothing else in a written deck reaches. */
export const DICTATE = 'd'
/** Put it back into the sentence it came from. Context, collocation, and the
 *  grammar around the word rather than the word alone. */
export const CLOZE = 'c'

const KINDS = [RECOGNISE, PRODUCE, DICTATE, CLOZE]

/* What each kind is called on screen. Every kind takes a typed answer. */
const KIND_LABEL = {
  [RECOGNISE]: 'What does this mean?',
  [PRODUCE]: 'How do you say this?',
  [DICTATE]: 'Write what you hear',
  [CLOZE]: 'Fill the gap'
}

/**
 * A sentence with the word taken out of it.
 *
 * Found accent- and case-insensitively, because the sentence inflects the word
 * it uses and a table writes the dictionary form: `καρότο` in the table is
 * `καρότο` in the sentence often enough to be worth trying, and when it is not,
 * the row simply has no cloze card rather than a blank in the wrong place.
 *
 * @returns {string} the sentence with `____` where the word was, or '' if the
 *   word is not in it
 */
export function clozeOf (sentence, term) {
  const text = String(sentence || '')
  const word = String(term || '').trim()
  if (!text || !word || word.length < 2) return ''

  const fold = (value) => value
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')

  /* Folded character by character rather than as a whole string: NFD can change
     a string's length, and an index into the folded text has to be an index
     into the original. */
  const folded = [...text].map(fold)
  const target = [...word].map(fold).join('')
  if (!target) return ''

  for (let at = 0; at + word.length <= text.length; at++) {
    if (folded.slice(at, at + word.length).join('') !== target) continue
    // Only on a word boundary, so `το` does not blank the middle of `καρότο`.
    const before = text[at - 1]
    const after = text[at + word.length]
    if (before && /[\p{L}\p{N}]/u.test(before)) continue
    if (after && /[\p{L}\p{N}]/u.test(after)) continue
    return text.slice(0, at) + '____' + text.slice(at + word.length)
  }
  return ''
}

/** Which kinds a note asks for, if it says. `study-stages: f r` or `all`. */
function stagesFrom (options) {
  const raw = String(options['study-stages'] || '').trim().toLowerCase()
  if (!raw) {
    // The older switch, kept meaning what it meant: recognition only.
    return /^(no|false|off)$/i.test(options['study-reverse'] || '')
      ? new Set([RECOGNISE])
      : null
  }
  if (raw === 'all') return new Set(KINDS)
  const wanted = new Set(raw.split(/[\s,]+/).filter(Boolean).map((name) => ({
    recognition: RECOGNISE, recognise: RECOGNISE, read: RECOGNISE,
    production: PRODUCE, produce: PRODUCE, write: PRODUCE, reverse: PRODUCE,
    dictation: DICTATE, listen: DICTATE, audio: DICTATE,
    cloze: CLOZE, sentence: CLOZE
  }[name] || name)))
  const kinds = new Set(KINDS.filter((kind) => wanted.has(kind)))
  // Recognition is not optional: everything else unlocks from it.
  kinds.add(RECOGNISE)
  return kinds
}

/**
 * Every card a language note can offer, in every kind its rows support.
 *
 * All of them, whether or not the reader has earned them yet — what is
 * available at a given moment is `buildQueue`'s question, and keeping the two
 * apart is what lets the deck answer "how far through this word am I" without
 * rebuilding it.
 *
 * @param {string} markdown  the note
 * @param {string} notePath  vault-relative; the first part of every card's id
 * @param {object} [options]
 * @param {boolean} [options.speaks] whether this language can be spoken here —
 *   a dictation card with no voice is a card with no prompt
 */
export function languageCards (markdown, notePath = '', { speaks = false } = {}) {
  const lines = String(markdown || '').split(/\r?\n/)
  const options = frontmatterOf(markdown)
  const stages = stagesFrom(options)
  const wants = (kind) => !stages || stages.has(kind)

  for (let at = 0; at < lines.length - 1; at++) {
    const header = cells(lines[at])
    if (!delimiter(lines[at + 1])) continue

    const columns = columnsFor(header, {
      front: options['study-front'],
      back: options['study-back'],
      example: options['study-example']
    })
    if (!columns) continue

    const cards = []
    for (let row = at + 2; row < lines.length; row++) {
      if (!lines[row].includes('|') || !lines[row].trim()) break
      const values = cells(lines[row])
      const term = values[columns.front]?.trim() || ''
      const meaning = values[columns.back]?.trim() || ''
      if (!term || !meaning) continue

      const example = columns.example >= 0 ? (values[columns.example]?.trim() || '') : ''
      const aside = columns.notes >= 0 ? (values[columns.notes]?.trim() || '') : ''

      /* The term half of the id is the prompt side whichever way the card is
         asked — so a row keeps its history when a kind is turned on or off, and
         the four cards of one row stay recognisably a set. */
      const make = (kind, fields) => ({
        id: `${notePath}|${term}|${kind}`,
        path: notePath,
        term,
        kind,
        label: KIND_LABEL[kind],
        aside,
        ...fields
      })

      if (wants(RECOGNISE)) {
        cards.push(make(RECOGNISE, { prompt: term, answer: meaning, say: term }))
      }
      if (wants(PRODUCE)) {
        cards.push(make(PRODUCE, { prompt: meaning, answer: term, say: term }))
      }
      if (wants(DICTATE) && speaks) {
        // No prompt on the card at all: the audio is the question, which is the
        // only way to test hearing rather than reading.
        cards.push(make(DICTATE, { prompt: '', answer: term, say: term, ask: term }))
      }
      if (wants(CLOZE)) {
        const gap = clozeOf(example, term)
        if (gap) cards.push(make(CLOZE, { prompt: gap, answer: term, say: example }))
      }
    }
    return cards
  }

  return []
}

/* How stable a word's recognition has to be before it is asked for in earnest.
   A week: long enough that the word is genuinely held rather than just seen
   this morning, short enough that production is not put off until the word has
   already been half-forgotten from never being produced. */
export const UNLOCK_STABILITY = 7

/**
 * Whether a card is available to the reader yet.
 *
 * Recognition always is. The other three wait until that word's recognition
 * card is holding — because a word you cannot yet read is not a word you can be
 * asked to spell, and a queue that asks anyway spends its whole budget on
 * failures. Once a card has been answered even once it stays unlocked: the
 * gate is for reaching the stage, not for staying in it, and a bad week at
 * recognition must not silently withdraw production.
 */
export function unlocked (card, states) {
  if (card.kind === RECOGNISE) return true
  if (states[card.id]?.reps) return true
  const seed = states[`${card.path}|${card.term}|${RECOGNISE}`]
  return !!seed?.reps && (seed.stability || 0) >= UNLOCK_STABILITY
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
   week two.

   Eight rather than the twenty this used to be, because this deck is not the
   only place new words are arriving from: a lesson elsewhere is already
   introducing its own, and a review layer that adds twenty a day on top of that
   is two firehoses. Somebody studying only here can raise it in settings. */
export const NEW_PER_DAY = 8

/** The end of today, so "due" means "due by tonight" and a card is not withheld
 *  because it is scheduled for this evening. */
function endOfToday (now) {
  const date = new Date(now)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

/**
 * The queue for a session: everything overdue and unlocked, then as many new
 * words as the day's budget allows.
 *
 * Due cards come first and in order of how overdue they are, because those are
 * the ones actually about to be forgotten. New cards are shuffled in at the end
 * rather than the front: meeting eight new words before reviewing is how a
 * session becomes too long to finish.
 *
 * Interleaved by word rather than grouped: two cards of the same word back to
 * back means the second is answered from the first rather than from memory,
 * which is the one way a four-card row can be worth less than a one-card row.
 */
export function buildQueue (cards, states, now, { newPerDay = NEW_PER_DAY } = {}) {
  const cutoff = endOfToday(now)
  const due = []
  const fresh = []

  for (const card of cards) {
    const state = states[card.id]
    if (isLeech(state)) continue          // set aside, not drilled — see srs.js
    if (!unlocked(card, states)) continue
    /* Asked of the scheduler rather than worked out here. Both questions were
       spelled out again in this loop, which is two more places for "what counts
       as due" to drift away from what the scheduler thinks it means. */
    if (isNew(state)) fresh.push(card)
    else if (isDue(state, cutoff)) due.push({ card, due: state.due || 0 })
  }

  due.sort((a, b) => a.due - b.due)
  return spaced([
    ...due.map((entry) => entry.card),
    ...shuffled(fresh).slice(0, newPerDay)
  ])
}

/**
 * The same cards, with two of one word never adjacent.
 *
 * A stable sort by "how many of this word have already been placed" does it:
 * every word's first card comes before any word's second. The order within a
 * pass is the one the caller established, so overdue-first survives.
 */
function spaced (queue) {
  const seen = new Map()
  return queue
    .map((card, at) => {
      const pass = seen.get(card.term) || 0
      seen.set(card.term, pass + 1)
      return { card, pass, at }
    })
    .sort((a, b) => a.pass - b.pass || a.at - b.at)
    .map((entry) => entry.card)
}

/**
 * How much is waiting, without opening anything.
 *
 * What the badge in the sidebar reads. Counted the same way the queue is built,
 * because a badge saying twelve over a session that offers nine is a badge
 * nobody trusts twice.
 */
export function dueCount (cards, states, now, options = {}) {
  return buildQueue(cards, states, now, options).length
}

/** The drill is binary: only an exact English answer leaves the session. */
export const sessionGrade = (verdict) => verdict === EXACT ? GOOD : AGAIN

/** The visible, accessible result of checking one typed answer. */
export const studyFeedback = (verdict) => verdict === EXACT
  ? { result: 'correct', text: '✓ Correct' }
  : { result: 'wrong', text: '✕ Incorrect' }

/** Count each card once, regardless of how many retries it later needs. */
export function recordFirstTry (stats, id, correct) {
  if (stats.firstTrySeen.has(id)) return false
  stats.firstTrySeen.add(id)
  if (correct) stats.firstTryCorrect++
  else stats.firstTryWrong++
  return true
}

/* --------------------------------------------------------- the overlay */

/** Nothing typed yet, nothing revealed, no verdict. */
const blank = () => ({ typed: '', revealed: false, verdict: null, matched: '' })

/**
 * The study overlay.
 *
 * The Markdown is still the source of truth for *what* is in the deck — open it
 * again and the cards are rebuilt from whatever the tables say now. What is not
 * rebuilt is *when* each card comes back: every answer updates the card's state
 * and is written to the vault, so a session is a step in a schedule rather than
 * a lap of a drill.
 *
 * Answers are held until the session ends and then written in one batch — a
 * review is a burst of twenty answers in three minutes, and each one would
 * otherwise be a durable rewrite of the whole deck. The batch is also flushed
 * when the window goes away, so quitting mid-session does not lose the answers
 * already given.
 *
 * @param {object} arg
 * @param {object} arg.el       the overlay's elements, from index.html
 * @param {() => string} arg.source    the open note's text
 * @param {() => string} arg.notePath  the open note's vault-relative path
 * @param {() => Promise<Array>} arg.decks  every language table in the vault,
 *   as `{path, text}` — what makes ⌃⌘S mean "everything due" rather than "this
 *   file, if it happens to be the one in front of you"
 * @param {object} arg.speech   from src/speech.js
 * @param {() => object} arg.settings  `{newPerDay, retention, speaking}`
 */
export function mountLanguageStudy ({
  el, source, notePath, decks, api, speech, settings = () => ({}), onEmpty, onDone
}) {
  const state = {
    queue: [], done: 0, states: {}, pending: [], open: false,
    firstTrySeen: new Set(), firstTryCorrect: 0, firstTryWrong: 0,
    tags: {},                            // deck path -> the voice to speak it in
    ...blank()
  }

  const current = () => state.queue[0] || null
  const prefs = () => {
    const values = settings() || {}
    return {
      newPerDay: Number(values.newPerDay) > 0 ? Number(values.newPerDay) : NEW_PER_DAY,
      retention: Number(values.retention) > 0 ? Number(values.retention) : 0.9,
      speaking: values.speaking !== false
    }
  }

  const tagFor = (card) => state.tags[card?.path] || ''

  function say (card, text) {
    if (!card || !prefs().speaking) return
    speech?.speak(text ?? card.say, tagFor(card))
  }

  /* ------------------------------------------------------------ drawing */

  function paint () {
    const card = current()
    if (!card) {
      el.prompt.hidden = true
      el.word.textContent = state.done ? 'Done for today' : 'Nothing due'
      el.word.hidden = false
      el.english.textContent = 'Every card here is scheduled for a later day.'
      el.english.hidden = !!state.done
      if (el.summary) {
        el.summary.hidden = !state.done
        if (el.firstCorrect) el.firstCorrect.textContent = String(state.firstTryCorrect)
        if (el.firstWrong) el.firstWrong.textContent = String(state.firstTryWrong)
      }
      if (el.input) el.input.hidden = true
      if (el.feedback) el.feedback.hidden = true
      if (el.verdict) el.verdict.hidden = true
      if (el.replay) el.replay.hidden = true
      if (el.aside) el.aside.hidden = true
      el.progress.textContent = state.done ? 'Finished' : ''
      if (el.hint) el.hint.textContent = ''
      return
    }

    const answered = state.revealed

    el.prompt.hidden = false
    if (el.summary) el.summary.hidden = true
    el.prompt.textContent = card.label
    el.word.textContent = card.prompt
    el.word.hidden = !card.prompt
    /* A dictation card has nothing to look at on purpose; the button that
       replays the audio stands in for the word so the card is not blank. Hidden
       where the machine has no voice for this language — a button that does
       nothing when pressed is worse than no button. */
    if (el.replay) {
      el.replay.hidden = !card.say || !prefs().speaking || !speech?.has(tagFor(card))
    }

    el.english.textContent = card.answer
    /* A typed card that has been judged already shows the answer, beside what
       was typed and with the difference marked — printing it a second time
       underneath is the same word twice and invites the eye to compare the two
       copies rather than the two spellings. */
    el.english.hidden = !answered || !!state.verdict
    if (el.aside) {
      el.aside.textContent = card.aside || ''
      el.aside.hidden = !answered || !card.aside
    }

    if (el.input) {
      el.input.hidden = answered
      el.input.value = state.typed
      el.input.lang = tagFor(card) || ''
    }
    if (el.feedback) {
      el.feedback.hidden = !answered || !state.verdict
      if (answered && state.verdict) {
        const feedback = studyFeedback(state.verdict)
        el.feedback.dataset.result = feedback.result
        el.feedback.textContent = feedback.text
      }
    }
    if (el.verdict) {
      el.verdict.hidden = !answered || !state.verdict
      if (answered && state.verdict) drawVerdict()
    }

    el.progress.textContent = `${state.done + 1} of ${state.done + state.queue.length}`
    if (el.hint) {
      el.hint.textContent = answered
        ? ''
        : 'Type the answer · Enter checks it'
    }
  }

  /** What was typed against what was wanted, with the difference marked. */
  function drawVerdict () {
    const card = current()
    el.verdict.dataset.verdict = state.verdict
    el.verdict.textContent = ''
    const said = document.createElement('span')
    said.className = 'study-verdict-you'
    said.textContent = state.typed || '—'
    el.verdict.append(said)

    if (state.verdict === EXACT) return
    const arrow = document.createElement('span')
    arrow.className = 'study-verdict-arrow'
    arrow.textContent = '→'
    el.verdict.append(arrow)

    /* The runs go inside one element rather than beside the arrow, because the
       row they sit in is spaced — and a word whose letters are spaced apart
       where it happens to have been marked is not the word being taught. */
    const answer = document.createElement('span')
    answer.className = 'study-verdict-answer'
    for (const run of diff(state.typed, state.matched || card.answer)) {
      const part = document.createElement('span')
      part.className = run.same ? '' : 'study-verdict-miss'
      part.textContent = run.text
      answer.append(part)
    }
    el.verdict.append(answer)
  }

  /* ---------------------------------------------------------- answering */

  /** Check what was typed, and show what it earned. */
  function check () {
    const card = current()
    if (!card || state.revealed) return
    const result = judge(state.typed, card.answer)
    state.verdict = result.verdict
    state.matched = result.matched
    state.revealed = true
    // Heard after answering rather than before, so the sound is attached to a
    // word that has just been retrieved rather than being the answer itself.
    if (card.kind !== DICTATE) say(card)
    paint()
    /* Keep the verdict on screen long enough to read, then move on without a
       second grading decision. Anything short of an exact answer returns at
       the end of this session. The identity check prevents an old timer from
       advancing a newer card if Enter was pressed during the pause. */
    const grade = sessionGrade(state.verdict)
    setTimeout(() => {
      if (state.open && current() === card && state.revealed) answer(grade)
    }, 1200)
  }

  /** Answer the card in front, and schedule it. */
  function answer (grade) {
    const card = current()
    if (!card || !state.revealed) return

    const now = Date.now()
    recordFirstTry(state, card.id, grade === GOOD)
    const next = gradeCard(state.states[card.id], grade, now, prefs().retention)
    state.states[card.id] = next
    state.pending.push({ id: card.id, at: now, grade, state: next })

    state.queue.shift()
    state.done++
    /* Answered Again, it comes back before the session is over — the schedule
       has it returning tomorrow at the earliest, but a card just failed is one
       you have not learned yet, and finishing the session without seeing it
       again would be the drill's one genuine advantage thrown away. */
    if (grade === AGAIN) state.queue.push(card)
    Object.assign(state, blank())
    /* Written as the session goes rather than only at the end of it. The batch
       used to be held until `close` — or `beforeunload`, which cannot await the
       write it starts — so a crash, a force quit or a power cut in the middle
       of a long review lost every answer given since it began, and the cards
       came back as though the work had never happened. Coalesced, because a
       reviewer answers faster than a durable write settles and the store
       collapses a burst into one pass anyway. */
    queueFlush()
    paint()
    const following = current()
    // A dictation card's prompt is its audio, so it plays itself.
    if (following?.kind === DICTATE) say(following)
    focusInput()
  }

  const focusInput = () => {
    if (current() && !state.revealed && el.input) el.input.focus()
    else el.card.focus()
  }

  /* ------------------------------------------------------------ the deck */

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

  /* A write is never in flight twice: `flush` empties `pending` before it
     awaits, and a second pass entered meanwhile would hand the store a batch
     the first one is still writing. Chained instead, so an answer given during
     a write is carried by the pass after it. */
  let flushing = null
  let flushTimer = null

  const FLUSH_DELAY = 400

  function queueFlush () {
    clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushing = (flushing || Promise.resolve()).then(flush, flush)
    }, FLUSH_DELAY)
  }

  /** Everything owed to the vault, written before this settles. */
  async function settle () {
    clearTimeout(flushTimer)
    flushTimer = null
    flushing = (flushing || Promise.resolve()).then(flush, flush)
    await flushing
    // An answer given while that pass was writing leaves a batch behind it.
    if (state.pending.length) await flush()
  }

  async function close () {
    el.root.hidden = true
    state.open = false
    state.queue = []
    speech?.stop()
    await settle()
    onDone?.()
  }

  /**
   * The decks a session is built from.
   *
   * `note` is the table in front of you; `vault` is everything, which is what
   * makes a daily review one keystroke from anywhere rather than a thing you
   * first have to navigate to.
   */
  async function gather (scope) {
    if (scope === 'note') {
      const path = notePath()
      return path ? [{ path, text: source() }] : []
    }
    try {
      return (await decks?.()) || []
    } catch (err) {
      console.error('reading the decks failed', err)
      return []
    }
  }

  /**
   * Every card in scope, and the voice each deck is spoken in.
   *
   * The tag is worked out per deck rather than per card because it is a
   * property of the folder, and asking the synthesiser about it once per word
   * would be several hundred lookups for one answer.
   */
  function build (decks, speaking) {
    const cards = []
    state.tags = {}
    for (const deck of decks) {
      const options = frontmatterOf(deck.text)
      const tag = options.lang || speechTag(deck.path.split('/').slice(-2, -1)[0] || '')
      state.tags[deck.path] = tag
      const speaks = speaking && !!tag && !!speech?.has(tag)
      /* Study is one predictable Duolingo-companion drill: see the language's
         word and type its English meaning. The richer card kinds remain
         available to the parser, but do not enter this session. */
      cards.push(...languageCards(deck.text, deck.path, { speaks })
        .filter((card) => card.kind === RECOGNISE))
    }
    return cards
  }

  /* The note in front of you, and only that. Studying everything due across the
     vault was a second way in — a palette entry and a chord — and both are
     gone, so the scope went with them. `gather('vault')` is still what `due`
     counts with; it is only this door that no longer opens onto it. */
  async function open () {
    const found = await gather('note')
    const { speaking, newPerDay } = prefs()
    const cards = build(found, speaking)
    if (!cards.length) {
      onEmpty('Add a word and its meaning before studying.')
      return
    }

    try {
      state.states = await api.review.all()
    } catch {
      state.states = {}
    }

    state.queue = buildQueue(cards, state.states, Date.now(), { newPerDay })
    state.done = 0
    state.firstTrySeen = new Set()
    state.firstTryCorrect = 0
    state.firstTryWrong = 0
    Object.assign(state, blank())
    state.open = true
    el.root.hidden = false
    paint()
    const first = current()
    if (first?.kind === DICTATE) say(first)
    focusInput()
  }

  /**
   * How many decks there are, and how many cards are waiting across them.
   *
   * Both, because they are different answers: no decks means the Review row has
   * no business being on screen at all, where no cards due means it should be
   * there and quiet. Answered without opening anything.
   *
   * Dictation is left out of the speech check here — this runs on a timer and
   * on every save, and the voice list is not worth walking that often; a card
   * whose audio turns out to be missing is dropped when the session is built.
   */
  async function due () {
    try {
      const found = await gather('vault')
      if (!found.length) return { decks: 0, due: 0 }
      const cards = build(found, false)
      const states = await api.review.all()
      return {
        decks: found.length,
        due: dueCount(cards, states, Date.now(), { newPerDay: prefs().newPerDay })
      }
    } catch {
      return { decks: 0, due: 0 }
    }
  }

  /* ------------------------------------------------------------- events */

  el.close.addEventListener('click', close)
  el.replay?.addEventListener('click', (event) => {
    event.stopPropagation()
    say(current())
  })
  el.card.addEventListener('click', () => focusInput())
  el.root.addEventListener('mousedown', (event) => {
    if (event.target === el.root) close()
  })
  el.input?.addEventListener('input', () => { state.typed = el.input.value })
  // Quitting mid-session must not lose the answers already given.
  window.addEventListener('beforeunload', () => {
    if (state.pending.length) api.review.record(state.pending)
  })

  window.addEventListener('keydown', (event) => {
    if (el.root.hidden) return
    if (event.key === 'Escape') { event.preventDefault(); close(); return }

    const card = current()
    const typing = !!card && !state.revealed

    if (typing) {
      // Everything else belongs to the text box — including space, which in a
      // language with multi-word answers is a letter.
      if (event.key === 'Enter') { event.preventDefault(); check() }
      else if (event.key === 'Tab' && card?.say) { event.preventDefault(); say(card) }
      return
    }

    /* Enter can skip the short feedback pause. Wrong answers still go to the
       end of the queue; right answers leave the session. */
    if (event.key === 'Enter') {
      event.preventDefault()
      answer(sessionGrade(state.verdict))
      return
    }
    if (event.key === 'Tab' && card?.say) { event.preventDefault(); say(card); return }
  })

  return { open, close, flush, due, isOpen: () => state.open }
}
