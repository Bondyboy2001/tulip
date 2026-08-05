/* ================================================= TeX source / PDF split
   A TeX document has two equally important surfaces. This divider owns only
   their proportion; the editor and PDF viewer continue to own their content
   and react to the resulting ResizeObserver notifications themselves.
   ================================================================== */

const DEFAULT_RATIO = 0.5
const MIN_RATIO = 0.15
const MAX_RATIO = 0.85
const NUDGE = 0.02
const NUDGE_FAST = 0.08

const legalRatio = (value) => Math.max(MIN_RATIO, Math.min(MAX_RATIO, value))

/**
 * @param {object} deps
 * @param {HTMLElement} deps.stage
 * @param {HTMLElement} deps.divider
 * @param {HTMLElement} deps.app
 * @param {object} deps.api
 * @returns {{restoreTexSplit: (cfg: object) => void}}
 */
export function mountTexSplit ({ stage, divider, app, api }) {
  let ratio = DEFAULT_RATIO

  divider.setAttribute('aria-valuemin', String(MIN_RATIO * 100))
  divider.setAttribute('aria-valuemax', String(MAX_RATIO * 100))

  const paint = (value) => {
    ratio = legalRatio(Number(value) || DEFAULT_RATIO)
    stage.style.setProperty('--tex-source', `${ratio * 100}%`)
    divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }

  const persist = () => api.config.set({ texSourceRatio: ratio })

  const ratioAt = (clientX) => {
    const box = stage.getBoundingClientRect()
    const usable = Math.max(1, box.width - divider.offsetWidth)
    return legalRatio((clientX - box.left) / usable)
  }

  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    divider.setPointerCapture(event.pointerId)
    divider.classList.add('is-live')
    app.dataset.resizing = 'tex'

    let nextX = event.clientX
    let frame = 0
    let finished = false

    const draw = () => {
      frame = 0
      if (nextX == null) return
      paint(ratioAt(nextX))
      nextX = null
    }
    const move = (moveEvent) => {
      nextX = moveEvent.clientX
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const finish = (finishEvent) => {
      if (finished) return
      finished = true
      // A cancelled pointer can report a synthetic zero coordinate. Keep the
      // last real move in that case; a release has the precise final edge.
      if (finishEvent?.type === 'pointerup') nextX = finishEvent.clientX
      if (frame) cancelAnimationFrame(frame)
      draw()
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', finish)
      divider.removeEventListener('pointercancel', finish)
      divider.classList.remove('is-live')
      delete app.dataset.resizing
      persist()
    }

    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', finish, { once: true })
    divider.addEventListener('pointercancel', finish, { once: true })
  })

  divider.addEventListener('dblclick', (event) => {
    event.preventDefault()
    paint(DEFAULT_RATIO)
    persist()
  })

  divider.addEventListener('keydown', (event) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!direction) return
    event.preventDefault()
    paint(ratio + direction * (event.shiftKey ? NUDGE_FAST : NUDGE))
    persist()
  })

  paint(DEFAULT_RATIO)

  return {
    restoreTexSplit: (cfg = {}) => paint(Number(cfg.texSourceRatio) || DEFAULT_RATIO)
  }
}
