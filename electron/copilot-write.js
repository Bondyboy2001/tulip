'use strict'

/*
 * The file write, offered to the Copilot the way the rename and the vault
 * search already are: through a request file, because a file tool is the one
 * write surface every CLI has. In propose mode it is also the *only* write
 * surface — the permission fence denies `edit` for every path but this one,
 * so a change can be described without ever being able to land. The agent
 * writes `.tulip-copilot-write.json`; main reads the proposed changes out of
 * it, holds them, and the panel offers Apply — the write itself then goes
 * through Tulip's own save path, with its version snapshot and its index
 * touch, exactly as if the reader had typed it. Nothing in the vault moves
 * before that click, which is the whole point of the mode.
 */
const REQUEST_PATH = '.tulip-copilot-write.json'

const { normal, isStaleRequest } = require('./copilot-request')
const isRequestPath = (value) => normal(value) === REQUEST_PATH

/* A single proposed change is one of two shapes:

   - `{ "path": "notes/x.md", "content": "…" }` — the file's whole new text.
     The only shape that can create a file.
   - `{ "path": "notes/x.md", "edits": [{ "find": "…", "replace": "…" }] }` —
     search-and-replace against the current text, so a long note's proposal
     does not have to carry the whole file to move one paragraph.

   `content` is a string that may be empty (a proposal to empty a file);
   `find` may not be — an empty needle matches everywhere and is a corruption
   waiting to be applied. */
const MAX_PROPOSED_BYTES = 4 * 1024 * 1024
const MAX_PROPOSED_WRITES = 24

function parseRequest (source) {
  let value
  try { value = JSON.parse(String(source || '')) } catch {
    throw new Error('The Copilot write request was not valid JSON.')
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('The Copilot write request must be an object.')
  }
  const list = Array.isArray(value.writes) ? value.writes : null
  if (!list || !list.length) {
    throw new Error('The Copilot write request needs a non-empty "writes" list.')
  }
  if (list.length > MAX_PROPOSED_WRITES) {
    throw new Error(`The Copilot write request may propose at most ${MAX_PROPOSED_WRITES} files.`)
  }
  const writes = list.map((one, index) => {
    if (!one || typeof one !== 'object' || Array.isArray(one)) {
      throw new Error(`Proposed write ${index + 1} is not an object.`)
    }
    const rel = String(one.path || '').trim()
    if (!rel) throw new Error(`Proposed write ${index + 1} has no "path".`)
    if (typeof one.content === 'string') {
      if (Buffer.byteLength(one.content, 'utf8') > MAX_PROPOSED_BYTES) {
        throw new Error(`Proposed write to ${rel} is larger than a note can be.`)
      }
      return { path: rel, content: one.content }
    }
    const edits = Array.isArray(one.edits) ? one.edits : null
    if (!edits || !edits.length) {
      throw new Error(`Proposed write to ${rel} needs "content" or a non-empty "edits" list.`)
    }
    return {
      path: rel,
      edits: edits.map((edit, at) => {
        if (!edit || typeof edit !== 'object' ||
            typeof edit.find !== 'string' || !edit.find.length ||
            typeof edit.replace !== 'string') {
          throw new Error(`Edit ${at + 1} of ${rel} needs a non-empty "find" and a "replace" string.`)
        }
        return { find: edit.find, replace: edit.replace }
      })
    }
  })
  /* Same turn-scoping as the rename request: `turnId` lets main drop a file
     written by another turn, `at` bounds how long a leftover stays runnable. */
  const turnId = typeof value.turnId === 'string' && value.turnId.length <= 120 ? value.turnId : null
  const at = Number(value.at) > 0 ? Number(value.at) : null
  return { writes, turnId, at }
}

/**
 * The text a `content`/`edits` pair makes of what is on disk.
 *
 * A `find` must match exactly once. Zero matches means the proposal was
 * written against a different version — the conflict path, reported rather
 * than applied. More than one means the needle names more than the place it
 * meant, and guessing which occurrence to replace is how a careful edit
 * becomes a quiet wrong one.
 *
 * @returns {string} the resulting text
 */
function applyEdits (before, edits) {
  let text = before
  for (const edit of edits) {
    const first = text.indexOf(edit.find)
    if (first === -1) throw new Error(`The proposed text was not found in the current file.`)
    if (text.indexOf(edit.find, first + edit.find.length) !== -1) {
      throw new Error('The proposed text matches more than one place in the current file.')
    }
    text = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length)
  }
  return text
}

module.exports = { REQUEST_PATH, isRequestPath, parseRequest, isStaleRequest, applyEdits }
