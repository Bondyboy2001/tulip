/* =============================================================== themes
   A theme is a block of custom properties in the stylesheet, selected by
   `data-theme` on the root. This file holds only what the picker needs: the
   name to show, and three colours to show it with. The palettes themselves
   live in styles.css, where the rest of the app's colour already lives.
   ================================================================== */

export const THEMES = [
  { id: 'catppuccin', label: 'Catppuccin Mocha', note: 'Dark', swatch: ['#1E1E2E', '#CBA6F7', '#A6E3A1'] },
  { id: 'cobalt2', label: 'Cobalt2', note: 'Dark', swatch: ['#193549', '#FFC600', '#A5FF90'] },
  { id: 'cursor-midnight', label: 'Cursor Midnight', note: 'Dark', swatch: ['#0D1017', '#6AA6F8', '#7FD88F'] },
  { id: 'dracula', label: 'Dracula', note: 'Dark', swatch: ['#282A36', '#FF79C6', '#50FA7B'] },
  { id: 'gruvbox', label: 'Gruvbox', note: 'Dark', swatch: ['#282828', '#FE8019', '#B8BB26'] },
  { id: 'dark', label: 'Ink', note: 'Dark', swatch: ['#141317', '#E87D9B', '#8CB286'] },
  { id: 'monokai', label: 'Monokai', note: 'Dark', swatch: ['#272822', '#F92672', '#A6E22E'] },
  { id: 'nord', label: 'Nord', note: 'Dark', swatch: ['#2E3440', '#88C0D0', '#A3BE8C'] },
  { id: 'one-dark', label: 'One Dark', note: 'Dark', swatch: ['#282C34', '#61AFEF', '#98C379'] },
  { id: 'light', label: 'Paper', note: 'Light', swatch: ['#FBFAF8', '#A63A5A', '#4F6B4B'] },
  { id: 'solarized-dark', label: 'Solarized Dark', note: 'Dark', swatch: ['#002B36', '#268BD2', '#859900'] },
  { id: 'solarized-light', label: 'Solarized Light', note: 'Light', swatch: ['#FDF6E3', '#268BD2', '#859900'] }
]

const IDS = new Set(THEMES.map((t) => t.id))

export const isTheme = (id) => IDS.has(id)

/* Which side of the ledger a palette sits on, for the things that draw rather
   than being painted — the whiteboard asks this, not the stylesheet. */
const DARK = new Set(THEMES.filter((t) => t.note === 'Dark').map((t) => t.id))
export const isDarkTheme = (id) => DARK.has(id)

export function resolveTheme (id) {
  return isTheme(id) ? id : 'light'
}
