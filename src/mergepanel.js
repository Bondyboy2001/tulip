/* =========================================================== merge panel
   The contested places in a note two hands have written to, one card each,
   and the choice between yours and the disk's. Changes that do not touch the
   same lines have already been folded together by merge.js — this panel is
   only for the places both sides rewrote, where one of the two has to win or
   the note cannot be written at all.
   ================================================================== */

import { el as element } from './dom.js'
import { resolveMerge } from './merge.js'
import { noteName } from './vault-paths.js'

export function mountMergePanel ({ el, apply, keep }) {
  const state = { result: null, choices: [] }

  const close = () => { el.panel.hidden = true }

  /* One card per conflict: the two candidates labelled, and the segmented
     choice between them. Defaults to yours — the buffer is what the reader was
     working in — and flips to the disk's with one click. */
  function card (conflict, i) {
    const node = element('article', 'merge-conflict')

    const head = element('div', 'merge-conflict-head')
    /* The card names its place in the merged note, not in either original: the
       line count is where the reader is going to look for it afterwards. */
    head.append(element('span', 'merge-where',
      `Around line ${conflict.s + 1} · ${conflict.ours.length === conflict.theirs.length
        ? `${conflict.ours.length} lines`
        : conflict.ours.length === 1 && conflict.theirs.length === 1
          ? 'one line'
          : `${conflict.ours.length} vs ${conflict.theirs.length} lines`}`))

    const choice = element('div', 'merge-choice')
    const mine = element('button', state.choices[i] === 'ours' ? 'is-active' : '', 'Yours')
    const theirs = element('button', state.choices[i] === 'theirs' ? 'is-active' : '', 'On disk')
    mine.type = 'button'
    theirs.type = 'button'
    const pick = (side) => {
      state.choices[i] = side
      mine.classList.toggle('is-active', side === 'ours')
      theirs.classList.toggle('is-active', side === 'theirs')
      blockMine.classList.toggle('is-picked', side === 'ours')
      blockTheirs.classList.toggle('is-picked', side === 'theirs')
    }
    mine.addEventListener('click', () => pick('ours'))
    theirs.addEventListener('click', () => pick('theirs'))
    choice.append(mine, theirs)
    head.append(choice)
    node.append(head)

    const blocks = element('div', 'merge-blocks')
    const blockMine = element('div', 'merge-block is-mine is-picked')
    const blockTheirs = element('div', 'merge-block is-theirs')
    const code = (lines) => {
      const pre = element('pre', 'merge-code')
      pre.textContent = lines.join('\n') || '(empty)'
      return pre
    }
    blockMine.append(
      element('div', 'merge-block-label', 'You wrote'),
      code(conflict.ours)
    )
    blockTheirs.append(
      element('div', 'merge-block-label', 'On disk'),
      code(conflict.theirs)
    )
    blocks.append(blockMine, blockTheirs)
    node.append(blocks)
    return node
  }

  function paint () {
    el.title.textContent = noteName(state.path)
    el.title.title = state.path || ''
    const count = state.result.conflicts.length
    el.intro.textContent = count === 1
      ? 'This note changed on disk while you were editing it. One place was rewritten by both — choose which version stands.'
      : `This note changed on disk while you were editing it. ${count} places were rewritten by both — choose which version stands in each.`
    el.list.replaceChildren(...state.result.conflicts.map((conflict, i) => card(conflict, i)))
  }

  function show (path, result) {
    state.path = path
    state.result = result
    state.choices = result.conflicts.map(() => 'ours')
    el.panel.hidden = false
    paint()
  }

  /* Saving is the only way the merged text reaches the disk: the choice is
     resolved here, into the one text both sides can live with, and handed to
     the renderer to patch and save. */
  function save () {
    if (el.panel.hidden) return
    const text = resolveMerge(state.result.lines, state.result.conflicts, state.choices)
    close()
    apply(text)
  }

  function dismiss () {
    if (el.panel.hidden) return
    close()
    keep()
  }

  el.close.addEventListener('click', dismiss)
  el.keep.addEventListener('click', dismiss)
  el.save.addEventListener('click', save)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.panel.hidden) dismiss()
  })
  return { show, close, dismiss }
}
