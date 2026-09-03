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
const nullableStringList = (v) => Array.isArray(v) && v.every((item) => item === null || string(item))
const numberList = (v) => Array.isArray(v) && v.every(number)
const booleanList = (v) => Array.isArray(v) && v.every(boolean)
/* A plain object of JSON scalars — the model catalogue and the saved searches.
   Deliberately shallow: nothing that reads these walks a nested structure. */
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
/* A record whose values are all strings — the custom hotkeys, command id to
   accelerator. The strings are validated again where they are spent (see
   `usableAccelerator` in main.js); this only pins the shape. */
const recordOfStrings = (v) => record(v) && Object.values(v).every(string)
const recordOfNumbers = (v) => record(v) && Object.values(v).every(number)
/* `undefined` clears a key. The renderer sends it for "forget the last note". */
const orCleared = (check) => (v) => v === undefined || check(v)

const MEASURE_NAMES = ['narrow', 'normal', 'wide']

const CONFIG_KEYS = {
  /* Read by main, and so the ones where a wrong type reaches real logic. */
  durability: string,
  historyInVault: boolean,
  /* Written only after the integrity-checked backup call has completed. */
  lastBackupAt: number,
  manimQuality: string,
  pdfText: boolean,
  /* Whether a python block that fails on a missing import may install it — see
     electron/python-env.js. A preference, so it is here; `pythonInstaller`,
     which names the command that does the installing, is deliberately not, for
     the same reason `manimCommand` is not. */
  autoInstallPythonDeps: boolean,
  texEngine: string,
  zoom: number,
  /* How large the reader reads web pages, which is a preference of theirs and
     not a property of any one site — see `setZoom` in src/site.js. Held apart
     from `zoom`, which is the whole window's. */
  siteZoom: number,

  /* The window and its panels. */
  ai: string,
  sidebar: string,
  /* No longer written: the sidebar's upper panel is the file tree and nothing
     else. Still accepted, so a config left by an older version loads rather
     than being rejected, and `paneBelow` is read out of it once. */
  pane: orCleared(string),
  /* The optional second sidebar panel, and how much of the height it takes. */
  paneBelow: orCleared(string),
  paneBelowHeight: number,
  paneBelowHeights: recordOfNumbers,
  sideDoc: orCleared(string),
  /* The size the run output popup was left at, in pixels — see `legalRunSize`
     in src/runcode.js, which clamps both to the stage on the way in, so a
     number out of range here can only ever open as a panel that fits. */
  runWidth: number,
  runHeight: number,
  railWidth: number,
  sideWidth: number,
  chatWidth: number,
  texSourceRatio: number,

  /* What was open, for restoring the session. */
  view: string,
  lastNote: orCleared(string),
  /* A blank tab is deliberately stored as null. Refusing the whole list when
     one was blank left the previous session on disk, including paths that had
     since disappeared. */
  tabs: nullableStringList,
  /* Where each tab was left, as a source line, one per entry of `tabs`. */
  tabPlaces: numberList,
  /* Which of them are pinned, again one per entry of `tabs`. */
  tabPinned: booleanList,
  tabIndex: number,
  expanded: stringList,

  /* The documents held in reading view until they are unlocked again, as
     vault-relative paths. A preference about particular files rather than
     about the app, but it is stored the same way the tab strip is and for the
     same reason: it has to survive a relaunch. */
  lockedFiles: stringList,

  /* Custom hotkeys: menu command id -> accelerator ('' = no key). */
  hotkeys: orCleared(recordOfStrings),

  /* Appearance. */
  theme: string,
  /* A lattice around every cell of a `.csv` grid, rather than rules between
     the columns only. */
  csvBorders: boolean,
  fontBody: string,
  fontUi: string,
  centerHeadings: boolean,
  codeNumbers: boolean,
  codeWrap: boolean,
  /* Line numbers down the side of a source file — `.py`, `.cpp`, `.tex`. Not
     notes: see `setLineNumbers` in editor.js for why prose is never numbered. */
  sourceNumbers: boolean,
  /* The writing column, by name — `MEASURES` in renderer.js maps the three
     to widths. (It was allowlisted as a number, which refused every write.) */
  measure: orCleared((v) => MEASURE_NAMES.includes(v)),
  outline: boolean,
  readableWidth: boolean,
  spellcheck: boolean,
  /* Languages checked beside English, as ids from src/spell-languages.js. An
     id with no shipped dictionary is skipped at load, so the list is only
     length-checked here. */
  spellLanguages: stringList,
  /* Milliseconds after the last keystroke, which is how the renderer reads it
     (`Number(cfg.autosave) || 600`). It was allowlisted as a boolean, with no
     settings row to write it — and had one been added, `Number(true)` is a
     1ms autosave. */
  autosave: orCleared(number),

  /* The copilot. */
  aiMode: string,
  aiModel: string,
  aiEffort: string,
  /* The keys of the models the picker offers, as the settings pane writes
     them — a list, so an install that has narrowed the catalogue keeps its
     choice. (It was allowlisted as a record, which refused every write.) */
  aiModels: stringList,

  /* Study. Cleared when the number field is emptied, which is how the pane
     says "back to the default". */
  studyNewPerDay: orCleared(number),
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
