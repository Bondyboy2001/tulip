/* =========================================================== merge panel
   The contested places in a note two hands have written to, one card each,
   and the choice between yours and the disk's. Changes that do not touch the
   same lines have already been folded together by merge.js — this panel is
   only for the places both sides rewrote, where one of the two has to win or
   the note cannot be written at all.
   ================================================================== */

import { el as element } from './dom.js'
import { fileDiff } from './linediff.js'
import { resolveMerge } from './merge.js'
import { noteName } from './vault-paths.js'

/* The most lines either side of a card will print. A conflict where the two
   texts really are unrelated has no small honest summary; what it must not do
   is print two whole notes into a panel the reader has to scroll past to reach
   the buttons. */
const MAX_LINES = 80

/* An upper bound on how many lines the two sides disagree about, by multiset:
   every line of `b` that `a` has a spare copy of could match. Costs one pass,
   and is what decides whether the exact pairing below is affordable.

   Myers is O((N+M)·D) in the *differences*, not the size, so two 9,000-line
   texts that differ in three lines pair in no time — while two that share
   nothing would allocate a trace per edit and take the window with it. The
   estimate separates those two cases before either is attempted. */
function differingLines (a, b) {
  const have = new Map()
  for (const line of a) have.set(line, (have.get(line) || 0) + 1)
  let common = 0
  for (const line of b) {
    const left = have.get(line) || 0
    if (!left) continue
    have.set(line, left - 1)
    common++
  }
  return (a.length - common) + (b.length - common)
}

/* How different two sides may be and still be worth pairing line by line, and
   the budget that pairing is then allowed. The pair is chosen together: at 200
   differing lines Myers walks a few hundred traces, which is milliseconds and a
   few megabytes whatever the notes' length. */
const PAIR_LIMIT = 200
const PAIR_BUDGET = 400_000

/** The two candidates paired, trimmed to what actually differs. */
function conflictDiff (ours, theirs) {
  const budget = differingLines(ours, theirs) <= PAIR_LIMIT ? PAIR_BUDGET : undefined
  return fileDiff(ours.join('\n'), theirs.join('\n'), budget ? { budget } : {})
}

/** How the two candidates differ, in the units the reader is choosing between. */
function changedCount (diff) {
  if (!diff.rows.length) return 'identical'
  if (diff.removed === diff.added) {
    return diff.added === 1 ? 'one line differs' : `${diff.added} lines differ`
  }
  return `${diff.removed} vs ${diff.added} lines`
}

/* Two candidates for the same place are mostly the same text — and where the
   conflict is the whole note (too large to pair line by line) they are the same
   note twice, with a line or two moved. Printing both in full buries the choice
   the panel exists to ask, so each side is drawn from the diff between them:
   its own changed lines, a little context, and a marker where agreement was
   skipped. `keep` is the row kind that belongs to this side — 'del' is what the
   left had, 'add' what the right has.

   Adjacent gaps are joined: a hunk that only exists on the other side is
   dropped here, and the two skips either side of it are one skip to a reader. */
function code (rows, keep) {
  const pre = element('pre', 'merge-code')
  if (!rows.length) {
    pre.append(element('div', 'merge-gap', 'No difference'))
    return pre
  }

  const shown = []
  for (const row of rows) {
    if (row.kind !== keep && row.kind !== 'same' && row.kind !== 'gap') continue
    const last = shown[shown.length - 1]
    if (row.kind === 'gap' && last?.kind === 'gap') {
      last.hidden += row.hidden
      continue
    }
    shown.push(row.kind === 'gap' ? { ...row } : row)
  }

  if (shown.length > MAX_LINES) {
    const rest = shown.length - MAX_LINES
    shown.length = MAX_LINES
    shown.push({ kind: 'gap', hidden: rest, tail: true })
  }

  for (const row of shown) {
    if (row.kind === 'gap') {
      if (row.tail) {
        pre.append(element('div', 'merge-gap', `⋯ ${row.hidden} more lines`))
        continue
      }
      pre.append(element('div', 'merge-gap',
        `⋯ ${row.hidden} unchanged line${row.hidden === 1 ? '' : 's'}`))
      continue
    }
    const line = element('div', `merge-line${row.kind === 'same' ? '' : ' is-changed'}`)
    line.textContent = row.text || ' '
    pre.append(line)
  }
  if (!shown.length) pre.append(element('div', 'merge-line', '(empty)'))
  return pre
}

export function mountMergePanel ({ el, apply, keep }) {
  /** @type {{path?: string, result: {lines: string[], conflicts: object[]}|null, choices: string[]}} */
  const state = { result: null, choices: [] }

  const close = () => { el.panel.hidden = true }

  /* One card per conflict: the two candidates labelled, and the segmented
     choice between them. Defaults to yours — the buffer is what the reader was
     working in — and flips to the disk's with one click. */
  function card (conflict, i) {
    const node = element('article', 'merge-conflict')
    const diff = conflictDiff(conflict.ours, conflict.theirs)

    const head = element('div', 'merge-conflict-head')
    /* The card names its place in the merged note, not in either original: the
       line count is where the reader is going to look for it afterwards. And
       it counts what actually differs, not how much text the conflict spans —
       a conflict over a whole 9,000-line note is still a handful of lines the
       two sides disagree about, and that is the number worth reading. */
    head.append(element('span', 'merge-where',
      `Around line ${conflict.s + 1} · ${changedCount(diff)}`))

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
    blockMine.append(
      element('div', 'merge-block-label', 'You wrote'),
      code(diff.rows, 'del')
    )
    blockTheirs.append(
      element('div', 'merge-block-label', 'On disk'),
      code(diff.rows, 'add')
    )
    blocks.append(blockMine, blockTheirs)
    node.append(blocks)
    return node
  }

  /** @param {{lines: string[], conflicts: object[]}} result */
  function paint (result) {
    el.title.textContent = noteName(state.path)
    el.title.title = state.path || ''
    const count = result.conflicts.length
    el.intro.textContent = count === 1
      ? 'This note changed on disk while you were editing it. One place was rewritten by both — choose which version stands.'
      : `This note changed on disk while you were editing it. ${count} places were rewritten by both — choose which version stands in each.`
    el.list.replaceChildren(...result.conflicts.map((conflict, i) => card(conflict, i)))
  }

  function show (path, result) {
    state.path = path
    state.result = result
    state.choices = result.conflicts.map(() => 'ours')
    el.panel.hidden = false
    paint(result)
  }

  /* Saving is the only way the merged text reaches the disk: the choice is
     resolved here, into the one text both sides can live with, and handed to
     the renderer to patch and save. */
  function save () {
    if (el.panel.hidden || !state.result) return
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
