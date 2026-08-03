/* ================================================================ html runs
   An ```html block is a page, and running it shows the page.

   Nothing is spawned and nothing is written: the markup is the document, so
   this module is only the answer to "which fences are pages" and the page
   itself. The sandbox it runs in, the Run control, and why it is a <webview>
   rather than a frame of the app's own, are all guest.js.

   Reading view instantiates the page immediately. It can carry script, so it
   still lives inside the dedicated sandboxed guest described there; automatic
   rendering changes when that isolated document is created, not what it may
   access. Editing view keeps the deliberate Run/Close gesture, where source is
   the primary thing on screen.
   ================================================================== */

import { guestFence } from './guest.js'
import { DRAWN, languageId } from './languages.js'

/* Asked of languages.js rather than restated here: that table already knows
   every spelling a fence uses for HTML, and a copy of the list is how `xhtml`
   ends up drawing the chip without offering the preview it implies. */
export function isHtmlRun (lang) {
  return languageId(lang) === DRAWN.html
}

export const htmlFence = guestFence({
  tag: 'html',
  label: 'HTML page',
  tips: { run: 'Run this block as a page', close: 'Close the page' },
  // The block is the document, whole.
  page: (code) => code
})
