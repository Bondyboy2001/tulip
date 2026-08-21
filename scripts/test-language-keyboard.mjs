import assert from 'node:assert/strict'
import ALPHABETS from '../electron/alphabets.json' with { type: 'json' }
import { transliterationMap, transliterateLatin } from '../src/keyboard.js'

const greek = transliterationMap(ALPHABETS.byName.greek.split(/\s+/))

assert.equal(transliterateLatin('sno', greek), 'σνο')
assert.equal(transliterateLatin('thema', greek), 'θεμα')
assert.equal(transliterateLatin('Logos', greek, true), 'Λογος')
assert.equal(transliterateLatin('ps', greek), 'ψ')

console.log('language keyboard: 4/4 passed')
