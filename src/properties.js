/* ============================================================= properties
   Frontmatter stays in the file and remains visible in Raw view, but is hidden
   from the ordinary editing surface so a note begins with its prose. File
   keywords are separate metadata managed by the Info pane; this module only
   owns that editing-view curtain.
   ================================================================== */

import { StateField } from '@codemirror/state'
import { EditorView, Decoration } from '@codemirror/view'
import { parseFrontmatter } from '../electron/frontmatter.cjs'
import { docText } from './math.js'

/**
 * The head, hidden.
 *
 * Nothing is drawn in its place: the properties are in the Info pane, and a
 * note reads as the note. It is still in the file and still what Raw view and
 * anything reading the note off disk sees — this is a curtain, not a delete.
 */
function buildDecorations (state) {
  const parsed = parseFrontmatter(docText(state.doc))
  if (!parsed.range) return Decoration.none
  /* Through the end of the closing fence line, newline included, so the note
     starts where the head stopped rather than under a leftover empty line —
     except when that newline is the last thing in the document, where keeping
     it out leaves the trailing empty line to hold the cursor. */
  const last = state.doc.lineAt(Math.min(parsed.range.end - 1, state.doc.length))
  const withFence = Math.min(last.to + 1, state.doc.length)
  const to = withFence < state.doc.length ? withFence : last.to
  /* Never the whole document: a replacement covering every line leaves the
     editor with nothing to put a cursor in — a note that is only frontmatter
     shows its head as text rather than becoming an empty page. */
  if (to >= state.doc.length) return Decoration.none
  return Decoration.set([Decoration.replace({ block: true }).range(0, to)])
}

/* The field, recomputed per document change. The head of a note is tiny next
   to the note, and `docText` hands back the one cached string the other
   doc-derived work (equations, money) already shares. */
const propertiesField = StateField.define({
  create: buildDecorations,
  update (deco, tr) {
    return tr.docChanged ? buildDecorations(tr.state) : deco
  },
  provide: (field) => EditorView.decorations.from(field)
})

/** The head hidden in the editing view. Named for the config it sits in — the
 *  rendered extensions, which Raw view turns off, and turning it off is how the
 *  YAML comes back. */
export const propertiesPreview = [propertiesField]
