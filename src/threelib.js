// @ts-check
/* =============================================================== three lib
   The three.js runtime a ```three block draws with, as one file.

   Not part of the renderer's bundle: nothing in the app imports it. It is
   built on its own into `dist/three.js` (see build.mjs) and served to the
   scene's sandboxed guest by electron/main.js, which is the only thing that
   guest may fetch — a block gets three.js from the app it is running in, not
   from a CDN, so a note draws the same with the machine offline.

   OrbitControls travels with it. It lives in three's examples rather than its
   core, so a scene that wanted to be turned over had no way to reach it; here
   it comes out as `THREE.OrbitControls`, which is what threejs.js's prelude
   hands every block.
   ================================================================== */

export * from 'three'
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
