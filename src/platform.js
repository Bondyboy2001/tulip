/** Platform wording for the application chrome. Vault content is never touched. */
export function shortcutLabel (value, platform = window.tulip?.platform) {
  const text = String(value || '')
  if (platform !== 'win32') return text
  return text
    .replace(/⌃⌘/g, 'Ctrl+Alt+')
    .replace(/(?:⌘⌥|⌥⌘)/g, 'Ctrl+Alt+')
    .replace(/⇧⌥/g, 'Shift+Alt+')
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌃/g, 'Ctrl+')
}

export function localizeChrome (root = document, platform = window.tulip?.platform) {
  document.documentElement.dataset.platform = platform || 'unknown'
  if (platform !== 'win32') return

  for (const element of root.querySelectorAll('[title]')) {
    element.title = shortcutLabel(element.title, platform)
  }
  for (const element of root.querySelectorAll('kbd, button')) {
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) child.textContent = shortcutLabel(child.textContent, platform)
    }
  }
}
