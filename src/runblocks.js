/* ========================================================== run widgets
   The editing view's Run control, in the two places the reading view puts it:
   the button on the fence's header line, out at the right beside the language
   chip, and the output panel under the block. The state behind them is keyed
   by the block's code (see runcode.js), so a run started in one view is the
   same run in the other.

   A StateField, not a ViewPlugin — block widgets change line geometry, and a
   plugin cannot be consulted before the viewport it would change has been
   measured; the symptom is a null-deref inside focus(). Same rule the title
   widget follows.
   ================================================================== */

import { Decoration, WidgetType } from '@codemirror/view'
import { eachFence, fenceField } from './blocks.js'
import { isRunnable, retirePainters, runButtonUI, runPanelUI } from './runcode.js'
import { htmlButtonUI, htmlPanelUI, isHtmlRun } from './htmlrun.js'

/* An html block runs too — into a page rather than a process — and its
   controls stand in the same two places, so the widgets below serve both and
   only the UI a widget appends differs. */
const buttonUI = (lang) => (isHtmlRun(lang) ? htmlButtonUI : runButtonUI)
const panelUI = (lang) => (isHtmlRun(lang) ? htmlPanelUI : runPanelUI)

/* Both widgets are equal while the block's text is unchanged, so typing
   elsewhere in the note maps them rather than rebuilding them — and a running
   block's panel is not torn down mid-stream by an edit three paragraphs away.
   The widget owns its clicks, so the editor does not move the caret for them. */

/** The button, standing at the right of the fence's header line. */
class RunButtonWidget extends WidgetType {
  constructor (lang, code) { super(); this.lang = lang; this.code = code }
  eq (other) { return other.lang === this.lang && other.code === this.code }
  toDOM () {
    const slot = document.createElement('span')
    slot.className = 'tk-run-top'
    slot.append(buttonUI(this.lang)(this.lang, this.code))
    return slot
  }
  // Scrolling a block out of the viewport tears its widget down. The painter
  // registered above outlives the element unless it is told not to.
  destroy (dom) { retirePainters(dom) }
  ignoreEvent () { return true }
}

/** The output, under the closing fence. Hidden until the block has run. */
class RunPanelWidget extends WidgetType {
  constructor (lang, code) { super(); this.lang = lang; this.code = code }
  // The language is part of the key: the same body under ```py and ```jl is
  // two different runs, and a panel that compared only code would show one
  // block's output under the other.
  eq (other) { return other.lang === this.lang && other.code === this.code }
  toDOM (view) { return panelUI(this.lang)(this.lang, this.code, 'tk-run', () => view.requestMeasure()) }
  // A panel holds everything the block has printed; left registered, so does
  // the painter that was drawing into it.
  destroy (dom) { retirePainters(dom) }
  ignoreEvent () { return true }
}

function buildRunWidgets (state) {
  const widgets = []

  eachFence(state, ({ node, first, lang, code }) => {
    if (!isRunnable(lang) && !isHtmlRun(lang)) return

    /* The button goes at the end of the opening fence line, where the chip
       already is; the CSS lifts it out of the text flow and over to the right,
       so it costs the line no width and no height. */
    widgets.push(
      Decoration.widget({
        widget: new RunButtonWidget(lang.toLowerCase(), code),
        side: 1
      }).range(first.to)
    )

    widgets.push(
      Decoration.widget({
        widget: new RunPanelWidget(lang.toLowerCase(), code),
        block: true,
        side: 1
      }).range(node.to)
    )
  })

  // Sorted: the two widgets per block are pushed in document order, but nested
  // blocks are not, and an unsorted set throws.
  return Decoration.set(widgets, true)
}

export const runBlocks = fenceField(buildRunWidgets)
