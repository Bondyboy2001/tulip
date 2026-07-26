/* ============================================================ languages
   A fenced block announces itself with a small tile: the language's own
   colour and its brand mark, from the Simple Icons set in logos.js. The few
   languages that set does not carry — C#, F#, PowerShell, Objective-C — keep
   the two- or three-letter monogram, drawn in the same tile at the same size.
   ================================================================== */

import { logoSvg } from './logos.js'

const DARK_INK = '#1A1815'

const ENTRIES = [
  { id: 'javascript', label: 'JavaScript', short: 'JS', color: '#F7DF1E', ink: DARK_INK,
    alias: ['js', 'mjs', 'cjs', 'node'] },
  { id: 'jsx', label: 'JSX', short: 'JSX', color: '#F7DF1E', ink: DARK_INK },
  { id: 'typescript', label: 'TypeScript', short: 'TS', color: '#3178C6', alias: ['ts', 'mts', 'cts'] },
  { id: 'tsx', label: 'TSX', short: 'TSX', color: '#3178C6' },
  { id: 'python', label: 'Python', short: 'PY', color: '#3776AB', alias: ['py', 'python3'] },
  { id: 'ruby', label: 'Ruby', short: 'RB', color: '#CC342D', alias: ['rb'] },
  { id: 'rust', label: 'Rust', short: 'RS', color: '#CE422B', alias: ['rs'] },
  { id: 'go', label: 'Go', short: 'GO', color: '#00ADD8', alias: ['golang'] },
  { id: 'swift', label: 'Swift', short: 'SW', color: '#F05138' },
  { id: 'kotlin', label: 'Kotlin', short: 'KT', color: '#7F52FF', alias: ['kt'] },
  { id: 'java', label: 'Java', short: 'JV', color: '#E76F00' },
  { id: 'c', label: 'C', short: 'C', color: '#5C6BC0', alias: ['h'] },
  { id: 'cpp', label: 'C++', short: 'C++', color: '#00599C', alias: ['c++', 'cc', 'hpp', 'cxx'] },
  { id: 'csharp', label: 'C#', short: 'C#', color: '#68217A', alias: ['cs', 'c#'] },
  { id: 'objective-c', label: 'Objective-C', short: 'OBJ', color: '#438EFF', alias: ['objc', 'objectivec'] },
  { id: 'php', label: 'PHP', short: 'PHP', color: '#777BB4' },
  { id: 'html', label: 'HTML', short: '<>', color: '#E34F26', alias: ['htm', 'xhtml'] },
  { id: 'css', label: 'CSS', short: 'CSS', color: '#1572B6' },
  { id: 'scss', label: 'Sass', short: 'SCS', color: '#CD6799', alias: ['sass', 'less'] },
  { id: 'json', label: 'JSON', short: '{}', color: '#6E6259', alias: ['json5', 'jsonc'] },
  { id: 'yaml', label: 'YAML', short: 'YML', color: '#CB171E', alias: ['yml'] },
  { id: 'toml', label: 'TOML', short: 'TML', color: '#9C4221' },
  { id: 'xml', label: 'XML', short: 'XML', color: '#F1662A', alias: ['svg', 'plist'] },
  { id: 'markdown', label: 'Markdown', short: 'MD', color: '#5E5B57', alias: ['md', 'mdown'] },
  { id: 'shell', label: 'Shell', short: '$_', color: '#4EAA25',
    alias: ['sh', 'bash', 'zsh', 'fish', 'console', 'shell-session', 'terminal'] },
  { id: 'powershell', label: 'PowerShell', short: 'PS', color: '#5391FE', alias: ['ps1', 'pwsh'] },
  { id: 'sql', label: 'SQL', short: 'SQL', color: '#E38C00',
    alias: ['postgres', 'postgresql', 'mysql', 'sqlite'] },
  { id: 'lua', label: 'Lua', short: 'LUA', color: '#2C2D72' },
  { id: 'r', label: 'R', short: 'R', color: '#276DC3' },
  { id: 'dart', label: 'Dart', short: 'DRT', color: '#0175C2' },
  { id: 'vue', label: 'Vue', short: 'VUE', color: '#41B883' },
  { id: 'svelte', label: 'Svelte', short: 'SVE', color: '#FF3E00' },
  { id: 'haskell', label: 'Haskell', short: 'HS', color: '#5E5086', alias: ['hs'] },
  { id: 'elixir', label: 'Elixir', short: 'EX', color: '#4B275F', alias: ['ex', 'exs'] },
  { id: 'erlang', label: 'Erlang', short: 'ERL', color: '#A90533' },
  { id: 'clojure', label: 'Clojure', short: 'CLJ', color: '#5881D8', alias: ['clj', 'cljs'] },
  { id: 'scala', label: 'Scala', short: 'SC', color: '#DC322F' },
  { id: 'zig', label: 'Zig', short: 'ZIG', color: '#F7A41D', ink: DARK_INK },
  { id: 'nim', label: 'Nim', short: 'NIM', color: '#FFE953', ink: DARK_INK },
  { id: 'perl', label: 'Perl', short: 'PL', color: '#39457E', alias: ['pl'] },
  { id: 'julia', label: 'Julia', short: 'JL', color: '#9558B2', alias: ['jl'] },
  { id: 'ocaml', label: 'OCaml', short: 'ML', color: '#EC6813' },
  { id: 'fsharp', label: 'F#', short: 'F#', color: '#378BBA', alias: ['fs', 'f#'] },
  { id: 'graphql', label: 'GraphQL', short: 'GQL', color: '#E10098', alias: ['gql'] },
  { id: 'dockerfile', label: 'Dockerfile', short: 'DKR', color: '#2496ED', alias: ['docker'] },
  { id: 'nix', label: 'Nix', short: 'NIX', color: '#7EBAE4', ink: DARK_INK },
  { id: 'solidity', label: 'Solidity', short: 'SOL', color: '#4C4C4C', alias: ['sol'] },
  { id: 'makefile', label: 'Makefile', short: 'MK', color: '#427819', alias: ['make', 'cmake'] },
  { id: 'latex', label: 'LaTeX', short: 'TEX', color: '#008080', alias: ['tex'] },
  { id: 'vim', label: 'Vim', short: 'VIM', color: '#019733', alias: ['viml', 'vimscript'] },
  { id: 'diff', label: 'Diff', short: '±', color: '#5E7A5A', alias: ['patch'] },
  { id: 'ini', label: 'Config', short: 'CFG', color: '#85807A', alias: ['conf', 'config', 'properties', 'env'] },
  { id: 'text', label: 'Plain text', short: 'TXT', color: '#85807A', alias: ['txt', 'plain', 'plaintext'] }
]

const INDEX = new Map()
for (const entry of ENTRIES) {
  INDEX.set(entry.id, entry)
  for (const alias of entry.alias || []) INDEX.set(alias, entry)
}

/** Never null for a non-empty token — an unknown language still gets a tile,
 *  drawn in the neutral grey so it reads as "unrecognised", not "broken". */
export function languageMark (token) {
  const key = String(token || '').trim().toLowerCase()
  if (!key) return null
  const hit = INDEX.get(key)
  if (hit) return hit
  return { id: key, label: key, short: key.slice(0, 3).toUpperCase(), color: null }
}

/**
 * @param {string} token   the word after the opening fence
 * @param {{label?: boolean}} [opts]  include the spelled-out language name
 */
export function languageChip (token, { label = true } = {}) {
  const info = languageMark(token)
  if (!info) return null

  const chip = document.createElement('span')
  chip.className = 'lang-chip'

  const mark = document.createElement('span')
  mark.className = 'lang-mark'
  mark.title = info.label

  // The brand mark when there is one, the monogram when there is not — so a
  // language Simple Icons does not carry still gets a tile of the same size.
  const logo = logoSvg(info.id)
  if (logo) {
    mark.classList.add('has-logo')
    mark.append(logo)
  } else {
    mark.textContent = info.short
  }

  if (info.color) {
    mark.style.setProperty('--mark', info.color)
    mark.style.setProperty('--mark-ink', info.ink || '#FFFFFF')
  }
  chip.append(mark)

  if (label) {
    const name = document.createElement('span')
    name.className = 'lang-name'
    name.textContent = info.label
    chip.append(name)
  }

  return chip
}
