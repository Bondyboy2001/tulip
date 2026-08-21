/* ================================================================= tikz
   A ```tikz block is a picture, and the point of a picture is the drawing. So
   both views show the drawing where the code was, and the code is a thing you
   ask for rather than the thing you are given — the same bargain the manim
   blocks strike, for the same reason.

   The drawing is a real .svg in the vault, beside the note's other
   attachments, and which file it is comes from a hash of the code (see
   tikzTarget in electron/main.js). Same block, same filename: a note that has
   been drawn opens with its pictures already in place, and an edited block
   asks for a name nothing has written yet, which is exactly when redrawing is
   right. Nothing is written into the .md — the block stays the source and the
   picture beside it is derived from it.

   Unlike mermaid, this cannot be redrawn as you type: it is a TeX run, a
   second or two at best, and it needs TeX installed. That is what makes it a
   thing you ask for, and what makes the answer worth keeping.
   ================================================================== */

import { embedSpec, renderEmbed } from './assets.js'
import { artefactRun, attachArtefactBlock } from './runcode.js'
import { DRAWN } from './languages.js'

const api = globalThis.tulip

export function isTikz (lang) {
  return String(lang || '').trim().toLowerCase() === DRAWN.tikz
}

/* Runs in flight, keyed by note and code — the same bargain runcode's
   `results` map strikes, and for the same reason. A per-attach state looked
   fine until a widget rebuild (a note switch, a keystroke near the fence)
   detached it mid-render: the fresh widget's lookup ran before the file
   existed, so it said "Draw" while TeX worked on unseen, and the finished
   picture never appeared. A rebuilt widget adopts the run instead. Entries
   are retired once the run has settled and been shown. */
const runs = new Map()

/* The drawing for a path we have just been handed. Going through embedSpec
   keeps one decision about what an .svg in this vault becomes, shared with
   every other embed. */
/* Exported for the editing half next door, not for general use. */
export function pictureFor (path, onLoad) {
  const asItself = { dir: '', resolve: () => path }
  const picture = renderEmbed(embedSpec(path, asItself))
  if (onLoad) picture.querySelector?.('img')?.addEventListener('load', onLoad, { once: true })
  return picture
}

/**
 * What drawing this block *is* — the run behind it, and the words the control
 * wears while it goes. Everything else about a picture belongs to the view it
 * stands in, and the two views are different shapes: a code block in the
 * reading view, a widget under a fence in the editing view. This is the part
 * that must not differ between them.
 *
 * The words are here rather than on the button because starting a draw and
 * stopping one is the run gesture, and spelling it out beside blocks whose own
 * runs are a triangle made two different-looking things out of one. What the
 * words said is in the tooltip.
 *
 * @param {string} code      the picture's source
 * @param {string} noteName  which note's attachments it belongs to
 */
function tikzSpec (code, noteName) {
  return {
    runs,
    key: `${noteName}\n${code}`,
    words: {
      busy: 'Drawing…',
      keep: 1200,
      silent: () => 'TeX did not draw anything. Is a LaTeX distribution installed?'
    },
    titles: {
      stop: 'Stop drawing',
      again: 'Draw this picture again',
      first: 'Draw this picture with TeX'
    },
    start: () => api.tikz.render(noteName, code),
    lookup: () => api.tikz.lookup(noteName, code)
  }
}

/**
 * The same run, for a view that builds its own frame — the editing view's
 * widget, which is a picture under the fence rather than a block that becomes
 * one.
 *
 * @param {(path: string|null) => void} onPicture  a drawing arrived, or went
 * @param {() => void} [onPaint]  the status changed shape; re-measure
 */
/* Exported for the editing half next door, not for general use. */
export function tikzRun (code, noteName, onPicture, onPaint) {
  const { runs: table, key, ...spec } = tikzSpec(code, noteName)
  return artefactRun(table, key, {
    ...spec,
    statusClass: 'tikz-status',
    onPath: onPicture,
    onPaint
  })
}

/**
 * TeX primitives that read or write files, or hand work to the shell.
 *
 * A block using any of these is not drawn on sight. Reading a note is a
 * passive act and must stay one, but a note is not always something the reader
 * wrote — vaults are synced, shared, and cloned — and TeX is a full programming
 * language, so a picture that draws itself is a program that runs itself. The
 * command-execution half is refused by the engine (see `TEX_SANDBOX_ENV` in
 * electron/main.js); the file half is not, because `openin_any` turns out not
 * to be enforced for reads, so it is refused here instead.
 *
 * A denylist is a weak instrument and this one does not pretend otherwise —
 * `\csname openin\endcsname` spells its way around it. It is not the only
 * defence, it is the one that costs nothing: what it reliably stops is the
 * plain form of the attack, and what it costs is that a handful of unusual
 * blocks wait for a click. Nothing is refused outright — the Draw button runs
 * whatever the block says, because by then a person has asked for it.
 */
const READS_FILES = /\\(?:openin|openout|read|write|input|include|InputIfFileExists|immediate|special)\b/

/**
 * The reading view's form: the drawing stands where the block does, and draws
 * itself the first time the note is read.
 *
 * A picture is what the block *is* — the reading view is where you go to read
 * the note rather than its source, and a page of TeX with a button on it is
 * neither. Nothing is repeated for it: the drawing is a file in the vault named
 * after a hash of the code, so this costs a TeX run once per block ever written
 * and nothing at all on every reading after that. The button stays for the
 * second go, and for the block that failed.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {HTMLElement} head  the .code-head the Draw button belongs in
 */
export function attachTikz (wrap, head, code, { noteName }) {
  const asks = READS_FILES.test(code)
  const spec = {
    ...tikzSpec(code, noteName),
    kind: 'tikz',
    make: (path) => pictureFor(path),
    // Drawn on sight unless the block asks for the filesystem — see above.
    auto: !asks,
    titles: {
      ...tikzSpec(code, noteName).titles,
      first: asks
        ? 'This picture reads files, so it is not drawn until you ask'
        : 'Draw this picture with TeX'
    }
  }
  attachArtefactBlock(wrap, head, spec)
}
