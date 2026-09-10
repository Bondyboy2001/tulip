import assert from 'node:assert/strict'
import electron from 'electron'
import { appSession, delay } from './lib/app-session.mjs'

/* A footnote jump lands with its highlight still on.
 *
 * The wash used to start with the scroll, so a long smooth scroll outlasted
 * it: the reader arrived at an unmarked line. It now waits for the target to
 * stop moving and only then flashes — both ways, ref to definition and back.
 */
const executable = process.argv[2] || electron
const filler = Array(150).fill('Filler paragraph to make the note long enough for a long smooth scroll.\n').join('\n')
const files = {
  'Note.md': '# Compute\n\n' + filler +
    '\nAchieved FLOPS as a percentage of peak.[^2]\n\n' + filler +
    '\n[^2]: There are a lot of ways to count FLOPS in PyTorch now.\n'
}
const app = await appSession({ executable, files, config: { tabs: ['Note.md'], tabIndex: 0 } })

async function state () {
  return app.evaluate(`(() => {
    const reading = document.querySelector('#reading')
    const ref = reading.querySelector('.footnote-ref a')
    const def = reading.querySelector(ref.getAttribute('href'))
    const polaroid = (el) => {
      const box = el.getBoundingClientRect()
      return {
        lit: el.className.includes('is-flash-target'),
        bg: getComputedStyle(el).backgroundColor,
        visible: box.top > -2 && box.bottom < innerHeight + 2
      }
    }
    return { def: polaroid(def), ref: polaroid(ref) }
  })()`)
}

const alpha = (bg) => {
  const m = /\/\s*([\d.]+)\s*\)/.exec(bg || '')
  return m ? Number(m[1]) : 0
}

async function litWhenSettled (which) {
  // A long smooth scroll can take seconds, longer still in a hidden window
  // starved of frames. Poll past all of that: the point under test is that
  // the wash is still on when the target finally arrives.
  for (let i = 0; i < 60; i++) {
    await delay(500)
    const shot = (await state())[which]
    if (shot.lit && shot.visible && alpha(shot.bg) > 0.05) return shot
  }
  return null
}

try {
  await app.evaluate(`window.__tulip.openNote('Note.md')`)
  await delay(800)

  // Forward: the mark to the definition at the foot of the note.
  await app.evaluate(`document.querySelector('#reading .footnote-ref a').click()`)
  assert.ok(await litWhenSettled('def'), 'definition lights up once the scroll settles')

  // The wash is a moment, not part of the page.
  let cleared = false
  for (let i = 0; i < 20; i++) {
    await delay(500)
    if (!(await state()).def.lit) { cleared = true; break }
  }
  assert.ok(cleared, 'definition wash clears again')

  // Back: the return arrow to the mark in the prose.
  await app.evaluate(`document.querySelector('#reading .footnote-backref').click()`)
  assert.ok(await litWhenSettled('ref'), 'reference mark lights up once the scroll settles')

  console.log('footnote flash: forward and back jumps highlight on arrival, then clear')
} finally { await app.dispose() }
