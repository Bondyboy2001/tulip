import { el as node } from './dom.js'

export function mountShortcuts ({ el, search, keyLabel }) {
/* ------------------------------------------------------------ shortcuts

   What the app answers to, in one place.

   Every chord here is already declared somewhere — most in main's menu, the
   rest in the panes that own them — and this is deliberately a written copy
   rather than something derived from either. Main's accelerators live in a
   process this one cannot read, and half the list never was a menu item; a
   sheet assembled from what happens to be reachable would quietly omit exactly
   the shortcuts that are hardest to discover, which are the ones it is for.

   The cost is that it can drift. That is what the test in
   scripts/test-ui-contracts.mjs is for: it holds this list against main's menu.
   ================================================================== */

const SHORTCUTS = [
  ['Getting around', [
    ['⌘O', 'Quick switcher'],
    ['⌘P', 'Command palette'],
    ['⌘⇧F', 'Search the vault'],
    ['⌘F', 'Find in this note'],
    ['⌘[', 'Back'],
    ['⌘]', 'Forward'],
    ['⌥⌘←', 'Previous tab'],
    ['⌥⌘→', 'Next tab']
  ]],
  ['Documents', [
    ['⌘N', 'New note'],
    ['⌘⇧N', 'New folder'],
    ['⌘T', 'New tab'],
    ['⌘W', 'Close tab'],
    ['⌘⇧T', 'Reopen closed tab'],
    ['⌘S', 'Save'],
    ['⌘⌥P', 'Print'],
    ['↵', 'Rename, in the file tree'],
    ['⌘↵', 'Open, in the file tree']
  ]],
  ['Views and panels', [
    ['⌘1', 'Reading view'],
    ['⌘2', 'Editing view'],
    ['⌘3', 'Raw view'],
    ['⌘E', 'Toggle reading view'],
    ['⌘B', 'Toggle sidebar'],
    ['⌘⇧E', 'Toggle outline'],
    ['⌘⇧K', 'Toggle backlinks'],
    ['⌘⇧I', 'Toggle info'],
    ['⌘⇧A', 'Toggle copilot'],
    ['⌃T', 'Copilot thinking level'],
    ['⌘⇧L', 'Toggle theme']
  ]],
  ['The window', [
    ['⌘⌥N', 'New window'],
    ['⌘⇧W', 'Close window'],
    ['⌘⇧O', 'Open a vault'],
    ['⌘,', 'Settings'],
    ['⌘0', 'Default size'],
    ['⌘+', 'Zoom in'],
    ['⌘-', 'Zoom out'],
    ['⌘/', 'This sheet']
  ]],
  ['Notebooks and tables', [
    ['⌘.', 'Interrupt the kernel'],
    ['⌘⇧F', 'Filter a column'],
    ['⌥⌘F', 'Fit every column'],
    ['⌘⏎', 'Add a row below']
  ]]
]

function openShortcuts () {
  if (!el.shortcutsBody.childElementCount) {
    const frag = document.createDocumentFragment()
    for (const [group, rows] of SHORTCUTS) {
      const section = node('section', 'shortcuts-group')
      section.append(node('h3', 'shortcuts-group-name', group))
      for (const [chord, what] of rows) {
        const row = node('div', 'shortcuts-row')
        row.append(node('span', 'shortcuts-what', what))
        // Spelt for this platform: on Windows these are Ctrl chords, and the
        // glyphs name keys that keyboard has not got.
        row.append(node('kbd', 'shortcuts-key', keyLabel(chord)))
        section.append(row)
      }
      frag.append(section)
    }
    el.shortcutsBody.append(frag)
  }
  el.shortcuts.hidden = false
  search.focus()
}

function closeShortcuts () {
  if (el.shortcuts.hidden) return
  el.shortcuts.hidden = true
}

search.addEventListener('input', (event) => {
  const query = /** @type {HTMLInputElement} */ (event.target).value.toLowerCase().trim()
  for (const section of el.shortcutsBody.querySelectorAll('.shortcuts-group')) {
    for (const row of section.querySelectorAll('.shortcuts-row')) {
      /** @type {HTMLElement} */ (row).hidden = !row.textContent.toLowerCase().includes(query)
    }
    /** @type {HTMLElement} */ (section).hidden = !section.querySelector('.shortcuts-row:not([hidden])')
  }
})
el.shortcutsClose.addEventListener('click', closeShortcuts)
// Clicking the dimmed page behind it is the way out of every other overlay here.
el.shortcuts.addEventListener('mousedown', (e) => { if (e.target === el.shortcuts) closeShortcuts() })


return { openShortcuts, closeShortcuts }
}
