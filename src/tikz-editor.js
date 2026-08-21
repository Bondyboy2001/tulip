/* ================================================= tikz, editing
   The picture standing under the fence that describes it, and the facet naming the note it is drawn for.

   Split out so the reading view can render one without CodeMirror on the
   startup path — see the note at the top of blocks.js.
   ================================================== */

import { WidgetType } from '@codemirror/view'
import { Facet } from '@codemirror/state'
import { pictureBlocks } from './blocks-editor.js'
import { isTikz, tikzRun, pictureFor } from './tikz.js'
import { el } from './dom.js'

/* ------------------------------------------------- the editing view */

/* Which note the editor is showing, as the function the renderer already keeps
   for the title — the widgets need it to name the file a drawing goes to, and
   asking for it at the moment one is built means a note switch cannot leave a
   widget writing into the note it used to be. A facet carries it in rather than
   a module-level variable, the same route the embed resolver takes. */
export const tikzNote = Facet.define({
  combine: (values) => values[0] || (() => 'Untitled')
})

/**
 * The picture, standing under the fence that describes it. Cached drawings
 * appear without anything being run; a block that has never been drawn shows
 * the button that draws it.
 *
 * A StateField rather than a ViewPlugin — block widgets change line geometry —
 * and the widget asks the editor to measure again whenever it changes height,
 * or every line below it ends up out of step with where it is drawn.
 */
class PictureWidget extends WidgetType {
  constructor (code) { super(); this.code = code }

  // Equal while the block's text is unchanged, so typing elsewhere in the note
  // maps the widget across rather than redrawing — and a running block is not
  // torn down mid-render by an edit three paragraphs away.
  eq (other) { return other.code === this.code }

  toDOM (view) {
    const noteName = view.state.facet(tikzNote)() || 'Untitled'
    const host = el('div', 'cm-tikz')
    const stage = el('div', 'cm-tikz-stage')
    const bar = el('div', 'cm-tikz-bar')
    host.append(stage, bar)

    const measure = () => view.requestMeasure()
    const run = tikzRun(this.code, noteName, (path) => {
      stage.replaceChildren(path ? pictureFor(path, measure) : '')
      stage.hidden = !path
      measure()
    }, measure)

    stage.hidden = true
    bar.append(run.button)
    host.append(run.status)
    return host
  }

  ignoreEvent () { return true }
}

export const tikzBlocks = pictureBlocks(isTikz, (code) => new PictureWidget(code))
