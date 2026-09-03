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

import { el as element } from './dom.js'
import { fileDiff, withinLines } from './linediff.js'
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
  const shown = rows.slice(0, DIFF_ROWS)
  const inner = withinLines(shown)
  shown.forEach((row, at) => {
    if (row.kind === 'gap') {
      body.append(element('div', 'history-diff-gap', `${count(row.hidden)} unchanged lines`))
      return
    }
    const line = element('div', `history-diff-line is-${row.kind}`)
    const text = element('span', 'history-diff-text')
    const moved = inner.get(at)
    /* The changed words, where the line was edited rather than replaced.
       Everything else is one text node: a span per word on a note-sized diff
       is thousands of elements to say nothing. */
    if (moved) {
      for (const piece of moved) {
        if (!piece.changed) { text.append(piece.text); continue }
        text.append(element('span', `history-diff-word is-${row.kind}`, piece.text))
      }
    } else text.textContent = row.text

    line.append(
      element('span', 'history-diff-no', String(row.after ?? row.before ?? '')),
      element('span', 'history-diff-mark', row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '),
      text
    )
    body.append(line)
  })
  if (rows.length > DIFF_ROWS) {
    body.append(element('div', 'history-diff-gap', `${count(rows.length - DIFF_ROWS)} more lines`))
  }
  node.append(body)
  return node
}

/* What each entry says it came from. `replace` and `rename` are the two that
   edit notes the user never opened, so they say so rather than reading as a
   copilot turn. Anything unrecognised is a copilot turn, which is what every
   entry that names no source has always been. */
const TAGS = {
  restore: 'restore point',
  save: 'saved',
  replace: 'replaced',
  rename: 'renamed'
}

export function mountHistory ({
  el, api, confirm, beforeRestore, restoreStarted, restoreFailed, afterRestore, onError
}) {
  /** @type {{ path: string | null,
   *           operations: { id: string, at: number, source: string,
   *                         changes: { path: string, added?: number, removed?: number }[] }[] }} */
  const state = { path: null, operations: [] }

  async function restore (operation, path) {
    const rejecting = operation.source === 'copilot' && path == null
    const ok = await confirm({
      title: rejecting ? 'Reject this Copilot turn?' : 'Restore this version?',
      detail: rejecting
        ? 'All files changed by this turn will be put back. If any changed afterwards, Tulip will leave everything untouched.'
        : 'The note as it stands now is kept as a new entry first, so this can be undone.',
      go: rejecting ? 'Reject' : 'Restore'
    })
    if (!ok) return
    await restoreStarted?.(operation, path)
    try {
      await beforeRestore?.()
      await api.trust.restore(operation.id, path)
    } catch (err) {
      await restoreFailed?.(operation, path)
      throw err
    }
    await afterRestore?.(operation, path)
    await load()
  }

  function row (operation, expanded = false) {
    const summary = operation.changes.find((change) => change.path === state.path)
    const at = operation.at
    const node = element('article', 'history-row')

    const head = element('div', 'history-row-head')
    /* What the row says about itself is also the control that opens it: a
       button, so the diff is one Tab and one Enter away rather than a double
       click a keyboard cannot make, and unstyled, so the row still reads as a
       line of text rather than growing a second Restore. */
    const open = element('button', 'history-open')
    open.type = 'button'
    open.setAttribute('aria-expanded', 'false')
    const time = element('time', 'history-when', when(at))
    time.dateTime = new Date(at).toISOString()
    time.title = new Date(at).toLocaleString()
    open.append(time)
    /* Lines gained or lost, which is the one number that says how big a step
       back this is before you take it. */
    const delta = (summary?.added || 0) - (summary?.removed || 0)
    if (delta) {
      open.append(element(
        'span',
        `history-delta is-${delta > 0 ? 'add' : 'del'}`,
        `${delta > 0 ? '+' : '−'}${count(Math.abs(delta))}`
      ))
    }
    open.append(element('span', 'history-tag', TAGS[operation.source] || 'copilot'))
    head.append(open)

    const actions = element('div', 'history-actions')

    /* The before and after text is not in the list payload — a hundred entries
       would carry the note a hundred times over — so a diff is fetched the
       first time it is asked for, and kept once it has been. Shutting a row and
       opening it again is a gesture people repeat, and each round trip is the
       whole note twice over the wire and a fresh diff of it. */
    /** @type {HTMLElement | null} */
    let diff = null
    async function show () {
      if (diff) {
        node.classList.toggle('is-open')
        diff.hidden = !node.classList.contains('is-open')
        return
      }
      const detail = await api.trust.operation(operation.id)
      const change = detail?.changes.find((one) => one.path === state.path)
      if (!change) return
      diff = diffBlock(change)
      node.classList.add('is-open')
      node.append(diff)
    }

    function toggle () {
      return show().finally(() => {
        open.setAttribute('aria-expanded', String(node.classList.contains('is-open')))
      })
    }

    /* Clicking what the row says shows what changed in it. There was a Changes
       button on every row before this, and a column of the same word repeated
       down the panel is a column of noise: the rows are already the list of
       changes, so a button on each one to say "changes" was labelling the thing
       it was standing in. The row's own summary is the control instead — no
       extra word, and still a button, which is what keeps the diff reachable
       from the keyboard. */
    open.addEventListener('click', () => { toggle().catch(() => {}) })

    /* And double-clicking anywhere else in the head does the same, because that
       is the gesture the tree already answers to for renaming and a file
       manager answers to everywhere. Nothing stops it selecting a word
       underneath, because nothing in the head is selectable —
       `.history-row-head` says so in the stylesheet, which is where that
       belongs. */
    head.addEventListener('dblclick', (event) => {
      /* Not the summary button, which has already toggled twice on the way to
         being double-clicked, and not Restore, which has its own answer to
         being clicked and must not be given a second one. */
      if (event.target.closest('.history-open, .history-actions')) return
      toggle().catch(() => {})
    })

    if (expanded) toggle().catch(() => {})
    const back = element('button', 'ghost is-compact is-accent', 'Restore')
    back.type = 'button'
    back.addEventListener('click', () => {
      restore(operation, state.path).catch((err) => {
        onError?.(err?.message || 'That version could not be restored.')
      })
    })
    actions.append(back)

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
       a hand-rolled copy of the pattern once drifted and titled a note one way
       here and another everywhere else. */
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
