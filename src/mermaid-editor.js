/* ================================================= diagrams, editing
   The diagram widget under the fence you are typing into, and the effect that redraws every one of them when the palette moves.

   Split out so the reading view can render one without CodeMirror on the
   startup path — see the note at the top of blocks.js.
   ================================================== */

import { WidgetType } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { pictureBlocks } from './blocks-editor.js'
import { isMermaid, drawInto, themeName } from './mermaid.js'

/* Dispatched when the palette moves. Nothing in the document has changed, so
   no ordinary update would tell the field to redraw — and a diagram left in
   the old theme's colours on a repainted page is the one thing that would
   give the whole arrangement away. */
export const refreshDiagrams = StateEffect.define()

/**
 * The same diagram, under the fence you are typing into.
 *
 * A StateField rather than a ViewPlugin: block widgets change line geometry,
 * and a plugin cannot be consulted before the viewport it would change has
 * been measured. Same rule the run controls and the title widget follow.
 */
class DiagramWidget extends WidgetType {
  constructor (code, theme) { super(); this.code = code; this.theme = theme }

  // Equal while the source and the palette are unchanged, so typing elsewhere
  // in the note maps the widget across rather than redrawing every diagram.
  eq (other) { return other.code === this.code && other.theme === this.theme }

  toDOM (view) {
    const host = document.createElement('div')
    host.className = 'cm-diagram'
    // Held at the last size until the new drawing lands, so the page does not
    // jump on every keystroke inside the block.
    //
    // The drawing arrives after the editor has measured the widget, and a
    // height it does not know about puts every line below the diagram out of
    // step with where it is drawn — so it is asked to measure again once the
    // picture is in. Same rule the embeds follow.
    drawInto(host, this.code)
      .then(() => view.requestMeasure())
      .catch(() => {})
    return host
  }

  ignoreEvent () { return true }
}

export const mermaidBlocks = pictureBlocks(
  isMermaid,
  (code) => new DiagramWidget(code, themeName()),
  // The palette moving changes nothing in the document, so no ordinary update
  // would tell the field to redraw — and a diagram left in the old theme's
  // colours on a repainted page is the one thing that would give the whole
  // arrangement away.
  { also: (tr) => tr.effects.some((e) => e.is(refreshDiagrams)) }
)
