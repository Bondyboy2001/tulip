// @ts-check
/**
 * The stops zoom walks, and the one way to ask which stop a factor is nearest.
 *
 * Named values rather than a continuum because a reader wants the same size
 * back after they change it, not a size near it. The stops themselves live in
 * `electron/zoom-steps.json` so the main process — which owns the window's own
 * zoom and the View menu — reads the same list the renderer draws; a hand-kept
 * second copy is how the PDF reader once ended up with stops the window could
 * not reach.
 *
 * Note: the window itself is not pinched. Two fingers over a note are swallowed
 * in renderer.js and only a document — a PDF, a website — reads the gesture, so
 * what lives here is the vocabulary those readers and the menus share.
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

/**
 * What one wheel event's worth of pinch multiplies a size by.
 *
 * Here rather than in the reader that uses it because the constant *is* the
 * feel of the gesture, and a second document reader added later should pinch
 * like the first one rather than like whatever its author picked.
 */
export const pinchFactor = (deltaY) => Math.exp(-deltaY / 220)
