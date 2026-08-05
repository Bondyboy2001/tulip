/* ============================================================ languages
   A fenced block announces itself with a small tile: the language's own
   colour and its brand mark, from the Simple Icons set in logos.js. The few
   languages that set does not carry — C#, F#, PowerShell, Objective-C — keep
   the two- or three-letter monogram, drawn in the same tile at the same size.
   ================================================================== */

import { logoSvg } from './logos.js'
import RUNNABLE from '../electron/runnable-languages.json'

const DARK_INK = '#1A1815'

/* Exported for the editor's fence-language autocomplete, which offers these
   ids as you type after ``` . */
export const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript', short: 'JS', color: '#F7DF1E', ink: DARK_INK,
    alias: ['js', 'mjs', 'cjs', 'node'] },
  { id: 'jsx', label: 'JSX', short: 'JSX', color: '#F7DF1E', ink: DARK_INK },
  { id: 'typescript', label: 'TypeScript', short: 'TS', color: '#3178C6', alias: ['ts', 'mts', 'cts'] },
  { id: 'tsx', label: 'TSX', short: 'TSX', color: '#3178C6' },
  { id: 'python', label: 'Python', short: 'PY', color: '#3776AB', alias: ['py', 'python3'] },
  /* Manim blocks are Python, but they are their own kind of block — what comes
     out is a film, not a program's output — so they get their own tile. */
  { id: 'manim', label: 'Manim', short: 'MAN', color: '#63C9B0', ink: DARK_INK },
  { id: 'lean', label: 'Lean', short: 'L∀N', color: '#0000FF', alias: ['lean4'] },
  /* Mermaid blocks are drawn rather than run, the same as manim — the tile is
     what tells you which of the two a block is before you read a line of it. */
  { id: 'mermaid', label: 'Mermaid', short: 'MMD', color: '#FF3670', alias: ['mmd'] },
  /* TikZ is LaTeX, and drawn rather than run — same family as manim and
     mermaid. The colour is TeX's own. */
  { id: 'tikz', label: 'TikZ', short: 'TkZ', color: '#008080' },
  /* A three block is JavaScript, and drawn rather than run — the same family
     again: the tile is what says a block builds a scene rather than printing
     something. three.js has no brand colour of its own beyond black, which at
     tile size is a hole in the page, so the mark is drawn on the near-black
     the logo itself uses. */
  { id: 'three', label: 'three.js', short: '3JS', color: '#2B2A28', alias: ['threejs', '3js'] },
  /* An svg block is drawn too — the only one of the family whose source needs
     nothing done to it but reading. It is XML underneath, which is why the
     tile is the one thing that says which of the two a block is. */
  { id: 'svg', label: 'SVG', short: 'SVG', color: '#FFB13B', ink: DARK_INK },
  /* One entry only — a twin further down once shadowed this one in INDEX. */
  { id: 'latex', label: 'LaTeX', short: 'TeX', color: '#008080', alias: ['tex'] },
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
  { id: 'xml', label: 'XML', short: 'XML', color: '#F1662A', alias: ['plist'] },
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
  { id: 'ocaml', label: 'OCaml', short: 'ML', color: '#EC6813', alias: ['ml'] },
  { id: 'fsharp', label: 'F#', short: 'F#', color: '#378BBA', alias: ['fs', 'f#'] },
  { id: 'graphql', label: 'GraphQL', short: 'GQL', color: '#E10098', alias: ['gql'] },
  { id: 'dockerfile', label: 'Dockerfile', short: 'DKR', color: '#2496ED', alias: ['docker'] },
  { id: 'nix', label: 'Nix', short: 'NIX', color: '#7EBAE4', ink: DARK_INK },
  { id: 'solidity', label: 'Solidity', short: 'SOL', color: '#4C4C4C', alias: ['sol'] },
  { id: 'makefile', label: 'Makefile', short: 'MK', color: '#427819', alias: ['make', 'cmake'] },
  { id: 'vim', label: 'Vim', short: 'VIM', color: '#019733', alias: ['viml', 'vimscript'] },
  { id: 'diff', label: 'Diff', short: '±', color: '#5E7A5A', alias: ['patch'] },
  { id: 'ini', label: 'Config', short: 'CFG', color: '#85807A', alias: ['conf', 'config', 'properties', 'env'] },
  { id: 'text', label: 'Plain text', short: 'TXT', color: '#85807A', alias: ['txt', 'plain', 'plaintext'] }
]

const INDEX = new Map()
for (const entry of LANGUAGES) {
  INDEX.set(entry.id, entry)
  for (const alias of entry.alias || []) INDEX.set(alias, entry)
}

/** Never null for a non-empty token — an unknown language still gets a tile,
 *  drawn in the neutral grey so it reads as "unrecognised", not "broken". */
function languageMark (token) {
  const key = String(token || '').trim().toLowerCase()
  if (!key) return null
  const hit = INDEX.get(key)
  if (hit) return hit
  return { id: key, label: key, short: key.slice(0, 3).toUpperCase(), color: null }
}

/**
 * The canonical id behind whatever spelling a fence used — `htm` and `xhtml`
 * both answer `html`.
 *
 * For the features that treat one language specially and would otherwise each
 * keep their own copy of its aliases: a spelling listed here but missing from
 * that copy is a block that draws the right chip and then gets none of the
 * treatment the chip implies. An unrecognised token is its own id, so a
 * comparison against a known one is still false rather than throwing.
 */
export const languageId = (token) => languageMark(token)?.id || ''

/* The fences this app draws rather than runs, by the name each drawing module
   answers to. Re-exported from the shared contract rather than restated,
   because the main process reads the same file to tell the copilot which
   fences Tulip understands — see electron/runnable-languages.json — and a
   second list here is how the two come to disagree about what `three` is. */
export const DRAWN = RUNNABLE.drawn

/**
 * Chips already built, by the id and shape they were built for. A note is
 * usually written in one or two languages and repeats them on every fence, so
 * a page of four hundred blocks asks for four hundred copies of the same four
 * elements. Built once each and cloned thereafter.
 *
 * Keyed on the *resolved* id rather than the fence's spelling, so `htm` and
 * `xhtml` share the copy they would both have produced. Only recognised
 * languages are held: an unknown token is its own id (see `languageMark`), and
 * note text must not be able to grow a cache without bound.
 */
const chipTemplates = new Map()

/**
 * @param {string} token   the word after the opening fence
 * @param {{label?: boolean}} [opts]  include the spelled-out language name
 */
export function languageChip (token, { label = true } = {}) {
  const info = languageMark(token)
  if (!info) return null

  /* Identity, not another lookup: `languageMark` hands back the shared entry
     for a language this list knows and a fresh object for one it does not, so
     this is the answer it already computed. An unknown token is not cached —
     it is its own id, and note text must not be able to grow a map. */
  const key = INDEX.get(info.id) === info ? `${info.id}|${label ? 'L' : ''}` : null
  if (key) {
    const cached = chipTemplates.get(key)
    if (cached) return cached.cloneNode(true)
  }

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

  if (key) {
    chipTemplates.set(key, chip)
    return chip.cloneNode(true)
  }
  return chip
}
