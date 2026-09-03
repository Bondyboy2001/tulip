/**
 * The completion list keeps its own height.
 *
 * CodeMirror's positioner squeezes a tooltip that would run off the screen to
 * the space it has — and remembers the height it squeezed from, for good. Type
 * `/` low on the page and the menu is squeezed to fit; type `call` after it
 * and the one row left sits at the top of a box the size of the whole list,
 * because the positioner still believes the list is that tall. Declining the
 * squeeze (`resize: false`) keeps the box the size of its rows; the list's own
 * max-height, half the window (editor.js's theme), is what keeps it on screen
 * — the positioner flips a menu to the roomier side of the caret, and half the
 * window always fits there.
 *
 * The view is found on the next update after the tooltip is created, and on
 * every update after, so a tooltip swapped in by a fresh result is caught too.
 */

import { ViewPlugin, getTooltip, showTooltip } from '@codemirror/view'

export const completionTooltipSize = ViewPlugin.fromClass(class {
  update (update) {
    for (const tooltip of update.state.facet(showTooltip)) {
      if (!tooltip) continue
      const shown = getTooltip(update.view, tooltip)
      if (shown && shown.resize !== false &&
          shown.dom.classList.contains('cm-tooltip-autocomplete')) {
        shown.resize = false
      }
    }
  }
})
