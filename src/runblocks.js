// @ts-check
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
import { codeCopilotButton, copyButton, eachFence, fenceField } from './blocks.js'
import { isRunnable, retirePainters, runButtonUI, runPanelUI } from './runcode.js'
import { htmlFence, isHtmlRun } from './htmlrun.js'
import { isThree, threeFence } from './threejs.js'

/* What the editing view puts around a block, in the order the kinds are tried —
   the same shape, and for the same reason, as the reading view's BLOCK_KINDS in
   renderer.js. An html block runs into a page rather than a process, and a three
   block into a scene on a page Tulip builds; all three stand in the same two
   places, so only the pair of UIs a kind appends differs.

   A table rather than a ladder of ternaries because the ladder had to be
   written twice — once to choose the UI and once to decide whether the block
   got controls at all — and the second copy is the one a new kind is forgotten
   from: the widgets build, the button never appears, and nothing throws. */
const BLOCK_KINDS = [
  { matches: isHtmlRun, button: htmlFence.buttonUI, panel: htmlFence.panelUI },
  { matches: isThree, button: threeFence.buttonUI, panel: threeFence.panelUI },
  { matches: isRunnable, button: runButtonUI, panel: runPanelUI }
]

const uiFor = (lang) => BLOCK_KINDS.find((kind) => kind.matches(lang))

/* Both widgets are equal while the block's text is unchanged, so typing
   elsewhere in the note maps them rather than rebuilding them — and a running
   block's panel is not torn down mid-stream by an edit three paragraphs away.
   The widget owns its clicks, so the editor does not move the caret for them. */

/** The controls at the right of the fence's header line: the Run button when
 *  the language runs, and the copy control every block gets. */
class RunButtonWidget extends WidgetType {
  constructor (lang, code, runs) {
    super()
    this.lang = lang
    this.code = code
    this.runs = runs
  }

  eq (other) {
    return other.lang === this.lang && other.code === this.code && other.runs === this.runs
  }

  toDOM () {
    const slot = document.createElement('span')
    slot.className = 'tk-run-top'
    if (this.runs) slot.append(uiFor(this.lang).button(this.lang, this.code))
    slot.append(codeCopilotButton(this.lang, this.code))
    slot.append(copyButton(this.code))
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
  toDOM (view) {
    return uiFor(this.lang).panel(this.lang, this.code, 'tk-run', () => view.requestMeasure())
  }
  // A panel holds everything the block has printed; left registered, so does
  // the painter that was drawing into it.
  destroy (dom) { retirePainters(dom) }
  ignoreEvent () { return true }
}

function buildRunWidgets (state) {
  const widgets = []

  eachFence(state, ({ node, first, lang, code }) => {
    // One membership test, from the table above: a language no kind claims is
    // a block with nothing to run.
    const runs = Boolean(uiFor(lang))
    // Nothing to run and nothing to copy: a still-empty block keeps a clean
    // header rather than a control that would put an empty string on the
    // clipboard.
    if (!runs && !code) return

    /* The controls go at the end of the opening fence line, where the chip
       already is; the CSS lifts them out of the text flow and over to the
       right, so they cost the line no width and no height. */
    widgets.push(
      Decoration.widget({
        widget: new RunButtonWidget(lang.toLowerCase(), code, runs),
        side: 1
      }).range(first.to)
    )

    if (!runs) return
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
