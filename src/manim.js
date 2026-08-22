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
import { attachArtefactBlock } from './runcode.js'
import { DRAWN } from './languages.js'

const api = window.tulip

export function isManim (lang) {
  return String(lang || '').trim().toLowerCase() === DRAWN.manim
}

/* Whether a whole `.py` file on the stage is a scene rather than a program.

   A fenced block says so by being fenced ```manim; a source file has to be
   read. Both halves are required and neither is enough alone: importing manim
   is what a helper module does too, and a class called `TitleScene(VGroup)` is
   not a scene. The base test is `/Scene\b/`, character for character what
   `sceneName` in electron/main.js uses — the two have to agree, or Tulip
   offers to render a file that Manim then says has no scene in it. The missing
   boundary at the front is deliberate there and so it is deliberate here:
   `MovingCameraScene` and `ThreeDScene` are both scenes.

   Deliberately not clever about it. A file that both defines scenes and does
   work of its own under `if __name__ == "__main__"` is rare, and the reader
   who has one can still say what they meant by putting the scene in a note. */
const IMPORTS_MANIM = /^[ \t]*(?:from[ \t]+manim(?:\.[\w.]+)?[ \t]+import\b|import[ \t]+manim\b)/m
const SCENE_CLASS = /^[ \t]*class[ \t]+[A-Za-z_]\w*[ \t]*\(([^)]*)\)[ \t]*:/gm

export function isManimSource (code) {
  const text = String(code || '')
  if (!IMPORTS_MANIM.test(text)) return false
  SCENE_CLASS.lastIndex = 0
  for (const found of text.matchAll(SCENE_CLASS)) {
    if (/Scene\b/.test(found[1])) return true
  }
  return false
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
export function videoFor (path) {
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
  /* The shell, the control, the status and the video's place in them are the
     same arrangement a tikz picture stands in, and are runcode's — adopting a
     render already in flight, retiring it once shown, finding one already on
     disk. Only what is below is Manim's.

     No `auto`: a scene is minutes of a machine's attention, and starting that
     because somebody opened a note is not a thing to do to anybody. A picture
     is seconds, and draws itself. */
  attachArtefactBlock(wrap, head, {
    runs,
    key: `${noteName}\n${code}`,
    kind: 'manim',
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
    make: videoFor,
    /* Manim picks the scene out of the block when the block did not name one,
       and says which it picked. Carried back so the next lookup and the next
       render ask about the same scene rather than guessing again. */
    onStarted: (started) => { if (started?.scene) scene = started.scene },
    onFound: (hit) => { scene = hit.scene || scene }
  })
}
