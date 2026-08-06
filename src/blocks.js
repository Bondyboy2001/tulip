/* ============================================================== blocks
   What a fenced block becomes when it is not shown as code, in both views.

   Nothing here imports CodeMirror, and that is the point rather than an
   accident: the reading view reaches this module, and CodeMirror is half of
   everything the app compiles before it can draw a note. The half that does
   need it — the fence walk and the StateFields built on it — is next door in
   blocks-editor.js. Adding an editor import here puts the whole editing
   stack back on the startup path; put it there instead.

   Five modules answer that question — mermaid, svg, tikz, manim and the Run
   control — and until they shared this one they each carried their own copy of
   the same three things: how to build an element, how to walk the document's
   fences, and the StateField boilerplate that turns the walk into decorations.

   The walk is the part worth having in one place. It runs on every keystroke
   and every parse advance, once per module, so a detail wrong here is wrong
   four times over — which is what happened: three of the four refused to
   descend into a fence's interior (the densest part of the tree, and the one
   place that cannot hold another fence) and the fourth walked all of it.
   ================================================================== */

import { el, svgIcon } from './dom.js'

/**
 * The control that puts a block's source on the clipboard, for both views'
 * code headers. One face for the ask and one brief tick for the answer — the
 * copy itself is silent, so the button is the only place the page can say it
 * happened.
 *
 * The text is captured, not looked up: both callers rebuild this button
 * whenever the block's code changes, so what it holds is what is on screen.
 */
export function copyButton (text) {
  const face = () => svgIcon(
    '<rect x="5.5" y="5.5" width="7" height="7" rx="1.6"/>' +
    '<path d="M10.5 3.5h-5A1.5 1.5 0 0 0 4 5v5.5"/>',
    { className: 'run-icon', stroke: 1.5 }
  )
  const tick = () => svgIcon('<path d="m4.2 8.4 2.7 2.7 5-5.4"/>',
    { className: 'run-icon', stroke: 1.8 })

  const button = el('button', 'run-btn is-icon tk-copy')
  button.type = 'button'
  const say = (title) => {
    button.title = title
    button.setAttribute('aria-label', title)
  }
  say('Copy code')
  button.append(face())

  let undo = 0
  button.addEventListener('click', () => {
    // Electron's clipboard, via the bridge: the page's own
    // navigator.clipboard needs a permission the sandbox does not grant.
    window.tulip.copy(text)
    button.classList.add('is-copied')
    button.replaceChildren(tick())
    say('Copied')
    clearTimeout(undo)
    undo = setTimeout(() => {
      button.classList.remove('is-copied')
      button.replaceChildren(face())
      say('Copy code')
    }, 1300)
  })
  return button
}

/** Ask the renderer to open the focused Copilot prompt for one fenced block.
 * Both Reading and Editing use this button; the renderer owns the popup and
 * conversation, while the control owns only the code it was drawn for. */
export function codeCopilotButton (lang, code) {
  const button = el('button', 'run-btn is-icon code-ai-btn')
  button.type = 'button'
  button.title = 'Edit with Copilot'
  button.setAttribute('aria-label', 'Edit code block with Copilot')
  button.append(svgIcon(
    '<path d="M8 1.8c.35 2.5 1.7 3.85 4.2 4.2C9.7 6.35 8.35 7.7 8 10.2 7.65 7.7 6.3 6.35 3.8 6 6.3 5.65 7.65 4.3 8 1.8z"/>' +
    '<path d="M12.2 9.5c.18 1.3.9 2.02 2.2 2.2-1.3.18-2.02.9-2.2 2.2-.18-1.3-.9-2.02-2.2-2.2 1.3-.18 2.02-.9 2.2-2.2z"/>',
    { className: 'run-icon', stroke: 1.25 }
  ))
  button.addEventListener('click', () => {
    button.dispatchEvent(new CustomEvent('tulip:code-copilot', {
      bubbles: true,
      detail: { lang: String(lang || ''), code: String(code || ''), anchor: button }
    }))
  })
  return button
}

/* What the parser calls the three ways a document can hold code: a span between
   backticks, a fenced block, and a block indented four spaces. */
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock'])

/**
 * Is `pos` inside code?
 *
 * The one answer, because the modules that scan the document's text for things
 * to typeset each need it and each used to answer it themselves: a `$` in code
 * is a shell variable or a string literal in every one of them. They had drifted
 * — the money scanner tested one level of parent and never learned about
 * indented blocks, so a price inside one got a badge the maths beside it did
 * not, and the editing and reading views disagreed about the same character.
 */
export function inCode (tree, pos) {
  for (let n = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (CODE_NODES.has(n.name)) return true
  }
  return false
}

/* ------------------------------------------------------- reading view */

/**
 * The reading-view shell shared by rendered fences.
 *
 * It owns the figure and its optional stage, the failed-render fallback, and
 * the state where a live log temporarily replaces both source and result.
 * Reaching the source is the document-level Editing view's job; a rendered
 * figure carries no control of its own.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {string} kind       figure class; the stage is `${kind}-stage`
 * @param {{stage?: boolean}} [options]
 * @returns {{figure: HTMLElement, stage: HTMLElement|null,
 *            settle: (available: boolean, options?: {showFailure?: boolean}) => void,
 *            hide: () => void}}
 */
export function renderedBlock (wrap, kind, { stage: hasStage = true } = {}) {
  const figure = el('figure', kind)
  const stage = hasStage ? el('div', `${kind}-stage`) : null
  if (stage) figure.append(stage)
  wrap.after(figure)

  let available = false
  let showFailure = false
  let hidden = false

  const paint = () => {
    if (hidden) {
      wrap.hidden = true
      figure.hidden = true
      return
    }
    wrap.hidden = available
    figure.hidden = !available && !showFailure
  }

  paint()
  return {
    figure,
    stage,
    settle (yes, { showFailure: failure = false } = {}) {
      hidden = false
      available = Boolean(yes)
      showFailure = !available && failure
      paint()
    },
    // A live render transcript occupies the block's place: neither source nor
    // the previous artifact should sit underneath it.
    hide () {
      if (hidden) return
      hidden = true
      paint()
    }
  }
}

/**
 * The reading view's shape for a block that is really a picture. It adds the
 * parse-error behavior that immediate drawings need to renderedBlock's normal
 * source/result lifecycle.
 *
 * The caller draws into `stage` and then reports whether it got a picture. A
 * block that did not is left showing its source with the complaint under it —
 * there is nothing else to look at, and the source is where you would go next.
 *
 * @param {HTMLElement} wrap   the .code-wrap holding the source
 * @param {string} kind        the figure's class; its stage is `${kind}-stage`
 * @returns {{stage: HTMLElement, settle: (drew: boolean) => void}}
 */
export function pictureBlock (wrap, kind) {
  const block = renderedBlock(wrap, kind)

  return {
    stage: block.stage,
    settle (ok) {
      // A parse failure sits under the still-visible source; unlike a missing
      // cached artifact, it has a useful diagnostic to show.
      block.settle(ok, { showFailure: !ok })
    }
  }
}
