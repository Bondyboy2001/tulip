'use strict'

/* ================================================================ safe names
   Turning what someone typed into a name a file can actually have.

   The vault is an ordinary folder, so a note's name is a filename, and the two
   do not have the same rules. A name that is merely awkward on macOS is often
   impossible on Windows, and the failure arrives as an errno from deep inside a
   rename rather than as anything a reader can act on:

     `Notes: Monday`   a colon is legal on macOS and forbidden on Windows
     `report.`         trailing dots and spaces are silently eaten by Win32
     `CON`, `LPT1`     device names, reserved with or without an extension
     `a/b`             a path separator, which would move the file

   So the decision is made once, here, for every platform — a vault written on a
   Mac should still open on a PC, which means the Mac has to keep to the smaller
   set of rules rather than discovering the difference when the folder is synced.

   Pure, and its own module, because the interesting cases are all edge cases:
   the empty name that lands on `.md` and vanishes from the tree, the name that
   is only dots, the reserved word that arrives with an extension attached.
*/

/* Reserved by Win32 for character devices, with or without an extension:
   `CON.md` is as unopenable as `CON`. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/* Forbidden on Windows. `/` and `\` are handled apart from these — they are a
   path, not a typo, so they are replaced rather than rejected. */
const ILLEGAL = /[<>:"|?*]/g

/* Control characters are a bad idea in a filename on any platform and illegal
   on Windows. Tested by code point rather than by a character class: writing
   the range as an escape is how literal NUL bytes end up in this file. */
const isControl = (ch) => ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127

/**
 * Clean a typed name into one a file can carry.
 *
 * @param {unknown} typed          what the reader typed
 * @param {object}  [options]
 * @param {RegExp[]} [options.strip] extension patterns to take off the end —
 *   the tree shows documents without one, so a name typed back with `.md` on it
 *   must not be filed as `Note.md.md`
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
function safeFileName (typed, options = {}) {
  const strip = options.strip || []

  let name = String(typed == null ? '' : typed)
  // A separator would make this a move. Kept as a character rather than
  // dropped, so `A/B` reads as `A-B` instead of silently becoming `AB`.
  name = name.replace(/[/\\]/g, '-')
  name = name.replace(ILLEGAL, '')
  name = [...name].filter((ch) => !isControl(ch)).join('')
  for (const pattern of strip) name = name.replace(pattern, '')
  /* Win32 drops trailing dots and spaces when it stores a name, so `report.`
     becomes `report` on disk while the app goes on believing otherwise — and
     every later lookup by the name it thinks it wrote misses. */
  name = name.trim().replace(/[. ]+$/, '').trim()

  /* An empty or dot-leading name is not a rename, it is a disappearance: the
     document lands on `.md`, which is hidden on disk, skipped by the vault walk
     and absent from the tree — with no way left in the UI to name it back. */
  if (!name) return { ok: false, error: 'A name cannot be empty.' }
  if (name.startsWith('.')) return { ok: false, error: 'A name cannot start with a dot.' }
  if (RESERVED.test(name)) {
    return { ok: false, error: `"${name}" is a reserved name on Windows.` }
  }
  /* 255 bytes is the limit on every filesystem Tulip meets, and it counts
     bytes rather than characters — an emoji is four of them. The extension is
     added by the caller afterwards, hence the margin. */
  if (Buffer.byteLength(name, 'utf8') > 240) {
    return { ok: false, error: 'That name is too long.' }
  }
  return { ok: true, name }
}

module.exports = { safeFileName }
