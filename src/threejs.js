/* ================================================================== three
   A ```three block is a scene, and the block is only the interesting part of
   it: no <canvas>, no renderer, no resize handler and no animation loop, which
   is the eighty lines every three.js example spends before it says anything
   about what is being drawn. Tulip writes those, the block writes the scene.

   So the block's page is a page Tulip builds, and from there it is an ```html
   block in every respect — the same sandboxed guest, the same Run/Close
   control in the editing view, the same automatic render in Reading view. See
   guest.js for the sandbox and htmlrun.js for the other fence that uses it.

   The runtime does not travel in the document. three.js is three quarters of a
   megabyte, and a document URL carrying it would be a megabyte of base64 per
   block, re-parsed for every copy on screen; instead the guest fetches it from
   `tulip-file://lib/three.js`, which electron/main.js serves out of the app's
   own dist and which is the only address that partition may ask for besides
   the document itself. Nothing reaches the network — a scene renders the same
   with the machine offline, which is the whole reason the library is bundled
   rather than pulled from a CDN.

   What the scene is handed, and what it may do with it, is `PRELUDE` below.
   ================================================================== */

import { guestFence } from './guest.js'
import { DRAWN, languageId } from './languages.js'
import GUEST_LIBRARY from '../electron/guest-library.json'

export function isThree (lang) {
  return languageId(lang) === DRAWN.three
}

/* The library, at the address main.js answers for this partition alone — one
   spelling, read by both processes, because a mismatch is a blank scene rather
   than a build error. */
const THREE_URL = GUEST_LIBRARY.three

/* A scene is drawn on the note's own paper rather than on a slab of white:
   the guest cannot see the app's stylesheet, so the one colour it needs is
   copied into the document as it is built. Reading view rebuilds a note when
   the palette moves, so a drawn scene follows the theme; an open panel in the
   editing view keeps the paper it was opened on, which is the cheap half of
   the bargain — putting the theme in the block's key instead would close a
   scene the reader was turning over just because the page went dark. */
function surface () {
  const css = getComputedStyle(document.documentElement)
  return css.getPropertyValue('--surface').trim() || '#FFFFFF'
}

/* What every scene starts with, and the whole of the block's vocabulary:

   scene, camera, renderer, controls, lights, timer  — the usual six, built and
   sized and already on the page. The camera stands back from the origin
   looking at it, so a mesh added at 0,0,0 and nothing else is a complete
   block. `controls` is OrbitControls with damping on: a scene is something you
   turn over, and wiring that up by hand in every block is the kind of ceremony
   this fence exists to remove. `lights` is a group, so a scene that wants its
   own lighting says `scene.remove(lights)` and is rid of the defaults in one
   line rather than being stuck with them.

   The loop is the part worth stating carefully. A block that only builds a
   scene still gets one — the default renders every frame and calls a global
   `update(t, dt)` if the block defined one, which is the short way to animate.
   A block that would rather own the loop calls `renderer.setAnimationLoop`
   itself, which is the same one slot, so the default is simply replaced. */
const PRELUDE = `
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 2000)
camera.position.set(3, 2.5, 5)
camera.lookAt(0, 0, 0)

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.append(renderer.domElement)

const controls = new THREE.OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const lights = new THREE.Group()
lights.add(new THREE.AmbientLight(0xFFFFFF, 1.1))
const keyLight = new THREE.DirectionalLight(0xFFFFFF, 2.4)
keyLight.position.set(4, 6, 3)
lights.add(keyLight)
scene.add(lights)

/* Timer rather than the Clock every three.js tutorial reaches for: Clock is
   deprecated as of r185 and says so in the console, which would be the first
   thing a reader of a working block saw. */
const timer = new THREE.Timer()

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

/* The default loop, started before the block runs rather than after it. three
   keeps exactly one animation loop, so a block that calls setAnimationLoop
   simply replaces this one — script order is the whole mechanism, and it
   replaces the flag and the wrapped setter that used to arrange it.

   The update hook is looked up per frame rather than captured, which is what
   lets a block declare it in the script after this one. */
renderer.setAnimationLoop(() => {
  timer.update()
  if (typeof update === 'function') update(timer.getElapsed(), timer.getDelta())
  controls.update()
  renderer.render(scene, camera)
})
`

/* A failed scene says why, in the block's own space. Registered before
   anything else loads, so a missing runtime reports itself the same way a
   typo in the block does — the alternative is an empty black rectangle, which
   says only that something is wrong. */
const REPORTER = `
function tulipFail (message) {
  /* documentElement, not body: a runtime that fails to load fails while the
     parser is still in the head, and there is no body to append to yet. */
  const box = document.getElementById('fail') || (document.body || document.documentElement)
    .appendChild(Object.assign(document.createElement('pre'), { id: 'fail' }))
  box.textContent = String(message)
}
addEventListener('error', (e) => tulipFail(
  e.message || (e.target && e.target.src ? 'Could not load ' + e.target.src : 'Failed')), true)
addEventListener('unhandledrejection', (e) => tulipFail(e.reason))
`

/* The block's own code goes into a <script> of its own rather than inside a
   function: `function update ()` in a block has to become the global the loop
   looks for, and a browser's line numbers in the failure message have to be
   the block's line numbers. The one thing done to it is the standard defusing
   of a `</script` that would otherwise end the element early — legal only
   inside a string, a regex or a comment, where the backslash means nothing. */
const inlineSafe = (code) => code.replace(/<\/(script)/gi, '<\\/$1')

/* The one value the app hands the document, so it is the one value that has to
   be beyond doubt. A colour read out of the app's own stylesheet, and anything
   that is not spelled like one falls back to white rather than being written
   into a rule. */
const cssColor = (value) => (/^[\w#(),.%\s/-]{1,64}$/.test(value) ? value : '#FFFFFF')

/**
 * The whole document for one scene.
 *
 * The scripts stand in the body, not the head: the prelude puts a canvas on
 * the page, and a script in the head runs while `document.body` is still null.
 *
 * @param {string} code   the block's body
 * @param {string} paper  the note's own background colour
 */
export function scenePage (code, paper) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Scene</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: ${cssColor(paper)}; }
  canvas { display: block; }
  #fail {
    position: absolute; inset: auto 0 0 0; margin: 0; padding: 9px 12px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #FFF; background: #8B2233; white-space: pre-wrap;
  }
</style>
<script>${REPORTER}</script>
</head>
<body>
<script src="${THREE_URL}"></script>
<script>${PRELUDE}</script>
<script>
${inlineSafe(code)}
</script>
</body>
</html>`
}

/* Everything else a page-shaped fence is — the state, the Run control, the
   figure in Reading view — is guest.js. This is the part that is three's. */
export const threeFence = guestFence({
  tag: 'three',
  label: '3D scene',
  tips: { run: 'Run this block as a scene', close: 'Close the scene' },
  /* Called only when a guest is really about to exist, which is what keeps the
     colour read and the document build off the render pass for a scene that is
     still below the fold. */
  page: (code) => scenePage(code, surface())
})
