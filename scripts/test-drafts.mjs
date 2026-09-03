/* ============================================================ drafts tests
 * The draft policy, against a fake editor.
 *
 * src/drafts.js answers two questions with real consequences for unsaved
 * work: when a draft goes out (only for an open, dirty, draftable document,
 * and only when the buffer has moved since the last write) and when one is
 * forgotten (only for the path that was actually written). Every branch
 * below is a way the wrong answer loses typing, or nags about typing that
 * landed. The store behind the policy is main's; see test-ipc.harness.cjs
 * for the draft:list side of the same seam.
 */

import assert from 'node:assert/strict'
import { makeDrafts } from '../src/drafts.js'

/** An app-shaped harness: one open note, one fake editor whose document is
 *  replaced by identity on every change, and a recording IPC seam. */
function harness ({ path = 'Notes/A.md', dirty = true, canDraft = () => true } = {}) {
  const saved = []
  const cleared = []
  let doc = { v: 1 }
  const state = { current: { path }, dirty }
  const editor = () => ({ state: { doc } })
  const drafts = makeDrafts({
    state,
    editor,
    canDraft,
    save: async (p, text) => { saved.push([p, text]); return { ok: true } },
    clear: (p) => { cleared.push(p) },
    docText: (d) => `text of v${d.v}`
  })
  return {
    drafts, saved, cleared, state, editor,
    edit () { doc = { v: doc.v + 1 } }   // a keystroke: a new Text object
  }
}

/* The ordinary path: an open, dirty, draftable note writes its text out. */
{
  const { drafts, saved } = harness()
  await drafts.writeDraft()
  assert.deepEqual(saved, [['Notes/A.md', 'text of v1']])
  console.log('ok - a dirty note\'s text goes out as a draft')
}

/* A note already on disk has nothing for the draft to protect. */
{
  const { drafts, saved } = harness({ dirty: false })
  await drafts.writeDraft()
  assert.deepEqual(saved, [])
  console.log('ok - a clean note writes no draft')
}

/* The caller decides what a draft makes sense for — a PDF has no buffer. */
{
  const { drafts, saved } = harness({ canDraft: () => false })
  await drafts.writeDraft()
  assert.deepEqual(saved, [])
  console.log('ok - an undraftable document writes no draft')
}

/* Nothing open, nothing to draft: the harness's note was "closed". */
{
  const { drafts, saved, state } = harness()
  state.current = null
  await drafts.writeDraft()
  assert.deepEqual(saved, [])
  console.log('ok - no open note writes no draft')
}

/* The identity check: the same document object is already on disk, and
   rewriting it every 1.2s is work nobody asked for. */
{
  const { drafts, saved } = harness()
  await drafts.writeDraft()
  await drafts.writeDraft()
  assert.equal(saved.length, 1)
  console.log('ok - an unchanged buffer is not written twice')
}

/* A keystroke makes a new Text object, and that is what buys the next draft. */
{
  const { drafts, saved, edit } = harness()
  await drafts.writeDraft()
  edit()
  await drafts.writeDraft()
  assert.deepEqual(saved, [['Notes/A.md', 'text of v1'], ['Notes/A.md', 'text of v2']])
  console.log('ok - a changed buffer writes again')
}

/* A write that never landed is forgotten here, so the next tick tries again
   instead of standing down on a save that did not happen. */
{
  let fail = true
  const saved = []
  const drafts = makeDrafts({
    state: { current: { path: 'A.md' }, dirty: true },
    editor: () => ({ state: { doc: { v: 1 } } }),
    canDraft: () => true,
    save: async () => { if (fail) throw new Error('renderer is going down'); saved.push(['A.md', 'x']) },
    docText: () => 'x'
  })
  await drafts.writeDraft()
  assert.equal(saved.length, 0)
  fail = false
  await drafts.writeDraft()
  assert.equal(saved.length, 1, 'the draft after a failed write is retried')
  console.log('ok - a failed write is retried on the next tick')
}

/* Forgetting is by path: the note written is not always the note on screen. */
{
  const { drafts, saved, cleared } = harness()
  await drafts.writeDraft()
  drafts.clearDraft('Notes/B.md')          // some other file landed
  await drafts.writeDraft()
  assert.equal(saved.length, 1, 'the draft for A survives a clear for B')
  assert.deepEqual(cleared, ['Notes/B.md'])
  drafts.clearDraft('Notes/A.md')          // A itself landed
  await drafts.writeDraft()
  assert.equal(saved.length, 2, 'after its own clear, the draft is written again')
  console.log('ok - a draft is only forgotten for the path that was written')
}

/* A clear with no path (nothing was open) is asked nothing and throws nothing. */
{
  const { drafts, cleared } = harness()
  drafts.clearDraft(null)
  assert.deepEqual(cleared, [])
  console.log('ok - clearing nothing clears nothing')
}

console.log('drafts tests passed')
