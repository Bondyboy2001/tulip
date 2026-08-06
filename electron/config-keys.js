'use strict'

/* ====================================================== settable config keys
   Which settings the renderer is allowed to write, and what shape each one has.

   `config:set` used to merge whatever object arrived straight into the config
   file. Everything else in main treats the renderer as untrusted — paths are
   realpath-contained, guests are fenced, the preload has no generic invoke —
   but this one channel let it write any key at all, and some config keys are
   not preferences:

     vaultPath, defaultVaultPath   where every later path is resolved against
     tikzCommand, manimCommand     split on whitespace and spawned

   So the renderer could have moved the vault out from under the app, or turned
   ```tikz into an arbitrary command, through a call meant for remembering which
   pane is open. Nothing in the app does that today; the point is that the shape
   of the channel should not permit it.

   Main still writes those keys itself (pickVault, boot) — this list governs the
   IPC handler only, not `writeConfig`. Adding a setting means adding it here,
   which is the intended cost: an allowed key is a decision, not an accident.

   Kept as its own CommonJS module — like search-narrow.js and vault-events.js —
   because the failure it prevents is invisible: a rejected key looks exactly
   like a setting that quietly does not stick, so it is worth testing directly.
*/

const string = (v) => typeof v === 'string'
const boolean = (v) => typeof v === 'boolean'
const number = (v) => typeof v === 'number' && Number.isFinite(v)
const stringList = (v) => Array.isArray(v) && v.every(string)
const numberList = (v) => Array.isArray(v) && v.every(number)
/* A plain object of JSON scalars — the model catalogue and the saved searches.
   Deliberately shallow: nothing that reads these walks a nested structure. */
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
/* `undefined` clears a key. The renderer sends it for "forget the last note". */
const orCleared = (check) => (v) => v === undefined || check(v)

const CONFIG_KEYS = {
  /* Read by main, and so the ones where a wrong type reaches real logic. */
  durability: string,
  historyInVault: boolean,
  manimQuality: string,
  pdfText: boolean,
  texEngine: string,
  zoom: number,

  /* The window and its panels. */
  ai: string,
  sidebar: string,
  pane: orCleared(string),
  /* The optional second sidebar panel, and how much of the height it takes. */
  paneBelow: orCleared(string),
  paneBelowHeight: number,
  sideDoc: orCleared(string),
  railWidth: number,
  sideWidth: number,
  chatWidth: number,
  texSourceRatio: number,

  /* What was open, for restoring the session. */
  view: string,
  lastNote: orCleared(string),
  tabs: stringList,
  /* Where each tab was left, as a source line, one per entry of `tabs`. */
  tabPlaces: numberList,
  tabIndex: number,
  expanded: stringList,

  /* Appearance. */
  theme: string,
  fontBody: string,
  fontUi: string,
  centerHeadings: boolean,
  codeNumbers: boolean,
  codeWrap: boolean,
  measure: orCleared(number),
  outline: boolean,
  readableWidth: boolean,
  spellcheck: boolean,
  autosave: orCleared(boolean),

  /* The copilot. */
  aiMode: string,
  aiModel: string,
  aiEffort: string,
  aiModels: record,

  /* Study. */
  studyNewPerDay: number,
  studyRetention: number,
  studySpeaking: boolean,

  savedSearches: (v) => stringList(v) || Array.isArray(v) || record(v)
}

/**
 * The part of `patch` the renderer is allowed to write.
 *
 * Returns the accepted subset and the keys that were turned away, so the caller
 * can log the difference — a setting that silently does nothing is a bad way to
 * find out a key was never added to the list above.
 *
 * @param {unknown} patch
 * @returns {{ accepted: object, rejected: string[] }}
 */
function sanitizeConfigPatch (patch) {
  const accepted = {}
  const rejected = []
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { accepted, rejected }
  }
  /* Own enumerable keys only: a patch that arrived over IPC carrying
     `__proto__` or `constructor` has no business reaching a spread. */
  for (const key of Object.keys(patch)) {
    const check = Object.prototype.hasOwnProperty.call(CONFIG_KEYS, key) && CONFIG_KEYS[key]
    if (check && check(patch[key])) accepted[key] = patch[key]
    else rejected.push(key)
  }
  return { accepted, rejected }
}

module.exports = { CONFIG_KEYS, sanitizeConfigPatch }
