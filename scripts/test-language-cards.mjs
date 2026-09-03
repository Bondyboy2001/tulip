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
  studyKinds, sessionGrade, studyFeedback, recordFirstTry,
  normalizeLanguageTable, importCards
} from '../src/language-table.js'
import { isLanguageTablePath } from '../src/vault-paths.js'
import { AGAIN, HARD, GOOD, DAY, newCard } from '../src/srs.js'
import { EXACT, CLOSE, WRONG } from '../src/study-match.js'
import VAULT_CONTRACT from '../electron/vault-contract.json'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

const PATH = 'languages/🇬🇷 Greece/Words.lang'
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
check('new table: starts with generic editable column names',
  VAULT_CONTRACT.languageTableTemplates.custom.startsWith('| COL1 | COL2 | COL3 |'))
/* A language table is a Markdown file with a Markdown table in it. The
   normaliser's whole job is the missing table; everything else in the note is
   the note's own business and is left exactly as written. */
check('normalize: a note that already has a table is left alone',
  normalizeLanguageTable(`# Words\n\n${TABLE}\nafter`) === `# Words\n\n${TABLE}\nafter`)
check('normalize: a note with no table gets the template',
  normalizeLanguageTable('nothing here').includes('| Word |'))
check('normalize: and what the note already said is kept above it',
  normalizeLanguageTable('nothing here').startsWith('nothing here\n\n'))

const WITH_FRONTMATTER = `---\nstudy-stages: f\nlang: el\n---\n${TABLE}`
check('normalize: the frontmatter survives',
  normalizeLanguageTable(WITH_FRONTMATTER) === WITH_FRONTMATTER)
check('normalize: prose after the frontmatter survives too',
  normalizeLanguageTable(`---\nlang: el\n---\n# Words\n\n${TABLE}\nafter`).includes('# Words'))
check('normalize: a note that is only frontmatter gets the template under it',
  normalizeLanguageTable('---\nlang: el\n---\n')
    === '---\nlang: el\n---\n' + VAULT_CONTRACT.languageTableTemplates.vocabulary)
check('normalize: an unclosed --- block is not frontmatter',
  normalizeLanguageTable('---\nlang: el\n').startsWith('---\nlang: el\n\n'))
check('normalize: it is idempotent',
  normalizeLanguageTable(normalizeLanguageTable('nothing here')) ===
  normalizeLanguageTable('nothing here'))

/* Vocabulary used to have its columns rewritten into a fixed schema on every
   open, which undid any rename or drag. Its table is now its own. */
check('normalize: Vocabulary keeps the columns it has',
  normalizeLanguageTable(TABLE) === TABLE)
check('normalize: Study finds the prompt and answer columns wherever they sit',
  JSON.stringify(studyColumns(TABLE)) === JSON.stringify({ front: 'Word', back: 'English' }))

/* An alphabet table is an ordinary language table, which is the whole point of
   seeding one — but recognition-only, because a script has many letters to a
   sound (Greek ι and η are both `i`) and the reverse card would have an answer
   the grader cannot accept. */
const ALPHABET = `---\nstudy-stages: f\n---\n| Letter | Sound | Notes |\n| --- | --- | --- |\n| α | a |  |\n| η | i |  |\n| ι | i |  |\n`
const alphabetCards = languageCards(ALPHABET, 'languages/🇬🇷 Greece/Alphabet.lang',
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
check('cards: every kind says what it is asking for',
  !!recognise.label && !!produce.label && !!cloze.label)
check('session: exact, close and wrong answers earn distinct scheduler grades',
  sessionGrade(EXACT) === GOOD &&
  sessionGrade(CLOSE) === HARD &&
  sessionGrade(WRONG) === AGAIN)
check('session: feedback clearly distinguishes right, close and wrong',
  studyFeedback(EXACT).text === '✓ Correct' &&
  studyFeedback(CLOSE).text === '~ Almost' &&
  studyFeedback(WRONG).text === '✕ Incorrect' &&
  studyFeedback(CLOSE).result === 'close')
const firstTry = { firstTrySeen: new Set(), firstTryCorrect: 0, firstTryWrong: 0 }
recordFirstTry(firstTry, 'water', true)
recordFirstTry(firstTry, 'bread', false)
recordFirstTry(firstTry, 'bread', true)
check('session: retries do not change first-attempt totals',
  firstTry.firstTryCorrect === 1 && firstTry.firstTryWrong === 1)
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
check('session: existing tables stay recognition-first',
  [...studyKinds(TABLE)].join('') === RECOGNISE)
check('session: explicit stages reach the study session',
  [...studyKinds(`---\nstudy-stages: all\n---\n${TABLE}`)].sort().join('') === 'cdfr')
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

/* ------------------------------------------------------------- importing */

{
  const apply = (text, edit) => text.slice(0, edit.at) + edit.insert + text.slice(edit.at)

  // Headerless rows land word-first in the note's own columns.
  const plain = importCards(TABLE, [['νερό', 'water', 'Πίνω νερό.', ''], ['ψωμί', 'bread']])
  check('headerless import adds every new word', plain.added === 2, String(plain.added))
  const grown = apply(TABLE, plain)
  check('imported words are studyable cards', languageCards(grown, PATH)
    .some((card) => card.kind === RECOGNISE && card.prompt === 'νερό' && card.answer === 'water'))
  check('the example column travels', grown.includes('Πίνω νερό.'))

  // A named header maps by name, whatever its order.
  const namedEdit = importCards(TABLE, [
    ['English', 'Word'],
    ['water', 'νερό'],
    ['bread', 'ψωμί']
  ])
  const namedGrown = apply(TABLE, namedEdit)
  check('a named header maps columns by name', languageCards(namedGrown, PATH)
    .some((card) => card.kind === RECOGNISE && card.prompt === 'ψωμί' && card.answer === 'bread'))

  // Words the table already holds are skipped, so a re-import is a no-op.
  const again = importCards(grown, [['νερό', 'water'], ['γάλα', 'milk']])
  check('a word already in the table is skipped', again.added === 1 && again.skipped === 1,
    `added ${again.added}, skipped ${again.skipped}`)

  // A pipe in a cell must not become a column.
  const piped = apply(TABLE, importCards(TABLE, [['α|β', 'a or b']]))
  check('a pipe in a value is escaped', piped.includes('α\\|β'))

  // A note with no table yet gains the template's.
  const fresh = importCards('Just a heading\n', [['νερό', 'water']])
  const freshGrown = apply('Just a heading\n', fresh)
  check('a bare note gains the template table', languageCards(freshGrown, PATH)
    .some((card) => card.prompt === 'νερό' && card.answer === 'water'))

  // Nothing worth adding says so rather than editing.
  const empty = importCards(TABLE, [])
  check('an empty file adds nothing', empty.added === 0 && empty.insert === '')
}

console.log(failures ? `\n${failures} failed` : 'language cards: all checks passed')
process.exit(failures ? 1 : 0)
