/**
 * What a table turns into, and what a session is allowed to ask.
 *
 * The scheduler has tests of its own; these are about the deck. Two things here
 * are worth more than the rest: that a word's harder cards stay locked until
 * its easiest one is holding — which is the difference between a deck that
 * teaches and one that punishes — and that two cards of the same word never sit
 * next to each other, since the second would be answered from the first rather
 * than from memory.
 *
 *   node scripts/test-language-cards.mjs
 */
import {
  RECOGNISE, PRODUCE, DICTATE, CLOZE, UNLOCK_STABILITY, NEW_PER_DAY,
  languageCards, buildQueue, unlocked, clozeOf, studyColumns, dueCount,
  normalizeLanguageTable, isLanguageTablePath
} from '../src/language-table.js'
import { DAY, newCard } from '../src/srs.js'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

const PATH = 'languages/🇬🇷 Greece/Vocabulary.language.md'
const T0 = 1_700_000_000_000

const TABLE = `| Word | English | Example | Notes |
| --- | --- | --- | --- |
| καρότο | carrot | Το καρότο είναι πορτοκαλί. | neuter noun |
| ρύζι | rice |  |  |
| ναι | yes | Ναι, ευχαριστώ. |  |
| | orphaned |  |  |
`

/* ------------------------------------------------------------ the table */

check('path: the suffix names a language table', isLanguageTablePath(PATH))
check('path: an ordinary note is not one', !isLanguageTablePath('notes/Greek.md'))
check('normalize: a note is exactly its first table',
  normalizeLanguageTable(`# Words\n\n${TABLE}\nafter`).startsWith('| Word |'))
check('normalize: a note with no table gets the template',
  normalizeLanguageTable('nothing here').includes('| Word |'))

/* Every setting this file documents lives in the frontmatter, and the
   normaliser runs over the note each time it is opened — so a normaliser that
   dropped the frontmatter (which it did) meant none of them could survive
   being read once. */
const WITH_FRONTMATTER = `---\nstudy-stages: f\nlang: el\n---\n${TABLE}`
check('normalize: the frontmatter survives',
  normalizeLanguageTable(WITH_FRONTMATTER).startsWith('---\nstudy-stages: f\nlang: el\n---\n'))
check('normalize: and the table still follows it',
  normalizeLanguageTable(WITH_FRONTMATTER).includes('\n| Word |'))
check('normalize: prose after the frontmatter still goes',
  !normalizeLanguageTable(`---\nlang: el\n---\n# Words\n\n${TABLE}\nafter`).includes('# Words'))
check('normalize: a note that is only frontmatter gets the template',
  normalizeLanguageTable('---\nlang: el\n---\n').includes('| Word |'))
check('normalize: an unclosed --- block is not frontmatter',
  normalizeLanguageTable(`---\nlang: el\n${TABLE}`).startsWith('| Word |'))
check('normalize: it is idempotent',
  normalizeLanguageTable(normalizeLanguageTable(WITH_FRONTMATTER)) ===
  normalizeLanguageTable(WITH_FRONTMATTER))

/* An alphabet table is an ordinary language table, which is the whole point of
   seeding one — but recognition-only, because a script has many letters to a
   sound (Greek ι and η are both `i`) and the reverse card would have an answer
   the grader cannot accept. */
const ALPHABET = `---\nstudy-stages: f\n---\n| Letter | Sound | Notes |\n| --- | --- | --- |\n| α | a |  |\n| η | i |  |\n| ι | i |  |\n`
const alphabetCards = languageCards(ALPHABET, 'languages/🇬🇷 Greece/Alphabet.language.md',
  { speaks: true })

check('alphabet: one card per letter', alphabetCards.length === 3,
  `got ${alphabetCards.length}`)
check('alphabet: recognition only',
  alphabetCards.every((card) => card.kind === RECOGNISE))
check('alphabet: the letter is the prompt and the sound the answer',
  alphabetCards[0].prompt === 'α' && alphabetCards[0].answer === 'a')
check('alphabet: two letters of one sound do not collide',
  alphabetCards[1].id !== alphabetCards[2].id)

check('columns: found by name',
  JSON.stringify(studyColumns(TABLE)) === JSON.stringify({ front: 'Word', back: 'English' }))
check('columns: the first two, for a table that names neither',
  JSON.stringify(studyColumns('| Term | Meaning |\n| --- | --- |\n| a | b |')) ===
  JSON.stringify({ front: 'Term', back: 'Meaning' }))
check('columns: the frontmatter overrides both',
  studyColumns(`---\nstudy-front: Term\nstudy-back: Gloss\n---\n| Term | Gender | Gloss |\n| --- | --- | --- |\n| a | b | c |\n`)
    ?.back === 'Gloss')

/* ------------------------------------------------------------- the cloze */

check('cloze: the word comes out of its sentence',
  clozeOf('Το καρότο είναι πορτοκαλί.', 'καρότο') === 'Το ____ είναι πορτοκαλί.')
check('cloze: found despite case and accents',
  clozeOf('Ναι, ευχαριστώ.', 'ναι') === '____, ευχαριστώ.')
check('cloze: only on a word boundary',
  clozeOf('Το καρότο είναι πορτοκαλί.', 'το') === '____ καρότο είναι πορτοκαλί.')
check('cloze: a word that is not in the sentence has no card',
  clozeOf('Το ρύζι είναι λευκό.', 'καρότο') === '')
check('cloze: nothing to blank in an empty sentence', clozeOf('', 'καρότο') === '')
check('cloze: a one-letter word is not blanked out of a sentence',
  clozeOf('a b c', 'a') === '')

/* -------------------------------------------------------------- the cards */

const cards = languageCards(TABLE, PATH)
const of = (term) => cards.filter((card) => card.term === term)
const kinds = (term) => of(term).map((card) => card.kind).sort().join('')

check('cards: a half-written row is not a word', !cards.some((c) => c.answer === 'orphaned'))
check('cards: recognition and production for a bare row', kinds('ρύζι') === 'fr')
check('cards: a row with a usable sentence also gets a cloze', kinds('καρότο') === 'cfr')
check('cards: no dictation without a voice', !cards.some((c) => c.kind === DICTATE))
check('cards: dictation appears when the language can be spoken',
  languageCards(TABLE, PATH, { speaks: true }).some((c) => c.kind === DICTATE))

const recognise = of('καρότο').find((c) => c.kind === RECOGNISE)
const produce = of('καρότο').find((c) => c.kind === PRODUCE)
const cloze = of('καρότο').find((c) => c.kind === CLOZE)
check('cards: recognition asks the word and answers the meaning',
  recognise.prompt === 'καρότο' && recognise.answer === 'carrot')
check('cards: production is the other way round',
  produce.prompt === 'carrot' && produce.answer === 'καρότο')
check('cards: the cloze asks the sentence and answers the word',
  cloze.prompt.includes('____') && cloze.answer === 'καρότο')
check('cards: recognition is revealed, the rest are typed',
  !recognise.typed && produce.typed && cloze.typed)
check('cards: the aside travels with every card of the row',
  of('καρότο').every((card) => card.aside === 'neuter noun'))
check('cards: an id names the note, the word and the kind',
  recognise.id === `${PATH}|καρότο|f`)
check('cards: both directions of a row share the term half of the id',
  produce.id === `${PATH}|καρότο|r`)

check('cards: study-reverse no leaves recognition alone',
  languageCards(`---\nstudy-reverse: no\n---\n${TABLE}`, PATH)
    .every((card) => card.kind === RECOGNISE))
check('cards: study-stages picks the kinds',
  new Set(languageCards(`---\nstudy-stages: cloze\n---\n${TABLE}`, PATH)
    .map((card) => card.kind)).size === 2)
check('cards: study-stages always keeps recognition',
  languageCards(`---\nstudy-stages: cloze\n---\n${TABLE}`, PATH)
    .some((card) => card.kind === RECOGNISE))
check('cards: a table with no rows makes no cards',
  languageCards('| Word | English |\n| --- | --- |\n', PATH).length === 0)
check('cards: text with no table makes no cards', languageCards('hello', PATH).length === 0)

/* ------------------------------------------------------------ unlocking */

const held = (stability) => ({ ...newCard(), reps: 3, stability, due: T0 })

check('unlock: recognition needs nothing', unlocked(recognise, {}))
check('unlock: production waits for a word that is not held yet',
  !unlocked(produce, { [recognise.id]: held(UNLOCK_STABILITY - 3) }))
check('unlock: production opens once recognition is holding',
  unlocked(produce, { [recognise.id]: held(UNLOCK_STABILITY + 1) }))
check('unlock: a word never seen holds nothing back but itself',
  !unlocked(produce, {}))
check('unlock: a card already in play is never taken away',
  unlocked(produce, {
    [recognise.id]: held(1),
    [produce.id]: { ...newCard(), reps: 1 }
  }))

/* -------------------------------------------------------------- the queue */

const fresh = buildQueue(cards, {}, T0)
check('queue: a new deck offers only the words themselves',
  fresh.every((card) => card.kind === RECOGNISE), fresh.map((c) => c.kind).join(''))
check('queue: one card per word on the first day',
  new Set(fresh.map((card) => card.term)).size === fresh.length)

check('queue: the day’s budget for new words is respected',
  buildQueue(cards, {}, T0, { newPerDay: 1 }).length === 1)
check('queue: the budget defaults to something a person can finish',
  NEW_PER_DAY <= 12, `${NEW_PER_DAY}`)

/* Everything held and overdue by different amounts: the most overdue first. */
const overdue = {}
for (const [at, card] of cards.filter((c) => c.kind === RECOGNISE).entries()) {
  overdue[card.id] = { ...held(30), due: T0 - (at + 1) * DAY }
}
const ordered = buildQueue(cards, overdue, T0, { newPerDay: 0 })
check('queue: the most overdue card comes first',
  ordered[0].term === cards.filter((c) => c.kind === RECOGNISE).at(-1).term,
  ordered.map((c) => c.term).join(' '))

/* With every word held, all four kinds are open at once — which is where two
   cards of one word could end up adjacent. */
const open = { ...overdue }
for (const card of cards) open[card.id] = { ...held(30), due: T0 - DAY }
const mixed = buildQueue(cards, open, T0, { newPerDay: 0 })
check('queue: every unlocked card is offered', mixed.length === cards.length)
check('queue: two cards of one word are never adjacent',
  mixed.every((card, at) => at === 0 || card.term !== mixed[at - 1].term),
  mixed.map((c) => `${c.term}/${c.kind}`).join(' '))

const leeched = { [recognise.id]: { ...held(30), due: T0 - DAY, lapses: 12 } }
check('queue: a leech is set aside rather than drilled',
  !buildQueue(cards, leeched, T0, { newPerDay: 0 }).some((card) => card.id === recognise.id))

const evening = new Date(T0)
evening.setHours(22, 0, 0, 0)
check('queue: a card due tonight is not withheld until tomorrow',
  buildQueue(cards, { [recognise.id]: { ...held(30), due: evening.getTime() } }, T0, { newPerDay: 0 })
    .some((card) => card.id === recognise.id))

check('due: the count is what the session will actually offer',
  dueCount(cards, {}, T0, { newPerDay: 2 }) === buildQueue(cards, {}, T0, { newPerDay: 2 }).length)

console.log(failures ? `\n${failures} failed` : 'language cards: all checks passed')
process.exit(failures ? 1 : 0)
