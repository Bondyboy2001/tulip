/* The half of the store test that runs the assertions. See test-copilot-store.mjs. */

import assert from 'node:assert/strict'

import {
  MAX_MESSAGES, MAX_PROSE, VAULT_CHAT, chatKey, dismissStarters, drop,
  isStarter, newChat, stepsIn, stored, summarise, title, trim
} from '../src/copilot-chat.js'
import { createStore } from '../src/copilot-store.js'

let passed = 0
const ok = async (what, fn) => { await fn(); passed++; console.log(`ok - ${what}`) }

const say = (text) => ({ t: 'you', text })
const heard = (text) => ({ t: 'bot', text })
const step = (name, path, extra = {}) => ({ t: 'step', id: `${name}:${path}`, name, path, done: true, ...extra })

/* ------------------------------------------------------------- the cap */

await ok('the cap sheds machinery first — prose only when the prose alone is over its cap', () => {
  // Sixty prose rows — exactly the prose cap — and ninety-five steps.
  const convo = newChat()
  for (let at = 0; at < MAX_PROSE / 2; at++) {
    convo.messages.push(say(`Question ${at}`), heard(`Answer ${at}`))
  }
  for (let at = 0; at < 95; at++) convo.messages.push(step('Read', `note-${at}.md`))
  trim(convo)
  // Five steps went, oldest first, and not one word of prose.
  assert.equal(convo.messages.length, MAX_MESSAGES)
  assert.ok(!convo.messages.some((m) => m.t === 'step' && m.path === 'note-0.md'))
  assert.ok(convo.messages.some((m) => m.t === 'step' && m.path === 'note-94.md'))
  assert.equal(convo.messages.filter((m) => m.t === 'you' || m.t === 'bot').length, MAX_PROSE)
})

await ok('prose is shed only once there is more of it than the prose cap', () => {
  const convo = newChat()
  for (let at = 0; at < 80; at++) {
    convo.messages.push(say(`Question ${at}`), heard(`Answer ${at}`))
  }
  assert.ok(convo.messages.length > MAX_MESSAGES)
  trim(convo)
  assert.equal(convo.messages.length, MAX_MESSAGES)
  // The oldest five pairs went; the newest are all still there.
  assert.ok(!convo.messages.some((m) => m.text === 'Question 0'))
  assert.ok(!convo.messages.some((m) => m.text === 'Answer 4'))
  assert.ok(convo.messages.some((m) => m.text === 'Question 5'))
  assert.ok(convo.messages.some((m) => m.text === 'Question 79'))
})

await ok('a dropped step stops being findable by its call id', () => {
  const convo = newChat()
  const row = step('Read', 'a.md')
  convo.messages.push(row)
  stepsIn(convo)
  assert.equal(convo.steps.get('Read:a.md'), row)
  drop(convo, row, 0)
  assert.ok(!convo.steps?.has('Read:a.md'))
})

/* ------------------------------------------------------- the starter */

await ok('the invitation is UI, not history, and is recognisable either way it was saved', () => {
  const convo = newChat()
  convo.messages.push({ t: 'note', starter: true, text: 'Ask about a, or anything else in the vault. You will see it edit. Type @ for a file, / for commands.' })
  assert.ok(isStarter(convo.messages[0]))
  assert.ok(dismissStarters(convo))
  assert.equal(convo.messages.length, 0)
  // A chat saved before the marker existed carries the exact sentence.
  assert.ok(isStarter({ t: 'note', text: 'opencode has your vault open. Open a note to start a conversation about it.' }))
})

/* ------------------------------------------------------ the stored copy */

await ok('what is written down is not what was in memory', () => {
  const node = { remove () {} }
  const failed = stored({
    t: 'step', id: 's1', name: 'Bash', node, html: '<p>x</p>',
    detail: 'x'.repeat(2000), error: true
  })
  assert.equal(failed.node, undefined)
  assert.equal(failed.html, undefined)
  assert.equal(failed.detail.length, 600)

  // A read's output is not kept at all: half the vault would end up in the file.
  const read = stored({ t: 'step', id: 's2', name: 'Read', node, detail: 'the whole file', done: true })
  assert.equal(read.detail, undefined)

  // A question waiting its turn stays dropped: no queue survives the write.
  const queued = stored({ t: 'you', text: 'Later', queued: true })
  assert.equal(queued.queued, undefined)
  assert.equal(queued.dropped, true)
})

/* ----------------------------------------------------------- the digest */

await ok('the digest carries the questions, how they were answered, and the files', () => {
  const convo = newChat()
  convo.messages.push(
    say('What is a turing machine?'),
    step('Read', 'papers/turing.pdf'),
    heard('A turing machine is a model of computation.'),
    say('Fix the note'),
    step('Read', 'notes/a.md'),
    step('Write', 'notes/a.md'),
    step('Write', 'notes/a.md'),
    heard('Fixed. The heading was wrong and is now right.')
  )
  const digest = summarise(convo)
  assert.ok(digest.includes('What is a turing machine?'))
  assert.ok(digest.includes('answered: A turing machine is a model of computation.'))
  // Written and read are named apart, a written file is not also a read, and
  // a file written twice is named once.
  assert.ok(digest.includes('notes/a.md') && digest.includes('do not redo'))
  assert.ok(!/read[^]*notes\/a\.md[^]*changed/.test(digest))
  assert.ok(digest.match(/notes\/a\.md/g).length === 1)
  // And how the last reply ended.
  assert.ok(digest.includes('Fixed. The heading was wrong'))
})

await ok('the digest refuses to be built from an empty chat', () => {
  assert.equal(summarise(newChat()), '')
})

/* --------------------------------------------------------- naming */

await ok('a conversation is named by what was first asked in it', () => {
  const convo = newChat()
  assert.equal(title(convo), 'Empty chat')
  convo.messages.push(say(`What is ${'x'.repeat(100)}`))
  assert.ok(title(convo).endsWith('…'))
  assert.ok(title(convo).length <= 65)
})

await ok('the vault-wide chat is filed where no note can collide with it', () => {
  assert.equal(chatKey(''), VAULT_CHAT)
  assert.equal(chatKey('notes/a.md'), 'notes/a.md')
})

/* ------------------------------------------------------------ the store */

const makeStore = (overrides = {}) => {
  const writes = []
  const store = createStore({
    persist: async (payload) => { writes.push(payload); return { ok: true } },
    keepKey: () => chatKey('a.md'),
    entryBusy: (entry) => entry.convos.some((convo) => convo.busy),
    ...overrides
  })
  return { store, writes }
}

const spokenEntry = () => {
  const convo = newChat()
  convo.messages.push(say('Hello'), heard('Hi.'))
  return { at: convo.at, active: convo.id, convos: [convo] }
}

await ok('a write is a delta: only the notes that have said something', () => {
  const { store, writes } = makeStore()
  store.setEntry('a.md', spokenEntry())
  store.setEntry('b.md', spokenEntry())
  store.touch('a.md')
  store.flush()
  assert.equal(writes.length, 1)
  assert.deepEqual(Object.keys(writes[0].notes), ['a.md'])
  // And the next write, with nothing new, is not a write at all.
  store.flush()
  assert.equal(writes.length, 1)
})

await ok('an empty chat is launch state, and is not what survives a write', () => {
  const { store, writes } = makeStore()
  store.setEntry('a.md', spokenEntry())
  store.touch('a.md')
  // The reader visits a note and speaks nothing: an entry exists, a chat does not.
  store.entry('c.md')
  store.touch('c.md')
  store.flush()
  assert.deepEqual(Object.keys(writes[0].notes), ['a.md'])
})

await ok('the cap lets go of the oldest notes — but never one mid-turn', () => {
  const { store } = makeStore()
  for (let at = 0; at < 65; at++) {
    const entry = spokenEntry()
    entry.at = at
    entry.convos[0].at = at
    if (at === 3) entry.convos[0].busy = true
    store.setEntry(`old-${at}.md`, entry)
  }
  store.flush()
  // The five oldest were due to go; the busy one of them could not.
  assert.ok(!store.chats.has('old-0.md'))
  assert.ok(store.chats.has('old-3.md'))
  assert.ok(store.chats.has('old-64.md'))
  assert.equal(store.chats.size, 61)
})

await ok('a failed write is asked for again, not lost', async () => {
  let failing = true
  const reported = []
  const writes = []
  const store = createStore({
    persist: async (payload) => {
      writes.push(payload)
      if (failing) throw new Error('disk gone')
      return { ok: true }
    },
    keepKey: () => chatKey('a.md'),
    entryBusy: () => false,
    onWriteError: (err, unloading) => { if (!unloading) reported.push(String(err?.message)) }
  })
  store.setEntry('a.md', spokenEntry())
  store.touch('a.md')
  await store.flush()
  assert.equal(reported.length, 1)
  // The note is back on the dirty list: a retry carries it, once the disk is back.
  failing = false
  await store.flush()
  assert.equal(writes.length, 2)
  assert.deepEqual(Object.keys(writes[1].notes), ['a.md'])
})

await ok('a rename refiles the conversations and says both halves of the write', async () => {
  const { store, writes } = makeStore()
  store.setEntry('old.md', spokenEntry())
  store.touch('old.md')
  store.flush()
  writes.length = 0

  assert.ok(store.rename(() => 'new.md'))
  assert.ok(!store.chats.has('old.md'))
  assert.ok(store.chats.has('new.md'))

  // The rename is a write of both halves, whether or not anything else changed.
  store.flush()
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].remove, ['old.md'])
  assert.deepEqual(Object.keys(writes[0].notes), ['new.md'])
})

await ok('a rename onto a name nobody has spoken in gives way; a spoken one keeps both', () => {
  const { store } = makeStore()
  const oldEntry = spokenEntry()
  oldEntry.convos[0].messages[0].text = 'The real conversation'
  store.setEntry('old.md', oldEntry)

  const fresh = newChat()
  store.setEntry('new.md', { at: fresh.at, active: fresh.id, convos: [fresh] })
  store.rename(() => 'new.md')
  assert.equal(store.chats.get('new.md').convos.length, 1)
  assert.equal(store.chats.get('new.md').convos[0].messages[0].text, 'The real conversation')

  // And where somebody has spoken, the two are kept, the rescued one first.
  const spokenFresh = spokenEntry()
  spokenFresh.convos[0].messages[0].text = 'Already talking here'
  const other = createStore({
    persist: async () => ({ ok: true }),
    keepKey: () => chatKey('a.md'),
    entryBusy: () => false
  })
  other.setEntry('old.md', oldEntry)
  other.setEntry('new.md', { at: 0, active: spokenFresh.convos[0].id, convos: spokenFresh.convos })
  other.rename(() => 'new.md')
  const convos = other.chats.get('new.md').convos
  assert.equal(convos.length, 2)
  assert.equal(convos[0].messages[0].text, 'The real conversation')
})

await ok('what is read back is what was written, and the cap is applied again', () => {
  const { store, writes } = makeStore()
  store.setEntry('a.md', spokenEntry())
  store.touch('a.md')
  store.flush()
  const convo = writes[0].notes['a.md'].convos[0]
  const readBack = { 'a.md': { convos: [convo] } }
  store.ingest(readBack)
  const entry = store.chats.get('a.md')
  assert.equal(entry.convos.length, 2)   // the history, plus the fresh chat it begins with
  assert.equal(entry.convos[0].messages.length, 2)
  assert.ok(entry.convos[0].messages.every((m) => m.node === undefined))
})

await ok('a chat of a copilot Tulip no longer runs comes back with its gauge cleared', () => {
  const { store } = makeStore()
  store.ingest({ 'a.md': { convos: [{ id: 'c1', thread: 't', threadOf: 'devin', used: 50000, cost: 3, suggested: true, at: 1, messages: [{ t: 'you', text: 'Hello' }] }] } })
  const convo = store.chats.get('a.md').convos[0]
  assert.equal(convo.used, 0)
  assert.equal(convo.cost, 0)
  assert.equal(convo.suggested, false)
})

console.log(`${passed} copilot store checks passed`)
