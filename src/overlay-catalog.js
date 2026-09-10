/* Static vocabulary for the renderer's shared picker. Keeping prompts, labels,
 * vaultless modes together makes a new overlay define its
 * keyboard and screen-reader face in one small, type-checked place. */

export const FONT_MODES = { 'font-body': 'body', 'font-ui': 'ui' }

export const VAULTLESS = new Set(['commands', 'themes', 'font-body', 'font-ui', 'vaults'])

export const OVERLAY_PROMPT = {
  switcher: 'Jump to a note…',
  search: 'Search notes, PDFs, and highlights…',
  commands: 'Run a command…',
  'new-files': 'Choose a file type…',
  'new-source': 'Choose a language…',
  themes: 'Change the theme…',
  'font-body': 'Choose the font notes are written in…',
  'font-ui': 'Choose the font the app is drawn in…',
  countries: 'Choose a country flag…',
  'move-to': 'Move to a folder…',
  templates: 'Insert a template…',
  vaults: 'Open a vault Tulip knows…',
  tags: 'Filter tags…'
}

export const OVERLAY_LABEL = {
  switcher: 'Quick switcher',
  search: 'Search the vault',
  commands: 'Command palette',
  'new-files': 'New file',
  'new-source': 'New source file',
  themes: 'Theme',
  'font-body': 'Markdown font',
  'font-ui': 'Interface font',
  countries: 'Country flag',
  'move-to': 'Move to a folder',
  vaults: 'Recent vaults',
  templates: 'Insert a template',
  tags: 'Tags'
}
