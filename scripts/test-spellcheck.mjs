/* The spellchecker's answer must not depend on how many languages are on:
   English-only behaviour is the shipped default, and the union is what makes
   a vault written in two languages readable — a word right in ANY enabled
   dictionary is right. Checked here against a two-word hand-written Hunspell
   pair rather than a shipped one, so the test is about the union and the
   taught list, not about which words the German dictionary happens to carry. */

import assert from 'node:assert/strict'
import { createSpeller } from '../src/spellcheck.js'

/* The smallest dictionary Hunspell accepts: a header line with the word
   count, then the words. Enough to stand in for a whole language. */
const TINY = {
  aff: 'SET UTF-8\n',
  dic: '2\nhaus\nstraße\n'
}

{
  const english = createSpeller('us')
  assert.deepEqual(english.check(['house', 'haus', 'wrogn']), ['haus', 'wrogn'],
    'english alone does not know german')
}

{
  const both = createSpeller('us', [], {
    languages: ['xx'],
    loadDictionary: (id) => (id === 'xx' ? TINY : null)
  })
  assert.deepEqual(both.check(['house', 'haus', 'wrogn']), ['wrogn'],
    'a word right in any enabled language is right')
  assert.deepEqual(both.check(['Haus']), [],
    'a capital that opens a sentence is not a misspelling')
}

{
  const degraded = createSpeller('us', [], {
    languages: ['missing'],
    loadDictionary: () => null
  })
  assert.deepEqual(degraded.check(['house', 'haus']), ['haus'],
    'a language whose files are gone is skipped, not fatal')
}

{
  const taught = createSpeller('us', ['Tulip'])
  assert.deepEqual(taught.check(['Tulip', 'tulip']), [],
    'a taught word is accepted in any case')
  taught.add('wrogn')
  assert.deepEqual(taught.check(['wrogn']), [],
    'a word taught mid-session is accepted from then on')
}

{
  const both = createSpeller('us', [], {
    languages: ['xx'],
    loadDictionary: () => TINY
  })
  const offered = both.suggest('hause')
  assert.ok(offered.length > 0 && offered.length <= 4, 'suggestions are bounded')
  assert.ok(offered.includes('haus'), 'the enabled language gets to suggest')
}

console.log('spellcheck: union, degradation, taught words, suggestions — all pass')
