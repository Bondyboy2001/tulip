/* The Markdown contract behind multiple-choice cards. Rendering is covered by
   the Electron renderer harness; this keeps the source format and the form's
   serializer from drifting apart first. */
import assert from 'node:assert/strict'
import {
  FLASHCARD_TEMPLATE,
  buildFlashcardQueue,
  flashcardTags,
  flashcardMarkdown,
  parseFlashcards
} from '../src/flashcards.js'
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

console.log('flashcards: all checks passed')
