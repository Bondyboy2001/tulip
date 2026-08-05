/* ================================================================ fonts
   Two typefaces run the app: one for what you write — the notes, the reading
   view, the table grids — and one for everything around it. Each is a custom
   property in the stylesheet, so changing either is nothing more than pointing
   the root at a different stack.

   Everything here is already on the machine. Nothing is fetched: the page's
   own policy forbids it (see the CSP in index.html), and a font that has to
   arrive over a network is a note that renders twice. So the list is the faces
   macOS actually ships, each with fallbacks behind it for the day it does not.

   The first serif and the first sans are the two the stylesheet already used,
   spelled identically, so an install that has never opened this picker looks
   exactly as it did.
   ================================================================== */

export const FONTS = [
  /* ---------------------------------------------------------- serif */
  { id: 'charter', label: 'Charter', kind: 'Serif', stack: 'Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif' },
  { id: 'new-york', label: 'New York', kind: 'Serif', stack: 'ui-serif, "New York", Georgia, serif' },
  { id: 'iowan', label: 'Iowan Old Style', kind: 'Serif', stack: '"Iowan Old Style", Charter, Georgia, serif' },
  { id: 'palatino', label: 'Palatino', kind: 'Serif', stack: 'Palatino, "Palatino Linotype", "Book Antiqua", Georgia, serif' },
  { id: 'baskerville', label: 'Baskerville', kind: 'Serif', stack: 'Baskerville, "Libre Baskerville", Georgia, serif' },
  { id: 'hoefler', label: 'Hoefler Text', kind: 'Serif', stack: '"Hoefler Text", Baskerville, Georgia, serif' },
  { id: 'georgia', label: 'Georgia', kind: 'Serif', stack: 'Georgia, Charter, serif' },
  { id: 'times', label: 'Times New Roman', kind: 'Serif', stack: '"Times New Roman", Times, serif' },
  /* The one exception to "already on the machine": bundled with the app (see
     the @font-face at the top of styles.css), because TeX's face ships with
     no Mac and a vault full of maths reads most at home in it. */
  { id: 'computer-modern', label: 'Computer Modern', kind: 'Serif', stack: '"Computer Modern", "CMU Serif", "Latin Modern Roman", Georgia, serif' },

  /* ----------------------------------------------------------- sans */
  { id: 'system-sans', label: 'System Sans', kind: 'Sans', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  { id: 'helvetica', label: 'Helvetica Neue', kind: 'Sans', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'avenir', label: 'Avenir Next', kind: 'Sans', stack: '"Avenir Next", Avenir, "Segoe UI", sans-serif' },
  { id: 'optima', label: 'Optima', kind: 'Sans', stack: 'Optima, Candara, "Segoe UI", sans-serif' },
  { id: 'futura', label: 'Futura', kind: 'Sans', stack: 'Futura, "Century Gothic", "Segoe UI", sans-serif' },
  { id: 'gill-sans', label: 'Gill Sans', kind: 'Sans', stack: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif' },
  { id: 'verdana', label: 'Verdana', kind: 'Sans', stack: 'Verdana, Geneva, sans-serif' },
  /* Not a macOS face, but a common install (and free): the Braille Institute's
     low-vision typeface. Named with its newer cut first, falling back to the
     classic, then to the system sans for a machine without either. */
  { id: 'atkinson', label: 'Atkinson Hyperlegible', kind: 'Sans', stack: '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", -apple-system, "Segoe UI", sans-serif' },

  /* ----------------------------------------------------------- mono */
  { id: 'sf-mono', label: 'SF Mono', kind: 'Mono', stack: '"SF Mono", ui-monospace, Menlo, monospace' },
  { id: 'menlo', label: 'Menlo', kind: 'Mono', stack: 'Menlo, Consolas, monospace' },
  { id: 'monaco', label: 'Monaco', kind: 'Mono', stack: 'Monaco, Menlo, monospace' },
  { id: 'courier', label: 'Courier New', kind: 'Mono', stack: '"Courier New", Courier, monospace' }
]

const BY_ID = new Map(FONTS.map((f) => [f.id, f]))

export const isFont = (id) => BY_ID.has(id)

/**
 * The two places a typeface is used, and everything that differs between them:
 * which property carries it, what it is called under `config`, and where it
 * starts. Held together here so adding a third role is one entry rather than a
 * hunt through the renderer.
 */
export const FONT_ROLES = {
  body: {
    token: '--font-body',
    key: 'fontBody',
    fallback: 'charter',
    label: 'Markdown font',
    /* Said in the picker, because "markdown font" and "interface font" are not
       self-evidently different things until you are told which is which. */
    note: 'Notes, the reading view and the tables'
  },
  ui: {
    token: '--font-ui',
    key: 'fontUi',
    fallback: 'system-sans',
    label: 'Interface font',
    note: 'Menus, the sidebar, tabs and panels'
  }
}

/** The stack an id names, or the role's own starting point if it names none. */
export function fontStack (id, role) {
  return (BY_ID.get(id) || BY_ID.get(FONT_ROLES[role].fallback)).stack
}

/** What to call the chosen face, for the toast that confirms it. */
export const fontLabel = (id) => BY_ID.get(id)?.label || id
