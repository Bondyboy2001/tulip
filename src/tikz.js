/* ================================================================= tikz
   A ```tikz block is a picture, and the point of a picture is the drawing. So
   both views show the drawing where the code was, and the code is a thing you
   ask for rather than the thing you are given — the same bargain the manim
   blocks strike, for the same reason.

   The drawing is a real .svg in the vault, beside the note's other
   attachments, and which file it is comes from a hash of the code (see
   tikzTarget in electron/main.js). Same block, same filename: a note that has
   been drawn opens with its pictures already in place, and an edited block
   asks for a name nothing has written yet, which is exactly when redrawing is
   right. Nothing is written into the .md — the block stays the source and the
   picture beside it is derived from it.

   Unlike mermaid, this cannot be redrawn as you type: it is a TeX run, a
   second or two at best, and it needs TeX installed. That is what makes it a
   thing you ask for, and what makes the answer worth keeping.
   ================================================================== */

import { WidgetType } from '@codemirror/view'
import { Facet } from '@codemirror/state'
import { embedSpec, renderEmbed } from './assets.js'
import { el, pictureBlocks, renderedBlock } from './blocks.js'
import { artefactRun } from './runcode.js'

const api = window.tulip

export function isTikz (lang) {
  return String(lang || '').trim().toLowerCase() === 'tikz'
}

/* Runs in flight, keyed by note and code — the same bargain runcode's
   `results` map strikes, and for the same reason. A per-attach state looked
   fine until a widget rebuild (a note switch, a keystroke near the fence)
   detached it mid-render: the fresh widget's lookup ran before the file
   existed, so it said "Draw" while TeX worked on unseen, and the finished
   picture never appeared. A rebuilt widget adopts the run instead. Entries
   are retired once the run has settled and been shown. */
const runs = new Map()

/* The drawing for a path we have just been handed. Going through embedSpec
   keeps one decision about what an .svg in this vault becomes, shared with
   every other embed. */
function pictureFor (path, onLoad) {
  const picture = renderEmbed(embedSpec(path, { resolve: () => path }))
  if (onLoad) picture.querySelector?.('img')?.addEventListener('load', onLoad, { once: true })
  return picture
}

/**
 * One block's rendering: the state behind it, a Draw/Stop button, the picture,
 * and what went wrong when it did. Both views build their own frame around
 * this, because a code block in the reading view and a widget under a fence in
 * the editing view are different shapes — but neither should have its own idea
 * of what "drawn" means.
 *
 * @param {string} code       the picture's source
 * @param {string} noteName   which note's attachments it belongs to
 * @param {(path: string|null) => void} onPicture  a drawing arrived, or went
 * @param {() => void} [onPaint]  the status changed shape; re-measure
 */
function tikzRun (code, noteName, onPicture, onPaint) {
  /* The same control a runnable block and a manim scene get — the artefact run
     in runcode.js is all three of them. Starting a draw and stopping one is the
     run gesture, and spelling it out in words beside blocks whose own runs are
     a triangle made two different-looking things out of one. What the words
     said is in the tooltip. */
  return artefactRun(runs, `${noteName}\n${code}`, {
    statusClass: 'tikz-status',
    words: {
      busy: 'Drawing…',
      keep: 1200,
      silent: () => 'TeX did not draw anything. Is a LaTeX distribution installed?'
    },
    titles: {
      stop: 'Stop drawing',
      again: 'Draw this picture again',
      first: 'Draw this picture with TeX'
    },
    start: () => api.tikz.render(noteName, code),
    lookup: () => api.tikz.lookup(noteName, code),
    onPath: onPicture,
    onPaint
  })
}

/**
 * The reading view's form: the drawing stands where the block does, with Draw
 * beside the source when switched back.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {HTMLElement} head  the .code-head the Draw button belongs in
 */
export function attachTikz (wrap, head, code, { noteName }) {
  const view = renderedBlock(wrap, 'tikz')

  /* Until there is a drawing the block is the block, Draw button and all; once
     there is, the picture takes its place entirely. */
  const run = tikzRun(code, noteName, (path) => {
    if (path) view.stage.replaceChildren(pictureFor(path))
    view.settle(!!path)
  })

  view.figure.after(run.status)
  head.append(run.button)
}

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
