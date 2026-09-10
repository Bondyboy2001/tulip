import { fileDiff } from './linediff.js'
import { diffBlock } from './history.js'
import { el as element } from './dom.js'

// A sentinel preserves final newlines, which the display diff otherwise omits.
export function changeSections (before, after) {
  const rows = fileDiff(`${before}\n`, `${after}\n`).rows
  const sections = []
  let delta = 0
  let group = []
  const flush = () => {
    if (!group.length) return
    const removed = group.filter((r) => r.kind === 'del')
    const added = group.filter((r) => r.kind === 'add')
    const start = removed.length ? removed[0].before - 1 : added[0].after - 1 - delta
    sections.push({ start, remove: removed.length, insert: added.map((r) => r.text) })
    delta += added.length - removed.length
    group = []
  }
  for (const row of rows) {
    if (row.kind === 'add' || row.kind === 'del') group.push(row)
    else flush()
  }
  flush()
  return sections
}

export function combineSections (before, sections, selected) {
  const lines = before.split('\n')
  for (let i = sections.length - 1; i >= 0; i--) {
    if (selected.has(i)) {
      const section = sections[i]
      lines.splice(section.start, section.remove, ...section.insert)
    }
  }
  return lines.join('\n')
}

export function reviewSections ({ before, after, title = 'Choose changes to keep', apply, initial = true }) {
  const dialog = element('dialog', 'change-review workspace-tools')
  const sections = changeSections(before, after)
  const selected = new Set(initial ? sections.map((_, i) => i) : [])
  const heading = element('h2', '', title)
  const choices = element('div', 'change-review-choices')
  const preview = element('div', 'change-review-preview')
  const status = element('p', 'change-review-status')
  status.setAttribute('role', 'status')
  const repaint = () => {
    preview.replaceChildren(diffBlock({ before, after: combineSections(before, sections, selected) }))
  }
  sections.forEach((section, i) => {
    const label = element('label', 'change-review-choice')
    const check = document.createElement('input')
    check.type = 'checkbox'; check.checked = initial
    check.addEventListener('change', () => { if (check.checked) selected.add(i); else selected.delete(i); repaint() })
    label.append(check, `Keep change ${i + 1} · line ${section.start + 1}`,
      diffBlock({ before: before.split('\n').slice(section.start, section.start + section.remove).join('\n'), after: section.insert.join('\n') }))
    choices.append(label)
  })
  const all = element('button', 'ghost', 'Keep all')
  const none = element('button', 'ghost', 'Keep none')
  const choose = (value) => {
    choices.querySelectorAll('input').forEach((check, i) => { check.checked = value; if (value) selected.add(i); else selected.delete(i) })
    repaint()
  }
  all.onclick = () => choose(true); none.onclick = () => choose(false)
  const commit = element('button', 'is-accent', 'Save selected result')
  commit.onclick = async () => {
    commit.disabled = true
    try { await apply(combineSections(before, sections, selected)); dialog.close() }
    catch (error) { status.textContent = error.message || 'Could not save this result.'; commit.disabled = false }
  }
  const close = element('button', 'ghost', 'Cancel')
  close.onclick = () => dialog.close()
  dialog.append(heading, element('p', '', 'Select the changes to keep, then review the resulting difference below.'), all, none, choices,
    element('h3', '', 'Result preview'), preview, status, commit, close)
  const focus = document.activeElement
  dialog.addEventListener('close', () => { dialog.remove(); if (focus instanceof HTMLElement) focus.focus() })
  document.body.append(dialog); repaint(); dialog.showModal()
  heading.tabIndex = -1; heading.focus({ preventScroll: true }); dialog.scrollTop = 0
  return dialog
}
