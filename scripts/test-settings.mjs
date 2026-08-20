/* The two rules the model picker in Settings is easy to get wrong.

   This used to read src/settings.js as a string and regex-match it, which meant
   it broke on any rename and passed on any behaviour change that happened to
   keep the same characters. Both rules are exported functions now, and this
   asks them questions instead. */

import assert from 'node:assert/strict'
import { groupCount, groupOpen } from '../src/model-groups.js'

/* ------------------------------------------------------ which groups open */

// Nothing typed and nothing clicked: everything folded. This is the whole
// reason the rule exists — four hundred models unfolded is not a list.
assert.equal(groupOpen(new Map(), 'OpenAI', ''), false)

// Typing opens them, because a result nobody can see is not a result.
assert.equal(groupOpen(new Map(), 'OpenAI', 'son'), true)

// A click outranks the search, in both directions: a group deliberately
// folded stays folded while the reader keeps typing, and one deliberately
// opened stays open when they clear the box.
assert.equal(groupOpen(new Map([['OpenAI', false]]), 'OpenAI', 'son'), false)
assert.equal(groupOpen(new Map([['OpenAI', true]]), 'OpenAI', ''), true)

// A decision about one group says nothing about another.
assert.equal(groupOpen(new Map([['OpenAI', true]]), 'Anthropic', ''), false)

/* The rule that was tried and rejected: opening a group because something in
   it is ticked. There is no count in the signature at all, which is the point —
   it cannot come back by accident. */
assert.equal(groupOpen.length, 3)

/* ------------------------------------------------------------ the counter */

// Out of what is shown, not out of everything the provider offers.
assert.equal(groupCount(3, 4), '3/4')
assert.equal(groupCount(0, 12), '0/12')
assert.equal(groupCount(412, 412), '412/412')

console.log('settings contracts: all checks passed')
