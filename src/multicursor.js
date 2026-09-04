/* ======================================================= multi-cursor
   Option-click adds another caret, in the main editor and in notebook cells.

   CodeMirror already adds on Cmd-click (macOS) or Ctrl-click (elsewhere);
   this keeps that and adds Option-click, which is what Mac users reach for.
   A plain Alt-click is a single cursor, so adding it to the existing
   selections is multi-cursor; Alt-drag keeps its rectangular selection, now
   added to the existing carets rather than replacing them. Ctrl-click is
   left out on macOS so right-click keeps working.

   Kept here rather than in platform.js: that module is on the startup path
   that must stay free of CodeMirror (see the note at the top of
   blocks-editor.js), and this is the only place that needs both.
   ================================================================== */

import { EditorView } from '@codemirror/view'
import { isMac } from './platform.js'

/** Whether this click adds to the selection instead of replacing it. */
const addsMultiCursor = (event) =>
  event.altKey || event.metaKey ||
  (event.ctrlKey && !isMac())

/** The extension both editors install. */
export const multiCursor = EditorView.clickAddsSelectionRange.of(addsMultiCursor)
