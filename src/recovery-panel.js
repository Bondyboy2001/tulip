import { reviewSections } from './change-review.js'
import { diffBlock, mountHistory } from './history.js'

export function mountRecoveryPanel ({ api, open, retry, notify, historyOptions = /** @type {any} */ (null), beforeMerge = async () => true, afterMerge = async (_path) => {} }) {
  const badge = document.createElement('button')
  badge.id = 'recovery-indicator'
  badge.hidden = true
  badge.type = 'button'
  badge.addEventListener('click', () => show())
  document.querySelector('#status-right')?.before(badge)
  let documentPath = null
  let items = []
  let drafts = []
  let box = /** @type {HTMLDialogElement | null} */ (null)
  let refreshing = /** @type {Promise<void> | null} */ (null)
  let refreshPending = false
  function button (label, action) {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = label
    node.addEventListener('click', async () => {
      node.disabled = true
      try { await action() } catch (error) { notify(error.message || 'This action could not be completed.') }
      finally { node.disabled = false }
    })
    return node
  }
  function confirmRestore ({ title, detail, go }) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog')
      dialog.className = 'workspace-tools'
      const heading = document.createElement('h2')
      heading.textContent = title
      const description = document.createElement('p')
      description.textContent = detail
      dialog.append(heading, description, button(go, () => dialog.close('restore')), button('Cancel', () => dialog.close()))
      dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'restore'); dialog.remove() }, { once: true })
      document.body.append(dialog)
      dialog.showModal()
    })
  }
  function paint () {
    badge.hidden = items.length + drafts.length === 0
    badge.textContent = `Recovery (${items.length + drafts.length})`
    if (!box?.open) return
    box.replaceChildren()
    const heading = document.createElement('h2')
    heading.id = 'recovery-title'
    heading.textContent = documentPath ? 'Recover this document' : 'Recovery inbox'
    box.append(heading)
    const info = document.createElement('p')
    info.textContent = 'Closing this panel keeps unresolved items. Restoring a draft creates a separate copy and preserves the original.'
    box.append(info)
    if (documentPath) {
      const path = documentPath
      const name = document.createElement('p')
      name.className = 'recovery-document-name'
      name.textContent = path
      box.append(name, button('Show recovery for all documents', () => show()))
      if (historyOptions) {
        const panel = document.createElement('section')
        panel.className = 'recovery-history'
        const title = document.createElement('h3')
        title.textContent = 'Saved versions'
        const subtitle = document.createElement('span')
        subtitle.hidden = true
        const list = document.createElement('div')
        list.textContent = 'Loading saved versions…'
        const close = document.createElement('button')
        close.hidden = true
        panel.append(title, subtitle, list, close)
        box.append(panel)
        const history = mountHistory({ ...historyOptions, confirm: confirmRestore, api, embedded: true, el: { panel, subtitle, list, close } })
        history.show(path).catch(error => { list.textContent = error.message || 'Saved versions could not be loaded.' })
      }
      const backups = document.createElement('section')
      const title = document.createElement('h3')
      title.textContent = 'Backup copies'
      const list = document.createElement('div')
      list.textContent = 'Looking for backup copies…'
      backups.append(title, list, button('Backup settings and full-vault restore…', () => api.vault.backups()))
      box.append(backups)
      api.vault.documentBackups(path).then(copies => {
        list.replaceChildren()
        if (!copies.length) list.textContent = 'No backups recorded for this vault. Use backup settings to create one or restore a backup from another location.'
        for (const copy of copies) {
          const row = document.createElement('section')
          row.className = 'health-row'
          const label = document.createElement('p')
          label.textContent = `${copy.at ? new Date(copy.at).toLocaleString() : 'Recorded backup'}${copy.error ? ' — unavailable: ' + copy.error : !copy.available ? ' — document not included' : ''}`
          row.append(label)
          if (copy.available) {
            const comparison = document.createElement('details')
            const summary = document.createElement('summary')
            summary.textContent = 'Compare with saved file'
            comparison.append(summary)
            comparison.addEventListener('toggle', async () => {
              if (!comparison.open || comparison.children.length > 1) return
              const preview = document.createElement('div')
              preview.textContent = 'Checking backup and loading comparison…'
              comparison.append(preview)
              try {
                const [before, after] = await Promise.all([api.file.read(path).catch(() => null), api.vault.backupPreview(copy.id, path)])
                preview.replaceChildren(diffBlock({ before, after }))
              } catch (error) { preview.textContent = error.message || 'This backup could not be compared.' }
            })
            row.append(comparison, button('Restore backup as separate copy', async () => {
              const restored = await api.vault.restoreDocument(copy.id, path)
              box?.close()
              await open(restored.path)
            }))
          }
          list.append(row)
        }
      }).catch(error => { list.textContent = error.message || 'Backups could not be loaded.' })
    } else {
      box.append(button('Backup settings and full-vault restore…', () => api.vault.backups()))
    }
    const unresolved = document.createElement('h3')
    unresolved.textContent = 'Drafts and conflicts'
    box.append(unresolved)
    const visible = [...drafts.map((draft) => ({ ...draft, kind: 'draft' })), ...items].filter(item => !documentPath || item.path === documentPath)
    for (const item of visible) {
      const row = document.createElement('section')
      row.className = 'health-row'
      const title = document.createElement('h3')
      title.textContent = `${item.kind === 'draft' ? 'Unsaved draft' : item.kind === 'save' ? 'Save failed' : 'Conflicting version'} · ${item.path}`
      row.append(title)
      if (!documentPath) row.append(button('Recover this document…', () => show(item.path)))
      if (item.kind === 'draft') {
        const details = document.createElement('details')
        const summary = document.createElement('summary')
        summary.textContent = 'Compare with saved file'
        details.append(summary)
        details.addEventListener('toggle', () => {
          if (details.open && details.children.length === 1) details.append(diffBlock({ before: item.disk, after: item.text }))
        })
        row.append(details, button('Restore as separate copy', async () => {
          const restored = await api.draft.restore(item.id)
          await refresh()
          box?.close()
          await open(restored.path)
        }))
        const discard = document.createElement('details')
        const label = document.createElement('summary')
        label.textContent = 'Discard draft…'
        discard.append(label, document.createTextNode('This removes the unsaved draft. The saved file is kept.'), button('Confirm discard draft', async () => {
          await api.draft.clear(item.path, item.id)
          await refresh()
        }))
        row.append(discard)
      } else {
        row.append(button('Open document', async () => { box?.close(); await open(item.path) }))
        if (item.copy) {
          const compare = document.createElement('details')
          const summary = document.createElement('summary')
          summary.textContent = 'Compare saved versions'
          compare.append(summary)
          compare.addEventListener('toggle', async () => {
            if (!compare.open || compare.children.length > 1) return
            const content = document.createElement('div')
            content.textContent = 'Loading comparison…'
            compare.append(content)
            try {
              const [before, after] = await Promise.all([api.file.read(item.copy), api.file.read(item.path)])
              content.replaceChildren(diffBlock({ before, after }))
            } catch { content.textContent = 'These files could not be compared as text. Open each version to inspect it.' }
          })
          row.append(compare, button('Open conflicting copy', async () => { box?.close(); await open(item.copy) }))
        }
        if (item.kind === 'save') row.append(button('Retry save', async () => {
          if (await retry(item.path)) await dismiss(item.id)
        }))
        row.append(button('Reveal file', () => api.file.reveal(item.copy || item.path)))
        row.append(button('Mark resolved', () => dismiss(item.id)))
      }
      if (item.kind === 'draft' || item.copy) {
        row.append(button('Merge selected changes…', async () => {
          if (!await beforeMerge()) throw new Error('Save the open document before merging.')
          const got = await api.file.readEncoded(item.path)
          if (!got?.ok || !got.clean) throw new Error('This file could not be decoded without losing text.')
          const copy = item.kind === 'draft' ? null : await api.file.readEncoded(item.copy)
          if (copy && (!copy.ok || !copy.clean)) throw new Error('The recovered copy could not be decoded without losing text.')
          const recovered = item.kind === 'draft' ? item.text : copy.text
          reviewSections({ before: got.text, after: recovered, title: `Resolve ${item.path}`,
            apply: async (text) => {
              if (!await beforeMerge()) throw new Error('Save the open document before merging.')
              const result = await api.file.write(item.path, text, { expect: got.stamp, encoding: got.encoding, bom: got.bom })
              if (!result?.ok) throw new Error(result?.error || 'The file changed. Close this preview and compare again.')
              await afterMerge(item.path)
              if (item.kind === 'draft') await api.draft.clear(item.path, item.id)
              else await dismiss(item.id)
              await refresh()
            } })
        }))
      }
      box.append(row)
    }
    if (!visible.length) box.append(document.createTextNode('No unresolved recovery items.'))
    box.append(button('Close', () => box?.close()))
  }
  function refresh () {
    refreshPending = true
    // Several windows may announce the same recovery change together. Collapse
    // that burst instead of queuing a full draft read and repaint per event.
    if (!refreshing) refreshing = (async () => {
      while (refreshPending) {
        refreshPending = false
        ;[items, drafts] = await Promise.all([api.recovery.list(), api.draft.list(true)])
      }
      paint()
    })().finally(() => { refreshing = null })
    return refreshing
  }
  async function dismiss (id) { await api.recovery.dismiss(id); await refresh() }
  async function record (kind, path, copy = null) {
    try { await api.recovery.record({ kind, path, copy }); await refresh() } catch (error) {
      notify('The recovery reminder could not be saved. Keep this document open and retry saving.')
      console.error(error)
    }
  }
  async function show (path = null) {
    documentPath = path
    await refresh()
    if (box?.open) return
    box = document.createElement('dialog')
    box.className = 'workspace-tools health-panel'
    box.id = 'recovery-panel'
    box.setAttribute('aria-labelledby', 'recovery-title')
    const opened = box
    box.addEventListener('close', () => { opened.remove(); if (box === opened) box = null })
    document.body.append(box)
    box.showModal()
    paint()
    box.querySelector('button')?.focus()
  }
  api.recovery.onChanged(() => { refresh().catch(console.error) })
  return { show, refresh, record, saved: (path) => items.some((item) => item.id === `save:${path}`) ? dismiss(`save:${path}`) : Promise.resolve() }
}
