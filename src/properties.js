/* ============================================================= properties
   A note's frontmatter, edited as a form.

   The panel does not stand in the note. It used to: the head was replaced in
   the editing view by the rows below, which put a grey form at the top of a
   page of prose and made every note that had two properties look like a
   settings screen. The head is hidden in the note now — still in the file,
   still the first thing Raw view shows — and the form lives in the sidebar's
   Info pane beside the file's own facts, which is where a thing *about* the
   note belongs rather than in it.

   Typed rows, one per property, plus whatever went over the flat grammar's
   head, shown but uneditable (Raw view is where such a line belongs; offering
   it here half-parsed would corrupt it).

   The write-back model is the one the settings rows and the title field
   already use: nothing is written per keystroke, an edit commits when the
   field is left (blur, Enter; Escape restores). Every commit is one ordinary
   edit of the document's head — undoable with ⌘Z like everything typed — and
   the document is re-read at that moment rather than trusting the range the
   panel was built against, because the note may have moved underneath.

   The grammar the entries round-trip through is electron/frontmatter.cjs —
   the same module the search's `prop:` filter reads, so the two cannot
   disagree about what a note's properties are.
   ================================================================== */

import { StateField } from '@codemirror/state'
import { EditorView, Decoration } from '@codemirror/view'
import { parseFrontmatter, serializeFrontmatter, scalarText } from '../electron/frontmatter.cjs'
import { el as node } from './blocks.js'
import { languageTableMode } from './table.js'
import { docText } from './math.js'

/**
 * The one piece of frontmatter exposed in the sidebar: tags.
 *
 * Other YAML remains exactly where it was and is still available to citations,
 * language tables, search and Raw view. It is deliberately not turned into a
 * settings form here; the sidebar only offers the lightweight file labelling
 * the reader asked for.
 */
export function tagsPanel (view, { onCommit } = {}) {
  const parsedAtBuild = parseFrontmatter(docText(view.state.doc))
  const tagEntry = parsedAtBuild.entries.find((entry) =>
    entry.key?.toLowerCase() === 'tags')
  const tags = (Array.isArray(tagEntry?.value)
    ? tagEntry.value
    : tagEntry?.value == null ? [] : [tagEntry.value])
    .map(scalarText)
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean)

  /* Re-read on every write so a tag action cannot overwrite an edit that
     moved or changed the head after this panel was drawn. Only the tags entry
     is marked changed; serializeFrontmatter carries every neighbour verbatim. */
  const commit = (nextTags) => {
    const text = docText(view.state.doc)
    const parsed = parseFrontmatter(text)
    const entries = parsed.entries.map((entry) => ({ ...entry }))
    const at = entries.findIndex((entry) => entry.key?.toLowerCase() === 'tags')
    if (nextTags.length) {
      const next = {
        key: at === -1 ? 'tags' : entries[at].key,
        value: nextTags,
        type: 'text',
        list: true,
        raw: at === -1 ? '' : entries[at].raw,
        changed: true
      }
      if (at === -1) entries.push(next)
      else entries[at] = next
    } else if (at !== -1) {
      entries.splice(at, 1)
    }
    const block = serializeFrontmatter(entries)
    let from = 0
    let to = 0
    if (parsed.range) {
      const last = view.state.doc.lineAt(Math.min(parsed.range.end - 1, view.state.doc.length))
      to = Math.min(last.to + 1, view.state.doc.length)
    }
    /* A head that comes back empty takes the container with it:
       a `---\n---` head is junk, not intent. */
    view.dispatch({
      changes: { from, to, insert: block },
      userEvent: 'input.tags',
      scrollIntoView: false
    })
    onCommit?.()
  }

  const wrap = node('div', 'tags-editor')
  const chips = node('div', 'tags-chips')

  for (const [index, tag] of tags.entries()) {
    const chip = node('span', 'tag-chip')
    chip.append(node('span', 'tag-chip-label', `#${tag}`))
    const remove = node('button', 'tag-chip-remove', '×')
    remove.type = 'button'
    remove.title = `Remove #${tag}`
    remove.setAttribute('aria-label', `Remove tag ${tag}`)
    remove.addEventListener('click', () => commit(tags.filter((_tag, at) => at !== index)))
    chip.append(remove)
    chips.append(chip)
  }

  const input = node('input', 'tag-input')
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = 'Add tag…'
  input.setAttribute('aria-label', 'Add tag')

  const add = () => {
    const fresh = input.value.trim().replace(/^#+/, '')
    if (!fresh) return false
    input.value = ''
    if (tags.some((tag) => tag.toLowerCase() === fresh.toLowerCase())) return false
    commit([...tags, fresh])
    return true
  }
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add()
    } else if (event.key === 'Backspace' && !input.value && tags.length) {
      event.preventDefault()
      commit(tags.slice(0, -1))
    } else if (event.key === 'Escape') {
      event.preventDefault()
      input.value = ''
      view.focus()
    }
  })
  input.addEventListener('blur', add)

  wrap.append(chips, input)
  return wrap
}

/**
 * The head, hidden.
 *
 * Nothing is drawn in its place: the properties are in the Info pane, and a
 * note reads as the note. It is still in the file and still what Raw view and
 * anything reading the note off disk sees — this is a curtain, not a delete.
 */
function buildDecorations (state) {
  /* A language document's head is the table's settings, and `table.js` hides it
     already — see `frontmatterLines` there. Two block replacements over the
     same lines, from two fields, is a range conflict, so the grid's answer wins
     and this one stands down. */
  if (state.facet(languageTableMode)()) return Decoration.none

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
    const retuned = tr.startState.facet(languageTableMode) !== tr.state.facet(languageTableMode)
    return tr.docChanged || retuned ? buildDecorations(tr.state) : deco
  },
  provide: (field) => EditorView.decorations.from(field)
})

/** The head hidden in the editing view. Named for the config it sits in — the
 *  rendered extensions, which Raw view turns off, and turning it off is how the
 *  YAML comes back. */
export const propertiesPreview = [propertiesField]
