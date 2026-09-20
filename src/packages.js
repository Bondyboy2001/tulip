/* One package panel for every managed language, with no metadata in notes. */
export const LANGUAGE_LABELS = { python: 'Python', rust: 'Rust', node: 'JavaScript / TypeScript', go: 'Go', julia: 'Julia' }
const api = () => /** @type {any} */ (window).tulip
function node (tag, text = '', className = '') {
  const element = document.createElement(tag)
  element.textContent = text
  element.className = className
  return element
}
/**
 * @param {string | null} [note]       the note whose environment to manage
 * @param {string} [language]          the tab the picker opens on
 * @param {(() => void) | null} [onClose]  called once the dialog has closed
 */
export async function openPackages (note = null, language = 'python', onClose = null) {
  const dialog = node('dialog', '', 'packages-dialog')
  dialog.setAttribute('aria-label', 'Packages')
  const head = node('div', '', 'packages-head')
  const close = node('button', '×', 'packages-close')
  close.setAttribute('aria-label', 'Close packages')
  close.addEventListener('click', () => dialog.close())
  head.append(node('h2', 'Packages'), close)
  const subtitle = node('p', note ? note.split('/').at(-1)?.replace(/\.md$/, '') : 'Scratch code', 'packages-note')
  subtitle.title = note || 'Scratch code'
  const languageSelect = document.createElement('select')
  languageSelect.setAttribute('aria-label', 'Package language')
  for (const [value, label] of Object.entries(LANGUAGE_LABELS)) {
    const option = document.createElement('option')
    option.value = value; option.textContent = label
    languageSelect.append(option)
  }
  languageSelect.value = LANGUAGE_LABELS[language] ? language : 'python'
  const toolbar = node('div', '', 'packages-toolbar')
  const addToggle = node('button', '+ Add package', 'ghost')
  addToggle.setAttribute('aria-expanded', 'false')
  toolbar.append(languageSelect, addToggle)
  const list = node('div', '', 'packages-list')
  const status = node('p', '', 'packages-status')
  status.setAttribute('role', 'status')
  const addRow = node('form', '', 'packages-add')
  const name = document.createElement('input')
  name.className = 'field'; name.placeholder = 'Package name'; name.setAttribute('aria-label', 'Package name')
  const imported = document.createElement('input')
  imported.className = 'field'; imported.placeholder = 'Import name (if different)'; imported.setAttribute('aria-label', 'Import name (if different)')
  const add = node('button', 'Add', 'ghost'); add.type = 'submit'
  const addFields = node('div', '', 'packages-add-fields')
  addFields.append(name, add)
  const mapping = node('details', '', 'packages-mapping')
  mapping.append(node('summary', 'Different import name'), imported)
  addRow.append(addFields, mapping)
  addRow.hidden = true
  addToggle.addEventListener('click', () => {
    addRow.hidden = !addRow.hidden
    addToggle.setAttribute('aria-expanded', String(!addRow.hidden))
    if (!addRow.hidden) name.focus()
  })
  const actions = node('div', '', 'packages-actions')
  const exportButton = node('button', 'Export environment', 'ghost')
  const importButton = node('button', 'Import environment…', 'ghost')
  const importFile = document.createElement('input')
  importFile.type = 'file'
  importFile.accept = '.json,application/json'
  importFile.hidden = true
  const reset = node('button', 'Reset environment', 'ghost is-danger')
  actions.append(exportButton, importButton, importFile, reset)
  let busy = false
  function setBusy (value) {
    busy = value
    dialog.querySelectorAll('button, input, select').forEach((el) => { if (el !== close) /** @type {HTMLButtonElement} */ (el).disabled = value })
  }
  async function change (action, pkg, mapping, payload) {
    if (busy) return
    setBusy(true); status.textContent = action === 'list' ? 'Reading packages…' : 'Working…'
    try {
      const record = await api().packages.manage(note, languageSelect.value, action, pkg, mapping, payload)
      if (action === 'export') {
        const blob = new Blob([JSON.stringify(record, null, 2) + '\n'], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url; link.download = `tulip-${languageSelect.value}-environment.json`; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 30000)
        status.textContent = 'Environment exported.'
      } else {
        list.replaceChildren()
        const entries = Object.entries(record.packages || {})
        if (!entries.length) list.append(node('p', 'No packages installed. Imports install automatically.', 'settings-hint'))
        for (const [pkgName, version] of entries) {
          const row = node('div', '', 'packages-row')
          row.append(node('span', pkgName, 'packages-name'), node('span', String(version), 'packages-version'))
          const menu = node('details', '', 'packages-menu')
          const trigger = node('summary', '···')
          trigger.setAttribute('aria-label', `Actions for ${pkgName}`)
          const choices = node('div', '', 'packages-menu-items')
          menu.append(trigger, choices)
          /* The dialog's scroll box clips a menu that crosses its bottom
             edge, so near the bottom the menu opens on the roomier side. */
          menu.addEventListener('toggle', () => {
            if (!menu.open) return
            const box = dialog.getBoundingClientRect()
            const anchor = menu.getBoundingClientRect()
            const below = box.bottom - anchor.bottom
            const above = anchor.top - box.top
            choices.classList.toggle('is-up', choices.getBoundingClientRect().height > below && above > below)
          })
          for (const [op, label] of [['update', 'Update'], ['remove', 'Remove']]) {
            const button = node('button', label, 'ghost is-compact')
            button.addEventListener('click', () => { menu.open = false; change(op, pkgName) })
            choices.append(button)
          }
          row.append(menu)
          list.append(row)
        }
        status.textContent = action === 'import' ? 'Environment imported.' : ''
        if (action === 'add') { name.value = ''; imported.value = ''; addRow.hidden = true; addToggle.setAttribute('aria-expanded', 'false') }
      }
    } catch (error) { status.textContent = error.message || String(error) } finally { setBusy(false) }
  }
  languageSelect.addEventListener('change', () => change('list'))
  addRow.addEventListener('submit', (event) => { event.preventDefault(); if (name.value.trim()) change('add', name.value.trim(), imported.value.trim() || undefined) })
  exportButton.addEventListener('click', () => change('export'))
  importButton.addEventListener('click', () => importFile.click())
  /* The file is read in the page and sent over as data: the environment's own
     format check (electron/code-envs.js) decides what it may write, and a file
     that is not an export is refused there rather than here by extension. */
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0]
    importFile.value = ''
    if (!file) return
    let data
    try {
      data = JSON.parse(await file.text())
    } catch {
      status.textContent = 'That file is not JSON.'
      return
    }
    /* An export names its language; offering to land it under the wrong one is
       a question the user should not have to answer twice. */
    if (data && typeof data === 'object' && LANGUAGE_LABELS[data.language]) {
      languageSelect.value = data.language
    }
    await change('import', undefined, undefined, data)
  })
  reset.addEventListener('click', () => {
    if (reset.dataset.confirm !== 'yes') { reset.dataset.confirm = 'yes'; reset.textContent = 'Reset and remove all packages?'; return }
    reset.dataset.confirm = ''; reset.textContent = 'Reset environment'; change('reset')
  })
  dialog.append(head, subtitle, toolbar, addRow, list, actions, status)
  /* An open menu rides with the content it hangs from: scrolled, it would be
     left pointing at a row that has moved away. */
  dialog.addEventListener('scroll', () => {
    for (const open of dialog.querySelectorAll('.packages-menu[open]')) open.open = false
  })
  dialog.addEventListener('close', () => { dialog.remove(); onClose?.() }, { once: true })
  document.body.append(dialog)
  dialog.showModal()
  await change('list')
}
