/* ================================================================ manim
   A ```manim block is a scene, and the point of a scene is the film. So the
   reading view shows the video where the code was, and the code is a thing you
   ask for rather than the thing you are given.

   The video is a real file in the vault, next to the note's other attachments
   — not an ephemeral result like the Run control's output. That is deliberate:
   a render costs minutes, so it has to survive quitting Tulip, and a video is
   an artefact of the note in a way that a line of stdout is not. The .md itself
   is still never written to; the block stays the source of truth and the file
   beside it is derived from it.

   Which file, is decided by a hash of the code (see manimTarget in
   electron/main.js). Same block, same filename — so a note that has been
   rendered opens with its videos already in place, and an edited block asks for
   a name nothing has written yet, which is exactly when re-rendering is right.
   ================================================================== */

import { embedSpec, renderEmbed } from './assets.js'
import { renderedBlock } from './blocks.js'
import { artefactRun } from './runcode.js'

const api = window.tulip

export function isManim (lang) {
  return String(lang || '').trim().toLowerCase() === 'manim'
}

/* Renders in flight, keyed by note and code — the same bargain runcode's
   `results` map strikes. A per-attach state stranded the render whenever the
   reading view was rebuilt under it — a note switch and back, mid-render —
   because the fresh attach's lookup ran before the file existed: the block
   said "Render" while Manim worked on unseen, and the finished film never
   appeared. A rebuilt block adopts the run instead. Entries are retired once
   the run has settled and been shown. */
const runs = new Map()

/* The video for a path we have just been handed. Going through embedSpec keeps
   one decision about what an .mp4 in this vault becomes, shared with every
   other embed — the resolver is trivial here only because main already answered
   the question resolution exists to answer. */
function videoFor (path) {
  const video = renderEmbed(embedSpec(path, { resolve: () => path }))

  /* A scene almost always *builds* to its picture, so frame zero is a black
     rectangle and a note full of scenes reads as a note full of empty boxes.
     Parking on the last frame shows what the scene made.

     Seeking to exactly the duration is what makes this safe: the element is
     then "ended", and play() is specified to rewind to the start from there —
     so the still costs nothing at playback time. */
  video.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = video.duration
    }
  }, { once: true })

  return video
}

/**
 * Fits one `manim` block with its render control, and swaps in the video
 * whenever there is one to show.
 *
 * @param {HTMLElement} wrap  the .code-wrap holding the source
 * @param {HTMLElement} head  the .code-head the control belongs in
 * @param {string} code       the scene's source
 * @param {{noteName: string, scene: string}} ctx
 */
export function attachManim (wrap, head, code, { noteName, scene }) {
  /* The shared rendered-block shell puts the video where the source was and
     yields the whole space to the transcript while Manim works. */
  const view = renderedBlock(wrap, 'manim')

  /* The same control a runnable block and a tikz picture get: starting a render
     and stopping one is the run gesture, and the machinery behind it — adopting
     a render already in flight, retiring it once shown, finding one already on
     disk — is runcode's, not this file's. Only the words and the two api calls
     are Manim's. */
  const run = artefactRun(runs, `${noteName}\n${code}`, {
    statusClass: 'manim-status',
    words: {
      busy: 'Rendering…',
      keep: 1500,
      // A first render replaces the source with Manim's complete live output;
      // unlike a quick drawing, the minutes of work are useful to watch.
      transcript: true,
      // Manim says why on stderr, and that is usually the actual answer.
      silent: (s) => `Manim exited ${s.code}.`
    },
    titles: {
      stop: 'Stop rendering',
      again: 'Render this scene again',
      first: 'Render this scene with Manim'
    },
    start: () => api.manim.render(noteName, code, scene),
    lookup: () => api.manim.lookup(noteName, code, scene),
    /* A render that ends hands back the path it wrote, and the video takes the
       transcript's place. With no path, onPath deliberately does nothing so
       the full failure remains visible. */
    onPath: (path) => {
      if (!path) return
      view.stage.replaceChildren(videoFor(path))
      view.settle(true)
    },
    // The reading view can be rebuilt under a render — a note switch and back —
    // and a lookup landing afterwards must not write into the detached copy.
    alive: () => wrap.isConnected,
    // A fresh attachment can adopt a render started by the previous reading
    // view, so the transcript mode is also asserted by every live paint.
    onPaint: (state) => { if (state.status === 'running') view.hide() },
    // The transcript takes the block's place while Manim works. If no video is
    // produced it remains there with the full failure instead of snapping back
    // to source and hiding the useful part.
    willStart: view.hide,
    /* Manim picks the scene out of the block when the block did not name one,
       and says which it picked. Carried back so the next lookup and the next
       render ask about the same scene rather than guessing again. */
    didStart: (started) => { if (started?.scene) scene = started.scene },
    onHit: (hit) => { scene = hit.scene || scene }
  })

  view.figure.after(run.status)
  head.append(run.button)
}
