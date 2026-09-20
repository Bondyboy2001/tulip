/* The Markdown contract behind multiple-choice cards. Rendering is covered by
   the Electron renderer harness; this keeps the source format and the form's
   serializer from drifting apart first. */
import assert from 'node:assert/strict'
import {
  FLASHCARD_TEMPLATE,
  buildFlashcardQueue,
  flashcardCards,
  flashcardTags,
  flashcardMarkdown,
  parseFlashcards
} from '../src/flashcards.js'
import { buildQueue, unlocked } from '../src/review-queue.js'
import { grade, GOOD, AGAIN } from '../src/srs.js'
import { makeReviewSink } from '../src/review-sink.js'
import { isFlashcardBankPath, isViewedFilePath } from '../src/vault-paths.js'

assert.match(FLASHCARD_TEMPLATE, /> \[!quiz\]/)
assert.match(FLASHCARD_TEMPLATE, /Explanation:/)
assert.equal(isFlashcardBankPath('Biology.fc'), true)
assert.equal(isViewedFilePath('Biology.fc'), false)

const source = flashcardMarkdown({
  question: 'What does a plant need for photosynthesis?',
  options: ['Salt', 'Light', 'Iron', 'Sound'],
  correct: 1,
  explanation: 'Chlorophyll uses light energy to drive photosynthesis.'
})

assert.ok(source)
const [card] = parseFlashcards(`# Biology\n\n${source}`)
assert.deepEqual(card, {
  question: 'What does a plant need for photosynthesis?',
  image: null,
  tags: [],
  options: ['Salt', 'Light', 'Iron', 'Sound'],
  correct: 1,
  explanation: 'Chlorophyll uses light energy to drive photosynthesis.',
  start: 2,
  end: 9
})

const pictured = flashcardMarkdown({
  question: 'Which bird is shown?',
  image: 'Attachments/puffins.jpg',
  options: ['Puffin', 'Gull'],
  correct: 0,
  explanation: 'The colourful bill identifies a puffin.'
})
assert.match(pictured, /> !\[\[Attachments\/puffins\.jpg\]\]/)
assert.equal(parseFlashcards(pictured)[0].image, 'Attachments/puffins.jpg')

const taggedBank = `---
type: flashcards
---

> [!quiz] What term describes the variety of species?
> Tags: ecology, biodiversity
> - [x] Biodiversity
> - [ ] Biodynamics
> - [ ] Biome
> - [ ] Ecology
> Explanation: Biodiversity means the variety of life in an ecosystem.

> [!quiz] What process turns light into stored chemical energy?
> Tags: ecology, plants
> - [x] Photosynthesis
> - [ ] Respiration
> Explanation: Plants use photosynthesis to store light energy.
`
const bankCards = parseFlashcards(taggedBank)
assert.equal(bankCards.length, 2)
assert.deepEqual(bankCards[0].tags, ['ecology', 'biodiversity'])
assert.deepEqual(flashcardTags(bankCards), ['ecology', 'biodiversity', 'plants'])
const ecology = buildFlashcardQueue(bankCards, 'ECOLOGY', () => 0)
assert.equal(ecology.length, 2)
assert.equal(new Set(ecology).size, 2, 'a cycle contains every matching card once')
assert.deepEqual(buildFlashcardQueue(bankCards, 'plants', () => 0).map((item) => item.question),
  ['What process turns light into stored chemical energy?'])

const taggedSource = flashcardMarkdown({
  question: 'Which biome is coldest?',
  tags: 'ecology, climate, Ecology',
  options: ['Tundra', 'Savanna'],
  correct: 0,
  explanation: 'Tundra has the lowest temperatures.'
})
assert.match(taggedSource, /^> \[!quiz\][^\n]+\n> Tags: ecology, climate/m)
assert.deepEqual(parseFlashcards(taggedSource)[0].tags, ['ecology', 'climate'])

const multiline = flashcardMarkdown({
  question: 'Which statement is true?',
  options: ['First', 'Second'],
  correct: 0,
  explanation: 'The first line is the key idea.\nThe second line adds context.'
})
assert.equal(parseFlashcards(multiline)[0].explanation,
  'The first line is the key idea.\nThe second line adds context.')

const manyChoices = flashcardMarkdown({
  question: 'Which number is prime?',
  options: ['4', '6', '8', '9', '10', '11'],
  correct: 5,
  explanation: 'Eleven has no positive divisors except one and itself.'
})
assert.deepEqual(parseFlashcards(manyChoices)[0].options,
  ['4', '6', '8', '9', '10', '11'])
assert.equal(parseFlashcards(manyChoices)[0].correct, 5)

assert.equal(flashcardMarkdown({
  question: 'Missing explanation', options: ['A', 'B'], correct: 0, explanation: ''
}), '')
assert.equal(parseFlashcards('> [!quiz] No answer\n> - [ ] A\n> - [ ] B').length, 0)
assert.equal(parseFlashcards('> [!quiz] Two answers\n> - [x] A\n> - [x] B\n> Explanation: Both').length, 0)

/* ------------------------------------------------ the scheduled study */

/* A card's id names it in the store's own grammar — `path|term|kind`, the same
   three parts a language row's id is built from — so one store, one relocate
   on rename, one prune pass and one statistics surface serve both decks. */
const scheduled = flashcardCards(taggedBank, 'Biology.fc')
assert.equal(scheduled.length, 2)
assert.equal(scheduled[0].id,
  'Biology.fc|What term describes the variety of species?|f')
assert.equal(scheduled[0].path, 'Biology.fc')
assert.equal(scheduled[0].term, 'What term describes the variety of species?')
assert.equal(scheduled[0].kind, 'f')
/* The gate that stages a language row's four cards opens unconditionally for
   a standalone card — there is no easier sibling to earn first. */
assert.ok(scheduled.every((card) => unlocked(card, {})))

/* A bank asking the same question twice still names two cards: the duplicate
   keeps its own schedule inside the id's term part. */
const twice = flashcardCards(
  '> [!quiz] Same\n> - [x] A\n> - [ ] B\n\n> [!quiz] Same\n> - [x] A\n> - [ ] B',
  'bank.fc')
assert.equal(twice[0].id, 'bank.fc|Same|f')
assert.equal(twice[1].id, 'bank.fc|Same#2|f')

/* The queue is the scheduler's: new cards up to the day's budget, due cards
   first by how overdue they are, nothing answered today offered twice. */
const T0 = new Date('2026-01-01T12:00:00').getTime()
const queue = buildQueue(scheduled, {}, T0)
assert.equal(queue.length, 2, 'both fresh cards are within the new-per-day budget')
assert.equal(buildQueue(scheduled, {}, T0, { newPerDay: 1 }).length, 1)

const held = grade(undefined, GOOD, T0)
assert.equal(buildQueue(scheduled, { [scheduled[0].id]: held }, T0).length, 1,
  'a card just graded GOOD is scheduled ahead, not dealt again')
const failed = grade(undefined, AGAIN, T0)
assert.equal(buildQueue(scheduled, { [scheduled[0].id]: failed }, T0).length, 1,
  'an AGAIN is minutes away, not today')
assert.equal(buildQueue(scheduled, { [scheduled[0].id]: failed },
  T0 + 24 * 3600e3).length, 2, 'and due again by tomorrow')

/* The session's bookkeeping: answers batch, a retracted answer is never
   written, and a settle leaves nothing owed. */
{
  const writes = []
  const unrecords = []
  const sink = makeReviewSink({
    record: async (batch) => writes.push(batch),
    unrecord: async (entry) => unrecords.push(entry),
    delay: 1
  })
  const one = { id: 'a|q|f', at: 1, grade: GOOD, state: {} }
  const two = { id: 'a|r|f', at: 2, grade: AGAIN, state: {} }
  sink.offer(one)
  sink.offer(two)
  sink.retract(two, { id: two.id, at: two.at, state: null })
  await sink.settle()
  assert.equal(writes.length, 1, 'the burst coalesced into one write')
  assert.deepEqual(writes[0].map((entry) => entry.id), ['a|q|f'])
  assert.equal(unrecords.length, 0, 'a retracted pending entry never reached the store')

  /* A failed write puts the batch back rather than losing the answers. */
  let dropped = false
  const frail = makeReviewSink({
    record: async (batch) => { if (!dropped) { dropped = true; throw new Error('io') } writes.push(batch) },
    delay: 1
  })
  frail.offer(one)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(frail.size, 1, 'the failed batch is still owed')
  await frail.settle()
  assert.equal(writes.at(-1).length, 1, 'the retry delivered it')
}

console.log('flashcards: all checks passed')
