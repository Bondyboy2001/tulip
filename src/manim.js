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
import { runState, adopt } from './runcode.js'

const api = window.tulip

export function isManim (lang) {
  return String(lang || '').trim().toLowerCase() === 'manim'
}

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

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

/** A line of manim's own output worth showing while it works. */
function lastLine (text) {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line.slice(0, 90)
  }
  return ''
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
  const state = runState()

  const button = el('button', 'run-btn')
  button.type = 'button'

  /* The figure stands where the block does and holds the video; the block is
     kept alongside it, hidden, because "show me the code" has to be one click
     and not a re-render. */
  const figure = el('figure', 'manim')
  figure.hidden = true
  const stage = el('div', 'manim-stage')
  const foot = el('figcaption', 'manim-foot')
  figure.append(stage, foot)
  wrap.after(figure)

  const status = el('div', 'run-out manim-status')
  status.setAttribute('aria-live', 'polite')
  status.hidden = true
  figure.after(status)

  const sceneName = el('span', 'manim-scene')
  const showCode = el('button', 'run-btn')
  showCode.type = 'button'
  showCode.textContent = 'Code'
  showCode.title = 'Show the scene’s source'
  const again = el('button', 'run-btn')
  again.type = 'button'
  again.textContent = 'Re-render'
  again.title = 'Render this scene again'
  foot.append(sceneName, el('span', 'manim-spacer'), showCode, again)

  let videoPath = null
  let codeVisible = true

  /** Which of the two — the film or the source — is on screen. */
  function show (what) {
    codeVisible = what === 'code' || !videoPath
    wrap.hidden = !codeVisible
    figure.hidden = codeVisible
    // The button says where it goes, not where you are.
    showCode.textContent = codeVisible ? 'Video' : 'Code'
    showCode.title = codeVisible ? 'Back to the video' : 'Show the scene’s source'
    showCode.hidden = !videoPath
    // With the film on screen the header is gone and the figure's own footer
    // carries the controls — two Re-render buttons on one block is one too many.
    button.hidden = !codeVisible
  }

  function setVideo (path) {
    videoPath = path
    stage.replaceChildren(videoFor(path))
    sceneName.textContent = scene || ''
    show('video')
    paint()
  }

  const paint = () => {
    const running = state.status === 'running'
    button.classList.toggle('is-running', running)
    button.textContent = running ? 'Stop' : (videoPath ? 'Re-render' : 'Render')
    button.title = running ? 'Stop rendering' : 'Render this scene with Manim'
    button.setAttribute('aria-label', button.title)
    again.disabled = running
    drawStatus()
  }
  state.painters.add(paint)

  function drawStatus () {
    status.replaceChildren()
    if (state.status === 'idle') { status.hidden = true; return }

    const bar = el('div', 'run-out-head')

    if (state.status === 'running') {
      bar.append(el('span', 'run-out-verdict is-running', 'Rendering…'))
      status.append(bar)
      const note = lastLine(state.stdout) || lastLine(state.stderr)
      if (note) status.append(el('pre', 'run-out-stream', note))
      status.hidden = false
      return
    }

    /* No file to show means it did not work, whatever it said on the way — a
       scene that raises exits non-zero with nothing in `error`, and reporting
       only the cases that set one would leave the commonest failure silent. */
    if (!state.path) {
      bar.append(el('span', 'run-out-verdict is-bad',
        state.timedOut ? 'Timed out' : state.signal ? 'Stopped' : 'Failed'))
      status.append(bar)

      const said = state.error || ''
      if (said) status.append(el('pre', 'run-out-stream is-stderr', said))
      // Manim says why on stderr, and that is usually the actual answer.
      const trace = state.stderr.trim()
      if (trace) status.append(el('pre', 'run-out-stream is-stderr', trace.slice(-1500)))
      if (!said && !trace) {
        status.append(el('pre', 'run-out-stream is-stderr', `Manim exited ${state.code}.`))
      }
      status.hidden = false
      return
    }

    // A finished render speaks for itself: the video is the result, and a
    // green "Exit 0" under it would be noise.
    status.hidden = true
  }

  async function render () {
    Object.assign(state, {
      status: 'running',
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      error: null,
      timedOut: false,
      path: null
    })
    show('code')
    state.render()

    try {
      const { id, scene: chosen } = await api.manim.render(noteName, code, scene)
      if (chosen) scene = chosen
      state.id = id
      adopt(id, state)
    } catch (err) {
      const text = String(err?.message || err)
      const at = text.lastIndexOf('Error: ')
      Object.assign(state, { status: 'done', error: at === -1 ? text : text.slice(at + 7) })
      state.render()
    }
  }

  button.addEventListener('click', () => {
    if (state.status === 'running') { api.run.kill(state.id).catch(() => {}); return }
    render()
  })
  again.addEventListener('click', () => { if (state.status !== 'running') render() })
  showCode.addEventListener('click', () => show(codeVisible ? 'video' : 'code'))

  head.append(button)
  paint()

  /* Already rendered? Then the video is what this block is, and the code goes
     behind it — without anything being run. */
  api.manim.lookup(noteName, code, scene)
    .then((hit) => {
      if (!hit || !wrap.isConnected) return
      scene = hit.scene || scene
      setVideo(hit.path)
    })
    .catch(() => {})

  /* When a render finishes it hands back the path it wrote. */
  const finished = () => {
    if (state.status !== 'done') return
    if (state.path) setVideo(state.path)
    else show('code')
  }
  state.painters.add(finished)
}
