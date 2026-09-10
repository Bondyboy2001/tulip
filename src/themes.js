/* Picker metadata; complete palettes live in styles.css. */
export const THEMES = [
  { id: 'linen', label: 'Linen', note: 'Light', swatch: ['#F8F4ED', '#994963', '#476A50'] },
  { id: 'botanical', label: 'Botanical', note: 'Light', swatch: ['#F2F5EF', '#386749', '#526B35'] },
  { id: 'porcelain', label: 'Porcelain', note: 'Light', swatch: ['#F5F7FA', '#3D61A0', '#426E5C'] },
  { id: 'jupyter', label: 'Jupyter Notebook', note: 'Light', swatch: ['#FFFFFF', '#A84400', '#286B32'] },
  { id: 'latex', label: 'LaTeX', note: 'Light', swatch: ['#FFFEFA', '#33312E', '#365B72'] },
  { id: 'dusk', label: 'Dusk', note: 'Dark', swatch: ['#252129', '#DDA3BB', '#AAC4A0'] },
  { id: 'midnight', label: 'Midnight', note: 'Dark', swatch: ['#171F2A', '#9DBCEB', '#A0C4AC'] },
]

const IDS = new Set(THEMES.map((theme) => theme.id))
const DARK = new Set(THEMES.filter((theme) => theme.note === 'Dark').map((theme) => theme.id))
const LEGACY_DARK = new Set(['dark', 'catppuccin', 'cobalt2', 'cursor-midnight', 'dracula', 'gruvbox', 'monokai', 'nord', 'one-dark', 'solarized-dark'])

export function resolveTheme (id) {
  return IDS.has(id) ? id : LEGACY_DARK.has(id) ? 'midnight' : 'linen'
}

export const isDarkTheme = (id) => DARK.has(resolveTheme(id))
