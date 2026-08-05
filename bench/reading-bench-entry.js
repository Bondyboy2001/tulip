/* Every stage the reading view runs when a note is opened, timed separately,
   inside a real Chromium document.

   `renderReading` in src/renderer.js is one function that cannot be imported
   on its own — it closes over the editor, the vault bridge and the app's
   state. What it does, though, is a fixed sequence of stages, and each of them
   is a module-level function this file can call directly on the same markup:
   markdown-it renders the note, the HTML is parsed into a detached tree, the
   tables are wrapped, heading folds are installed, image cells are measured
   and the fenced blocks are dressed. Timing them apart is what says which of
   them is worth changing. */

import { createMarkdown } from '../src/markdown.js'
import { prepareMath, equationIndex } from '../src/math.js'
import { installHeadingFolds } from '../src/headings.js'
import { markImageCells } from '../src/assets.js'
import { languageChip } from '../src/languages.js'
import { codeCopilotButton, copyButton } from '../src/blocks.js'
import { el as node } from '../src/dom.js'

const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]

function time (work, runs = 9) {
  for (let i = 0; i < 2; i++) work()
  const values = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    work()
    values.push(performance.now() - started)
  }
  return median(values)
}

/**
 * A stage's own cost.
 *
 * Every stage but the first two has to start from a page that has not been
 * mutated yet — `installHeadingFolds` cannot be run twice over the same nodes —
 * so each timed closure re-parses the HTML first. That parse is not the stage's,
 * and reading the raw figure as though it were made the cheap passes look four
 * times their size. The parse is measured once as `baseline` and taken off, so
 * `ms` is the stage and nothing else.
 */
function stage (label, baseline, work, runs = 9) {
  return { label, ms: Number(Math.max(0, time(work, runs) - baseline).toFixed(2)) }
}

/* The header half of `dressCodeBlocks` (src/renderer.js): the chip, the two
   icon buttons and the tools group.

   Hand-copied, because the real one closes over the app's state and is not
   exported. Two things it does are deliberately left out — the colouring, which
   is already deferred to an IntersectionObserver, and `BLOCK_KINDS…attach`,
   which dispatches to the Run control and the drawing modules. Both are fair to
   exclude from "what opening a note costs", but note the consequence: this
   under-counts a real page by whatever `attach` does synchronously, and it will
   drift if the header's markup changes here and not there. Keep the two in step
   by hand, or export the real function if this ever needs to be exact. */
function dressCodeHeaders (root) {
  for (const wrap of root.querySelectorAll('.code-wrap')) {
    const lang = wrap.dataset.lang || ''
    const code = wrap.querySelector('code')
    if (!code) continue
    const source = code.textContent
    const tools = node('span', 'code-tools')
    if (lang) {
      const head = node('div', 'code-head')
      const chip = languageChip(lang)
      if (chip) head.append(chip)
      if (wrap.dataset.info) head.append(node('span', 'code-info', wrap.dataset.info))
      head.append(tools)
      wrap.prepend(head)
    } else {
      tools.classList.add('is-floating')
      wrap.prepend(tools)
    }
    tools.append(codeCopilotButton(lang, source), copyButton(source))
  }
}

export async function run (body) {
  const md = createMarkdown({ resolveEmbedSrc: (source) => source })
  await prepareMath(body)
  const equations = equationIndex(body)

  // Warm every cache the app would have warmed by the time a note opens.
  md.render(body, { equations })
  const html = md.render(body, { equations })

  const holder = document.createElement('div')
  holder.className = 'reading-body'

  // Measured first, and subtracted from every stage that has to re-parse the
  // page before it can run.
  const parse = time(() => { holder.innerHTML = html })

  const stages = [
    { label: 'md.render', ms: Number(time(() => md.render(body, { equations })).toFixed(2)) },
    { label: 'innerHTML parse', ms: Number(parse.toFixed(2)) }
  ]

  stages.push(stage('installHeadingFolds', parse, () => {
    holder.innerHTML = html
    installHeadingFolds(holder)
  }))
  stages.push(stage('wrap tables', parse, () => {
    holder.innerHTML = html
    for (const table of holder.querySelectorAll('table')) {
      const wrap = document.createElement('div')
      wrap.className = 'table-wrap'
      table.replaceWith(wrap)
      wrap.append(table)
    }
  }))
  stages.push(stage('markImageCells', parse, () => {
    holder.innerHTML = html
    markImageCells(holder)
  }))
  stages.push(stage('dressCodeHeaders', parse, () => {
    holder.innerHTML = html
    dressCodeHeaders(holder)
  }))

  // The whole sequence, as one open costs it — one parse shared, nothing
  // subtracted. This is the figure to compare across runs.
  stages.push(stage('WHOLE OPEN', 0, () => {
    holder.innerHTML = md.render(body, { equations })
    installHeadingFolds(holder)
    for (const table of holder.querySelectorAll('table')) {
      const wrap = document.createElement('div')
      wrap.className = 'table-wrap'
      table.replaceWith(wrap)
      wrap.append(table)
    }
    markImageCells(holder)
    dressCodeHeaders(holder)
  }, 7))

  holder.innerHTML = html
  return {
    htmlBytes: html.length,
    topLevelBlocks: holder.childElementCount,
    fences: holder.querySelectorAll('.code-wrap').length,
    tables: holder.querySelectorAll('table').length,
    cells: holder.querySelectorAll('td, th').length,
    headings: holder.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    stages
  }
}

window.__tulipReadingBench = run
