/* ---------------------------------------------------------------- drafts

   A copy of the unsaved buffer, kept outside the vault so that a crash, a
   kill or a power cut cannot take the last few seconds of typing with it. The
   store itself is main's (electron/ipc-drafts.js); this is only about when to
   write one and when to throw it away.

   On a timer of its own rather than on the autosave's: the two exist for
   opposite reasons. The autosave waits, because writing the note on every
   keystroke would make the vault's history and every watcher downstream
   unusable. A draft has no such cost — nothing watches it and nothing syncs
   it — so it runs short and steadily, and the ordinary case is that the real
   save lands first and deletes it before it is ever needed.

   Everything this policy needs to know about the app arrives through
   `makeDrafts`' one argument, so the policy can be tested without an editor:
   `state` for what is open and whether it is dirty; `editor` through a
   function, because the editor is built long after this module runs;
   `canDraft` for the kinds of document a draft makes sense for (a PDF has no
   buffer, a website file holds an address); and `save`/`clear`/`docText` as
   the caller's side of the IPC seam.
   ================================================================== */

const DRAFT_MS = 1200

export function makeDrafts ({ state, editor, canDraft, save, clear, docText }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let draftPath = null
  /* The document last written out, held by identity rather than by its text. A
     `Text` is replaced on every change and shared when there has been none, so
     comparing the object answers "is this the draft already on disk?" without
     building the megabyte string that answering it by value would need — which
     is the very string this exists to avoid producing when nothing has moved. */
  let draftDoc = null

  function queueDraft () {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(writeDraft, DRAFT_MS)
  }

  async function writeDraft () {
    if (timer != null) clearTimeout(timer)
    const path = state.current?.path
    if (!path || !state.dirty || !editor() || !canDraft(path)) return
    const doc = editor().state.doc
    // Already safe, byte for byte. A copy of it across the process boundary
    // would buy nothing, and this fires every 1.2s for as long as typing lasts.
    if (draftPath === path && draftDoc === doc) return
    draftPath = path
    draftDoc = doc
    await save(path, docText(doc)).catch(() => {
      /* Unwritten, so not the draft on disk. Forgetting it here is what lets the
         next tick try again instead of standing down on a write that never
         landed. */
      if (draftDoc === doc) draftDoc = null
    })
  }

  /**
   * Forget the draft for a note whose text is now safely on disk.
   *
   * Takes the path explicitly because the note on screen may already have moved
   * on by the time a save resolves — the draft to drop is the one belonging to
   * the file that was written, not to whatever is being looked at now.
   */
  function clearDraft (path) {
    if (timer != null) clearTimeout(timer)
    if (!path) return
    if (draftPath === path) { draftPath = null; draftDoc = null }
    clear?.(path)
  }

  return { queueDraft, writeDraft, clearDraft }
}
