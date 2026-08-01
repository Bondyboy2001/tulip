/**
 * The stops zoom walks, and the one way to ask which stop a factor is nearest.
 *
 * Named values rather than a continuum because a reader wants the same size
 * back after they change it, not a size near it. The stops themselves live in
 * `electron/zoom-steps.json` so the main process — which owns the window's own
 * zoom and the View menu — reads the same list the renderer draws; a hand-kept
 * second copy is how the PDF reader once ended up with stops the window could
 * not reach.
 */

import { steps as ZOOM_STEPS, start as DEFAULT_ZOOM } from '../electron/zoom-steps.json'

export { ZOOM_STEPS, DEFAULT_ZOOM }

/** The index of the stop closest to `factor`, for stepping in or out from a
 *  size that need not be a stop itself (fit-to-width, a restored session). */
export const nearestStep = (factor) => ZOOM_STEPS.reduce(
  (best, step, i) => (Math.abs(step - factor) < Math.abs(ZOOM_STEPS[best] - factor) ? i : best),
  0
)

/** Step `direction` stops from `factor`, staying inside the list. */
export const stepZoom = (factor, direction) =>
  ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, nearestStep(factor) + direction))]
