/* What each tool is doing, and what it did — the vocabulary of the working
   strip and of the step rows. Pure: a message or an event in, a phrase out.
   Split out of src/copilot.js so the strip and the transcript cannot drift
   apart in how they name the same call. */

/**
 * A call is announced with its arguments well before its result comes back —
 * often a minute before, for a command or a wide search — and naming both
 * states in the past tense made a call still running indistinguishable from
 * one that had finished. Two `Edited` rows on one file, one of them with no
 * diff beside it, is that ambiguity: the second had not happened yet.
 */
const TOOL_VERB = {
  Read: ['Reading', 'Read'],
  Edit: ['Editing', 'Edited'],
  Write: ['Writing', 'Wrote'],
  Glob: ['Searching', 'Searched'],
  Grep: ['Searching', 'Searched'],
  TodoWrite: ['Planning', 'Planned'],
  Bash: ['Running', 'Ran'],
  Rename: ['Renaming', 'Renamed'],
  Fetch: ['Fetching', 'Fetched'],
  Task: ['Delegating', 'Delegated']
}

/* The busy strip's account of a tool call: what is being done, and to what.
   The row underneath the strip says as much, but the strip is the line being
   read during the stretch when nothing else on screen moves — and "Working"
   held for the two minutes of a wide search is exactly the reading that makes
   a turn look hung. The name and the path are already in hand when the call is
   announced; this only spends them.

   Bounded, because the strip is one line and shares it with the timer: a file
   is named by its own name, and a command or a pattern — which have no such
   short form — is cut. */
const PHASE_LIMIT = 44

const NAMED_FILE = { Read: true, Edit: true, Write: true }

/** Which phase a tool call puts the turn in — "Editing copilot.js". */
export function phaseOf (event) {
  const verb = TOOL_VERB[event.name]?.[0] || event.name || 'Working'
  const what = !event.path
    ? ''
    : NAMED_FILE[event.name] ? event.path.split('/').pop() : event.path
  if (!what) return verb
  return `${verb} ${what.length > PHASE_LIMIT ? `${what.slice(0, PHASE_LIMIT - 1)}…` : what}`
}

/** A step saved before this existed has no `done`, and every one of them is
    over — nothing in a transcript read back from disk is still running. */
export const running = (msg) => msg.done === false

export const verbFor = (msg) =>
  TOOL_VERB[msg.name]?.[running(msg) ? 0 : 1] || msg.name

/** A step that goes somewhere when clicked: a write that landed, which the
    editor can open at the line it changed. */
export const jumps = (msg) =>
  (msg.name === 'Edit' || msg.name === 'Write' || msg.name === 'Rename') &&
  !!msg.path && !msg.error

/** A step that opens instead, on what the tool said. Everything that does not
    jump — searches, commands, reads, and writes that failed, which are the ones
    whose reason is worth reading and whose file did not change. */
export const opens = (msg) => !!msg.detail && !jumps(msg)
