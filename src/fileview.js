/* ============================================================= fileview
   The files the vault holds that Tulip has no view of its own for.

   A vault is a folder on disk, and people put things in folders: the
   photograph a note is about, the recording of the lecture it was taken at,
   the spreadsheet somebody emailed. Every one of them used to be missing from
   its own vault — not in the tree, not in the switcher, not openable — because
   a file Tulip could not *be* was a file it did not admit to.

   So this is the viewer of last resort, and it has three things to say:

   - a picture is shown, fit to the pane and clickable to see it at full size;
   - a recording is played, with the browser's own controls;
   - anything else is described — what it is, how big, when it changed — and
     handed to the desktop, which already has something that can open it.

   What it never does is guess. A `.zip` is not listed and a `.key` is not
   unpacked: a viewer that half-shows a file is worse than one that says
   plainly it cannot show this one and offers the two buttons that can. A
   `.docx` is no longer among them — it has a viewer and an editor of its own
   now, in src/docx.js, which is what having a view of a format rather than a
   guess at it looks like. Text is not here at all — the renderer probes for that at the
   door and gives it to the editor, because a file that reads as text is a file
   worth editing whatever it is called.
   ================================================================== */

import { revealLabel } from './platform.js'
import { el, svgIcon } from './dom.js'
import { assetUrl, assetKind } from './assets.js'
import { fileSize } from './units.js'

const extensionOf = (path) => {
  const name = String(path || '').split('/').pop()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toUpperCase()
}

const when = (ms) => (ms
  ? new Date(ms).toLocaleString(undefined,
    { dateStyle: 'medium', timeStyle: 'short' })
  : '')

/**
 * Mount the viewer into `host`. One instance for the life of the window, like
 * every other viewer here: `open` points it at a file and `close` lets go.
 *
 * @param host      the pane this draws into
 * @param file      the renderer's `api.file` — `probe`, `reveal`, `openDefault`
 * @param onStatus  told what the status bar should say about the open file
 * @param onWarn    told when something the user asked for did not happen
 */
export function mountFileView ({ host, file, onStatus = () => {}, onWarn = () => {} }) {
  let current = null   // { path, kind, size, modified }
  /* The element showing the file, kept so `close` can stop it. A <video> left
     in the DOM with its source set goes on downloading and, worse, goes on
     *playing* — switching tabs away from a recording and still hearing it is
     the bug this variable exists to prevent. */
  let playing = null

  host.classList.add('fileview')

  const wipe = () => {
    if (playing) {
      try { playing.pause() } catch { /* not a player */ }
      // Emptied as well as paused: a source still attached is a download still
      // running for a file nobody is looking at.
      playing.removeAttribute('src')
      try { playing.load() } catch { /* not a player */ }
      playing = null
    }
    host.replaceChildren()
  }

  /** The two things that can always be done with a file, whatever it is. */
  function actions (path) {
    const row = el('div', 'fileview-actions')

    const open = el('button', 'fileview-btn is-primary', 'Open with default app')
    open.type = 'button'
    open.addEventListener('click', async () => {
      const result = await file.openDefault(path)
      if (!result?.ok) onWarn(result?.error || 'The system could not open that file.')
    })

    const reveal = el('button', 'fileview-btn', revealLabel())
    reveal.type = 'button'
    reveal.addEventListener('click', () => { file.reveal(path).catch(() => {}) })

    row.append(open, reveal)
    return row
  }

  /* A picture, fit to the pane. Clicking it swaps between fitting and full
     size — the whole of the zooming this needs, because a picture in a vault is
     being looked at rather than worked on, and anything more is the image
     editor this deliberately is not. */
  function showImage (path) {
    const figure = el('div', 'fileview-image')
    const img = document.createElement('img')
    img.src = assetUrl(path)
    img.alt = path.split('/').pop()
    img.addEventListener('click', () => figure.classList.toggle('is-full'))
    img.addEventListener('error', () => {
      // A picture that will not decode is a file like any other, and the card
      // is the honest thing to show for it.
      wipe()
      showCard(path, 'This picture could not be displayed.')
    })
    figure.append(img)
    host.append(figure, actions(path))
  }

  function showPlayer (path, kind) {
    const player = document.createElement(kind === 'audio' ? 'audio' : 'video')
    player.className = `fileview-player is-${kind}`
    player.src = assetUrl(path)
    player.controls = true
    player.preload = 'metadata'
    player.addEventListener('error', () => {
      wipe()
      showCard(path, 'This file could not be played.')
    })
    playing = player
    host.append(player, actions(path))
  }

  /* What is known about a file that cannot be shown. Said plainly and without
     apology: the name, what kind of thing it is, how big and how old — the four
     facts a file manager would give — and then the two buttons. */
  function showCard (path, trouble = '') {
    const card = el('div', 'fileview-card')
    card.append(svgIcon(
      `<path d="M6.4 2.6h6.6L19 8.6V20a1.6 1.6 0 0 1-1.6 1.6H6.4A1.6 1.6 0 0 1 4.8 20V4.2a1.6 1.6 0 0 1 1.6-1.6z"
         fill="currentColor" opacity=".22"/>
       <path d="M13 2.6 19 8.6h-4.4A1.6 1.6 0 0 1 13 7z" fill="currentColor" opacity=".45"/>`,
      { viewBox: '0 0 24 24', className: 'fileview-mark' }
    ))
    card.append(el('div', 'fileview-name', path.split('/').pop()))

    const extension = extensionOf(path)
    const facts = [
      extension ? `${extension} file` : 'File',
      current?.size ? fileSize(current.size) : '',
      current?.modified ? `changed ${when(current.modified)}` : ''
    ].filter(Boolean)
    card.append(el('div', 'fileview-facts', facts.join(' · ')))
    card.append(el('div', 'fileview-said',
      trouble || 'Tulip has no viewer for this kind of file.'))
    card.append(actions(path))
    host.append(card)
  }

  return {
    /**
     * Show the file at `path`.
     *
     * Resolves once the viewer is on screen rather than once a picture has
     * decoded: the pane is the document, and a slow image loading into it is
     * the same wait as a slow image loading into a note.
     */
    async open (path) {
      wipe()
      const probe = await file.probe(path).catch(() => null)
      current = {
        path,
        kind: assetKind(path),
        size: probe?.size || 0,
        modified: probe?.modified || 0
      }

      /* A file the probe could not even stat is still shown as a card — it is
         in the tree, so something is there, and "could not be read" belongs on
         screen rather than as a toast over the last document. */
      if (!probe?.ok) showCard(path, 'This file could not be read.')
      else if (current.kind === 'image') showImage(path)
      else if (current.kind === 'video' || current.kind === 'audio') {
        showPlayer(path, current.kind)
      } else showCard(path)

      onStatus(this.summary())
      return true
    },

    close () {
      wipe()
      current = null
    },

    focus () { host.focus() },

    /** Nothing here is edited, so there is never anything to save or to lose. */
    dirty: () => false,

    /** What the status bar says: the same facts as the card, for the kinds that
     *  show no card. */
    summary () {
      if (!current) return ''
      const parts = [extensionOf(current.path) ? `${extensionOf(current.path)} file` : 'File']
      if (current.size) parts.push(fileSize(current.size))
      return parts.join(' · ')
    },

    /** What the copilot is told about it. It cannot see the pane, and the path
     *  is the useful half — it has its own tools for reading a file. */
    context () {
      if (!current) return null
      return {
        kind: current.kind === 'file' ? 'file' : current.kind,
        size: current.size
      }
    }
  }
}
