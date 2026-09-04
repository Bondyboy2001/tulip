/* Streaming seam helpers for the copilot panel.
   Split out of src/copilot.js: pure functions with no panel state, so they can
   be tested and reused without mounting the whole transcript. */

const FENCE = /^\s*(?:```|~~~)/

/**
 * How long the unsettled tail may get before it stops being re-rendered as
 * markdown on every frame. See `settledCut`: a reply that is one long fence
 * has no seam, so past this the tail is plain text until the stream settles.
 */
export const LIVE_TAIL_LIMIT = 4000

/**
 * Where the settled part of a streaming reply ends: the last blank line that
 * is not inside an open fence or an open `$$` block.
 *
 * One forward pass, resumed where the last frame left off. The state rides on
 * the node rather than the message because it describes the text that has
 * been drawn, and the node is what holds the drawing.
 */
export function settledCut (node, text) {
  let scan = node.streamScan
  // A reply that shrank is a reply that was replaced: start the scan over.
  if (!scan || scan.at > text.length) {
    scan = node.streamScan = { at: 0, cut: -1, fenced: false, maths: false }
  }
  for (;;) {
    const stop = text.indexOf('\n', scan.at)
    // The last line is still being typed. Its fences are not counted until it
    // is whole, and nothing after this point can be cut at anyway.
    if (stop === -1) return scan.cut
    const line = text.slice(scan.at, stop)
    if (FENCE.test(line)) {
      scan.fenced = !scan.fenced
    } else if (!scan.fenced) {
      // `$$…$$` on one line toggles twice and so leaves the block closed.
      for (let at = line.indexOf('$$'); at !== -1; at = line.indexOf('$$', at + 2)) {
        scan.maths = !scan.maths
      }
      // A blank line outside both is the seam: the `\n\n` ends one character
      // before this empty line begins.
      if (!line && !scan.maths && scan.at) scan.cut = scan.at - 1
    }
    scan.at = stop + 1
  }
}
