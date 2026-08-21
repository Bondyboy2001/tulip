/* ============================================================ platform
   What to call the keys and the file manager, on the desktop this actually is.

   Every shortcut this app printed was a ⌘ chord and every reveal button said
   Finder, because the page was written on a Mac and had no way to ask. On the
   Windows build those are not merely the wrong words — they name keys that do
   not exist on the keyboard in front of the reader.

   The chords live in the markup as the glyph form because that is the form
   worth reading where it is right, and it is the denser one; this rewrites them
   where it is not. Nothing here decides *what* a shortcut is — main's menu owns
   that, and its accelerators are already per-platform — only how it is spelt.
   ================================================================== */

const platform = () => globalThis.tulip?.platform || 'darwin'

export const isMac = () => platform() === 'darwin'
export const isWindows = () => platform() === 'win32'

/* The glyphs, and the words the rest of the desktop world uses for them. ⌘ and
   ⌃ both land on Ctrl: Tulip's own menu maps Cmd to Ctrl on Windows, so two
   chords that differ only in that modifier are the same chord there — which is
   main's problem to avoid, not this module's to hide. */
const WORD = {
  '⌘': 'Ctrl',
  '⌃': 'Ctrl',
  '⌥': 'Alt',
  '⇧': 'Shift',
  '⏎': 'Enter',
  '↵': 'Enter',
  '⌫': 'Backspace',
  '⌦': 'Delete',
  '⎋': 'Esc',
  '⇥': 'Tab',
  '␣': 'Space',
  /* "Ctrl++" is the literal spelling and an unreadable one; Windows names this
     key in words. Its opposite number stays as `-`, which nothing misreads. */
  '+': 'Plus'
}

/* A modifier run and the one key it is pressed with. Bounded to a single
   trailing character so that "⌘N" inside a sentence takes the N and leaves the
   sentence alone — the reason this is a match-and-replace rather than a walk
   over every character, which turned "New note (⌘N)" into nonsense. */
const CHORD = /[⌘⌃⌥⇧]+(?:[A-Za-z0-9,./;'\][\\`=+-]|⏎|↵|⌫|⌦|⎋|⇥|␣|→|←|↑|↓)?/gu

/**
 * A keyboard shortcut, spelt for this platform.
 *
 * On a Mac it is what it already was. Anywhere else the glyph run becomes the
 * words, joined the way that platform joins them.
 */
export function keyLabel (text) {
  const s = String(text ?? '')
  if (isMac() || !s) return s
  return s.replace(CHORD, (chord) => {
    const parts = []
    let key = ''
    for (const ch of chord) {
      if (WORD[ch] && '⌘⌃⌥⇧'.includes(ch)) parts.push(WORD[ch])
      else key += ch
    }
    /* ⌘ and ⌃ in one chord would otherwise print "Ctrl+Ctrl". The order the
       modifiers were written in is kept — it is the order they are read in. */
    const mods = [...new Set(parts)]
    const named = WORD[key] || (key.length === 1 ? key.toUpperCase() : key)
    return [...mods, named].filter(Boolean).join('+')
  })
}

/** What the system file manager is called here. */
export const revealName = () => (isMac() ? 'Finder' : isWindows() ? 'File Explorer' : 'the file manager')

/** The label on a button that shows a file in it. */
export const revealLabel = () => (isMac() ? 'Reveal in Finder' : `Show in ${revealName()}`)

/**
 * Rewrite the shortcuts already written into the page.
 *
 * The markup carries them in `title` attributes and `<kbd>` elements, dozens of
 * them, and none is worth a call site of its own. Run once after the page is
 * built; on a Mac it does nothing at all, which is the common case and why it
 * checks before it walks.
 */
export function localiseShortcuts (root = document) {
  if (isMac()) return
  for (const node of root.querySelectorAll('[title]')) {
    const said = node.getAttribute('title')
    const now = keyLabel(said)
    if (now !== said) node.setAttribute('title', now)
  }
  for (const node of root.querySelectorAll('kbd')) {
    const now = keyLabel(node.textContent)
    if (now !== node.textContent) node.textContent = now
  }
  for (const node of root.querySelectorAll('[aria-label]')) {
    const said = node.getAttribute('aria-label')
    const now = keyLabel(said)
    if (now !== said) node.setAttribute('aria-label', now)
  }
}
