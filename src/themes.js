/* =============================================================== themes
   A theme is a block of custom properties in the stylesheet, selected by
   `data-theme` on the root. This file holds only what the picker needs: the
   name to show, and three colours to show it with. The palettes themselves
   live in styles.css, where the rest of the app's colour already lives.
   ================================================================== */

export const THEMES = [
  { id: 'system', label: 'Match system', note: 'Follows macOS', swatch: ['#FBFAF8', '#141317', '#A63A5A'] },
  { id: 'light', label: 'Paper', note: 'Light', swatch: ['#FBFAF8', '#A63A5A', '#4F6B4B'] },
  { id: 'dark', label: 'Ink', note: 'Dark', swatch: ['#141317', '#E87D9B', '#8CB286'] },
  { id: 'dracula', label: 'Dracula', note: 'Dark', swatch: ['#282A36', '#FF79C6', '#50FA7B'] },
  { id: 'monokai', label: 'Monokai', note: 'Dark', swatch: ['#272822', '#F92672', '#A6E22E'] },
  { id: 'cobalt2', label: 'Cobalt2', note: 'Dark', swatch: ['#193549', '#FFC600', '#A5FF90'] },
  { id: 'cursor-midnight', label: 'Cursor Midnight', note: 'Dark', swatch: ['#0D1017', '#6AA6F8', '#7FD88F'] }
]

const IDS = new Set(THEMES.map((t) => t.id))

export const isTheme = (id) => IDS.has(id)

/** `system` is the only id that is not itself a stylesheet block. */
export function resolveTheme (id, systemTheme) {
  if (id === 'system') return systemTheme === 'dark' ? 'dark' : 'light'
  return isTheme(id) ? id : 'light'
}
