/**
 * Note history.
 *
 * Every way a note's text is replaced, kept where it can be put back: the copy
 * an autosave leaves of what it overwrote, the copilot's rewrite of a note,
 * and the snapshot a restore leaves so it can be undone. This panel lists
 * them for the note on screen and puts the file back the way it was.
 *
 * Saves are coalesced into one entry per typing burst by the store, so the
 * list reads as the note's chapters rather than its every pause.
 */

import { el as element } from './blocks.js'
import { fileDiff } from './linediff.js'
import { when } from './time.js'
import { noteName } from './vault-paths.js'

const count = (n) => Number(n || 0).toLocaleString()

const DIFF_ROWS = 400

/* A note that only exists on one side of the step — created, or deleted — is
   that side shown whole, every line marked the one way it changed. Built
   directly rather than by diffing against an empty string, which would pair
   the phantom empty line an empty file splits to against the first real one. */
function wholeFile (text, kind) {
  const lines = String(text ?? '').split('\n')
  // The trailing newline a note ends with is not an extra blank line added.
  if (lines.at(-1) === '') lines.pop()
  const rows = lines.map((line, i) => ({
    kind,
    text: line,
    before: kind === 'del' ? i + 1 : null,
    after: kind === 'add' ? i + 1 : null
  }))
  return {
    rows,
    added: kind === 'add' ? rows.length : 0,
    removed: kind === 'del' ? rows.length : 0,
    truncated: false
  }
}

/* The diff, in the shape every other diff is read in: a removed line above the
   line that took its place, a couple of unchanged lines for bearings, and a
   line number down the side so a change can be found in the note itself. */
export function diffBlock (change) {
  const node = element('div', 'history-diff')

  /* A created note is all additions and a deleted one all removals — shown as
     exactly that rather than as a sentence saying so, because the text the
     step brought in, or took away, is what the diff was opened to read. */
  const created = change.before == null
  const deleted = change.after == null
  const { rows, added, removed, truncated } = created || deleted
    ? wholeFile(created ? change.after : change.before, created ? 'add' : 'del')
    : fileDiff(change.before, change.after)
  if (!rows.length) {
    node.append(element('p', 'history-diff-empty', created
      ? 'The note was created empty in this step.'
      : deleted
        ? 'The note was already empty when it was deleted.'
        : 'No textual difference.'))
    return node
  }

  const head = element('div', 'history-diff-head')
  const tally = element('span', 'history-tally')
  // A side with nothing on it stays out of the tally: a created note is
  // `+40`, not `+40 −0`.
  if (added || !removed) tally.append(element('span', 'is-add', `+${count(added)}`))
  if (removed) tally.append(element('span', 'is-del', `−${count(removed)}`))
  head.append(tally)
  if (truncated) head.append(element('span', 'history-diff-note', 'rewritten in full'))
  node.append(head)

  const body = element('div', 'history-diff-body')
  for (const row of rows.slice(0, DIFF_ROWS)) {
    if (row.kind === 'gap') {
      body.append(element('div', 'history-diff-gap', `${count(row.hidden)} unchanged lines`))
      continue
    }
    const line = element('div', `history-diff-line is-${row.kind}`)
    line.append(
      element('span', 'history-diff-no', String(row.after ?? row.before ?? '')),
      element('span', 'history-diff-mark', row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '),
      element('span', 'history-diff-text', row.text)
    )
    body.append(line)
  }
  if (rows.length > DIFF_ROWS) {
    body.append(element('div', 'history-diff-gap', `${count(rows.length - DIFF_ROWS)} more lines`))
  }
  node.append(body)
  return node
}

export function mountHistory ({ el, api, confirm, beforeRestore }) {
  const state = { path: null, operations: [] }

  async function restore (operation, path) {
    const ok = await confirm({
      title: 'Restore this version?',
      detail: 'The note as it stands now is kept as a new entry first, so this can be undone.',
      go: 'Restore'
    })
    if (!ok) return
    await beforeRestore?.()
    await api.trust.restore(operation.id, path)
    await load()
  }

  function row (operation, expanded = false) {
    const summary = operation.changes.find((change) => change.path === state.path)
    const at = operation.at
    const node = element('article', 'history-row')

    const head = element('div', 'history-row-head')
    const time = element('time', 'history-when', when(at))
    time.dateTime = new Date(at).toISOString()
    time.title = new Date(at).toLocaleString()
    head.append(time)
    /* Lines gained or lost, which is the one number that says how big a step
       back this is before you take it. */
    const delta = (summary?.added || 0) - (summary?.removed || 0)
    if (delta) {
      head.append(element(
        'span',
        `history-delta is-${delta > 0 ? 'add' : 'del'}`,
        `${delta > 0 ? '+' : '−'}${count(Math.abs(delta))}`
      ))
    }
    if (operation.source === 'restore') head.append(element('span', 'history-tag', 'restore point'))
    else if (operation.source === 'save') head.append(element('span', 'history-tag', 'saved'))
    else head.append(element('span', 'history-tag', 'copilot'))

    const actions = element('div', 'history-actions')
    const view = element('button', 'ghost is-compact', 'Changes')
    view.type = 'button'
    /* The before and after text is not in the list payload — a hundred entries
       would carry the note a hundred times over — so a diff is fetched the
       first time it is asked for. */
    async function toggle () {
      const open = node.querySelector('.history-diff')
      if (open) {
        open.remove()
        node.classList.remove('is-open')
        view.textContent = 'Changes'
        return
      }
      const detail = await api.trust.operation(operation.id)
      const change = detail?.changes.find((one) => one.path === state.path)
      if (!change) return
      view.textContent = 'Hide'
      node.classList.add('is-open')
      node.append(diffBlock(change))
    }
    view.addEventListener('click', () => { toggle().catch(() => {}) })
    if (expanded) toggle().catch(() => {})
    const back = element('button', 'ghost is-compact is-accent', 'Restore')
    back.type = 'button'
    back.addEventListener('click', () => restore(operation, state.path))
    actions.append(view, back)

    head.append(actions)
    node.append(head)
    return node
  }

  /* The empty state earns its space: a drawing of what the panel will hold —
     kept copies of this page, stacked behind it — and a line saying when one
     will appear. An empty screen is an invitation, not an apology. */
  function emptyState () {
    const node = element('div', 'history-none')
    const glyph = element('div', 'history-none-glyph')
    glyph.innerHTML = `<svg viewBox="0 0 48 54" width="48" height="54" aria-hidden="true">
      <rect x="14" y="2"  width="30" height="40" rx="2.5" class="page is-far"/>
      <rect x="9"  y="6"  width="30" height="40" rx="2.5" class="page is-mid"/>
      <rect x="4"  y="10" width="30" height="40" rx="2.5" class="page is-near"/>
      <path d="M10 19h14M10 31h11M10 37h16" class="text"/>
      <path d="M10 25h18" class="changed"/>
    </svg>`
    node.append(
      glyph,
      element('p', 'history-none-title', 'No versions kept yet'),
      element('p', 'history-none-sub',
        'Each save keeps the note as it stood a moment before — so an edit, or a copilot rewrite, can be put back from here.')
    )
    return node
  }

  function paint () {
    const rows = state.operations.filter((operation) =>
      operation.changes.some((change) => change.path === state.path)
    )
    /* Through the shared matcher, so this reads the same name the tree does —
       its own copy of the pattern was missing the `.language` part, and left a
       language table titled "Spanish.language" here and "Spanish" everywhere
       else. */
    el.subtitle.textContent = noteName(state.path)
    el.subtitle.title = state.path || ''
    /* The newest snapshot opens on its own: it is the one a reader who just
       watched the copilot edit a note came here to look at. */
    el.list.replaceChildren(...(rows.length
      ? rows.map((operation, i) => row(operation, i === 0))
      : [emptyState()]))
  }

  async function load () {
    state.operations = await api.trust.list() || []
    paint()
  }

  function close () {
    el.panel.hidden = true
  }

  async function show (path) {
    state.path = path
    el.panel.hidden = false
    await load()
  }

  el.close.addEventListener('click', close)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.panel.hidden) close()
  })
  return { show, close, restore }
}
