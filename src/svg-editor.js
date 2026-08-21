/* ================================================= svg, editing
   The drawing standing under the fence that describes it.

   Split out so the reading view can render one without CodeMirror on the
   startup path — see the note at the top of blocks.js.
   ================================================== */

import { WidgetType } from '@codemirror/view'
import { pictureBlocks } from './blocks-editor.js'
import { isSvg, drawInto } from './svg.js'

/**
 * The same drawing, under the fence you are typing into.
 *
 * A StateField rather than a ViewPlugin: block widgets change line geometry,
 * and a plugin cannot be consulted before the viewport it would change has
 * been measured. Same rule the diagrams and run controls follow.
 */
class DrawingWidget extends WidgetType {
  constructor (code) { super(); this.code = code }

  // Equal while the source is unchanged, so typing elsewhere in the note maps
  // the widget across rather than re-reading every drawing.
  eq (other) { return other.code === this.code }

  toDOM () {
    const host = document.createElement('div')
    host.className = 'cm-drawing'
    // Unlike mermaid there is no wait, so nothing lands after the editor has
    // measured — the widget is its final height before it is ever handed back.
    drawInto(host, this.code)
    return host
  }

  ignoreEvent () { return true }
}

export const svgBlocks = pictureBlocks(isSvg, (code) => new DrawingWidget(code))
