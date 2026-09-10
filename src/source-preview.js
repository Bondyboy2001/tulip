import { el as element } from './dom.js'
import { headings, findHeading, findBlock } from './headings.js'

export function sourcePassage (text, { anchor = '', line = 1 } = {}) {
  const lines = text.split('\n')
  const target = anchor.startsWith('^') ? findBlock(text, anchor) : findHeading(headings(text), anchor)
  if (anchor && !target) throw new Error('That heading or block no longer exists.')
  const from = target?.line || Math.max(1, Number(line) || 1)
  const next = target && !anchor.startsWith('^') ? headings(text).find((h) => h.line > from && h.level <= target.level)?.line : null
  const end = target?.toLine || (next ? next - 1 : Math.min(lines.length, from + 24))
  const passage = lines.slice(from - 1, end).join('\n')
  return { text: passage.slice(0, 6000), line: from, truncated: passage.length > 6000 || end < lines.length }
}

export function showSourcePreview ({ title, text, truncated = false, open }) {
  const dialog = element('dialog', 'workspace-tools source-preview')
  const body = element('pre', 'source-preview-text', text || 'No extractable text at this location.')
  const go = element('button', 'is-accent', 'Open source')
  go.onclick = async () => {
    go.disabled = true
    try { await open(); dialog.close() }
    catch (error) { body.textContent = error.message; go.disabled = false }
  }
  const close = element('button', 'ghost', 'Close')
  close.onclick = () => dialog.close()
  const focus = document.activeElement
  dialog.addEventListener('close', () => { dialog.remove(); if (focus instanceof HTMLElement) focus.focus() })
  dialog.append(element('h2', '', title), body)
  if (truncated) dialog.append(element('p', '', 'Excerpt shown. Open the source for surrounding text.'))
  dialog.append(go, close); document.body.append(dialog); dialog.showModal(); go.focus()
}
