// Workspace naming uses a native dialog for focus containment and Escape.
export function mountWorkspaceTools ({ api, notify }) {
  function dialog (title) {
    const box = document.createElement('dialog')
    box.className = 'workspace-tools'
    const heading = document.createElement('h2')
    heading.textContent = title
    box.append(heading)
    box.addEventListener('close', () => box.remove())
    document.body.append(box)
    return box
  }
  return {
    save () {
      const box = dialog('Save workspace')
      const form = document.createElement('form')
      const label = document.createElement('label')
      label.textContent = 'Workspace name'
      const input = document.createElement('input')
      input.required = true
      input.maxLength = 80
      input.placeholder = 'Research'
      label.append(input)
      const save = document.createElement('button')
      save.textContent = 'Save workspace'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', () => box.close())
      form.append(label, save, cancel)
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        save.disabled = true
        try {
          const result = await api.workspace.save(input.value)
          if (result?.ok) { box.close(); notify('Workspace saved.') }
          else notify('The workspace could not be saved. Check that your documents have saved.')
        } catch { notify('The workspace could not be saved.') }
        finally { save.disabled = false }
      })
      box.append(form)
      box.showModal()
      input.focus()
    }
  }
}
