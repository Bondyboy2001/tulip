/*
 * The text layer of a PDF is geometry, not prose. pdf.js returns positioned
 * fragments in an order that is often good enough for one-column pages and
 * visibly wrong for papers with two columns. These helpers turn those
 * fragments (and Vision OCR observations) into one page of reading-order text.
 *
 * Kept free of pdf.js so the ordering, sparse-page handling and sidecar format
 * can be exercised without opening a document.
 */

import PDF_TEXT from '../electron/pdf-text-format.json'

export const PDF_TEXT_FORMAT = PDF_TEXT.version
const MIN_PAGE_TEXT = 80

const median = (numbers) => {
  if (!numbers.length) return 0
  const sorted = [...numbers].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const clean = (value) => String(value || '')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

/** Join positioned glyph runs into visual lines. */
function linesFromItems (items) {
  const runs = (items || []).map((item) => {
    const text = String(item?.str || '')
    const transform = item?.transform || []
    const x = Number(transform[4])
    const y = Number(transform[5])
    const height = Math.abs(Number(item?.height || transform[3] || 0))
    const width = Math.max(0, Number(item?.width || 0))
    return { text, x, y, height, width }
  }).filter((run) => run.text.trim() && Number.isFinite(run.x) && Number.isFinite(run.y))

  const typicalHeight = median(runs.map((run) => run.height).filter((value) => value > 0)) || 10
  const tolerance = Math.max(1.5, typicalHeight * 0.45)
  const rows = []

  for (const run of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = null
    /* Runs are sorted from the top down, so only the newest few rows can share
       this baseline. Avoid an all-rows search for every glyph on dense pages. */
    for (let index = rows.length - 1; index >= 0; index--) {
      const candidate = rows[index]
      if (candidate.y - run.y > tolerance * 2) break
      if (Math.abs(candidate.y - run.y) <= tolerance) { row = candidate; break }
    }
    if (!row) {
      row = { y: run.y, height: run.height || typicalHeight, runs: [] }
      rows.push(row)
    }
    row.runs.push(run)
    row.y = (row.y * (row.runs.length - 1) + run.y) / row.runs.length
    row.height = Math.max(row.height, run.height || 0)
  }

  return rows.map((row) => {
    const ordered = row.runs.sort((a, b) => a.x - b.x)
    let text = ''
    let right = ordered[0]?.x || 0
    for (const run of ordered) {
      const averageGlyph = run.text.length ? run.width / run.text.length : 0
      const gap = run.x - right
      const needsSpace = text && !/\s$/.test(text) && !/^\s/.test(run.text) &&
        gap > Math.max(1.25, averageGlyph * 0.35)
      text += (needsSpace ? ' ' : '') + run.text
      right = Math.max(right, run.x + run.width)
    }
    return {
      text: clean(text),
      x: Math.min(...ordered.map((run) => run.x)),
      right: Math.max(...ordered.map((run) => run.x + run.width)),
      y: row.y,
      height: row.height
    }
  }).filter((line) => line.text)
}

/**
 * Put visual lines into reading order. A convincing two-column page has text
 * on both sides of its midpoint and relatively few lines crossing it. Wide
 * titles and footers stay before/after the columns; wide material inside the
 * body is placed by vertical position rather than discarded.
 */
export function orderLines (lines) {
  const usable = (lines || []).filter((line) => line?.text)
  if (!usable.length) return ''
  const leftEdge = Math.min(...usable.map((line) => Number(line.x) || 0))
  const rightEdge = Math.max(...usable.map((line) => Number(line.right ?? (line.x + (line.width || 0))) || 0))
  const split = (leftEdge + rightEdge) / 2
  /* Relative because pdf.js uses page points while Vision uses 0...1 boxes. */
  const gutter = (rightEdge - leftEdge) * 0.025
  const left = []
  const right = []
  const wide = []

  for (const line of usable) {
    const end = Number(line.right ?? (line.x + (line.width || 0)))
    if (end <= split + gutter) left.push(line)
    else if (Number(line.x) >= split - gutter) right.push(line)
    else wide.push(line)
  }

  const byPage = (a, b) => Number(b.y) - Number(a.y) || Number(a.x) - Number(b.x)
  const twoColumns = left.length >= 3 && right.length >= 3 &&
    left.length + right.length >= usable.length * 0.5
  if (!twoColumns) return clean(usable.sort(byPage).map((line) => line.text).join('\n'))

  /* The shared body starts where both columns have begun and ends where both
     still have content. A logo isolated over the right column is therefore a
     header, not the first line of that column after the entire left side. */
  const bodyTop = Math.min(
    Math.max(...left.map((line) => Number(line.y))),
    Math.max(...right.map((line) => Number(line.y)))
  )
  const bodyBottom = Math.max(
    Math.min(...left.map((line) => Number(line.y))),
    Math.min(...right.map((line) => Number(line.y)))
  )
  const headers = usable.filter((line) => Number(line.y) > bodyTop)
  const footers = usable.filter((line) => Number(line.y) < bodyBottom)
  const leftBody = left.filter((line) => Number(line.y) <= bodyTop && Number(line.y) >= bodyBottom)
  const rightBody = right.filter((line) => Number(line.y) <= bodyTop && Number(line.y) >= bodyBottom)
  const middle = wide.filter((line) => Number(line.y) <= bodyTop && Number(line.y) >= bodyBottom)

  const body = leftBody.sort(byPage).concat(rightBody.sort(byPage), middle.sort(byPage))
  return clean(headers.sort(byPage).concat(body, footers.sort(byPage))
    .map((line) => line.text).join('\n'))
}

export const textFromItems = (items) => orderLines(linesFromItems(items))

/** Vision reports normalized bounding boxes; use the same ordering as pdf.js. */
const textFromOcrLines = (lines) => orderLines((lines || []).map((line) => ({
  text: line.text,
  x: Number(line.x),
  right: Number(line.x) + Number(line.width),
  y: Number(line.y),
  height: Number(line.height)
})))

export const sparsePages = (pages) => (pages || [])
  .map((text, index) => clean(text).length < MIN_PAGE_TEXT ? index + 1 : null)
  .filter(Boolean)

/** Prefer OCR only when it found more than the sparse selectable layer. */
export function mergeOcrPages (pages, ocrPages) {
  const merged = [...(pages || [])]
  let used = 0
  for (const page of ocrPages || []) {
    const index = Number(page.page) - 1
    if (index < 0 || index >= merged.length) continue
    const ocr = textFromOcrLines(page.lines)
    if (!ocr || ocr.length <= clean(merged[index]).length) continue
    merged[index] = ocr
    used++
  }
  return { pages: merged, ocrPages: used }
}

export function formatPdfText (name, pages, { ocrPages = 0 } = {}) {
  const cleaned = (pages || []).map(clean)
  const useful = cleaned.reduce((sum, page) => sum + page.length, 0)
  const method = ocrPages
    ? `selectable text plus Vision OCR on ${ocrPages} page${ocrPages === 1 ? '' : 's'}`
    : 'selectable text'
  const header = `Tulip-PDF-Text: ${PDF_TEXT_FORMAT}\n${name} — ${cleaned.length} page${cleaned.length === 1 ? '' : 's'}, ${method}.`

  if (!useful) {
    return `${header}\n\nTulip could not find readable text in this PDF. The pages may be blank, the scan may be illegible, or OCR may have failed.\n`
  }

  return `${header}\n\n${cleaned.map((page, index) =>
    `--- page ${index + 1} of ${cleaned.length} ---\n\n${page || '[No readable text on this page.]'}\n`
  ).join('\n')}`
}
