import assert from 'node:assert/strict'

import context from '../electron/pdf-context.js'
import {
  PDF_TEXT_FORMAT, formatPdfText, mergeOcrPages, orderLines, sparsePages
} from '../src/pdf-text-layout.js'
import { searchablePage, itemAtOffset, foldCase } from '../src/pdf-search.js'

const { ocrPagesOf, parsePages, relevantPdfContext } = context

const line = (text, x, right, y) => ({ text, x, right, y, height: 10 })

const ordered = orderLines([
  line('A two-column title', 0, 100, 100),
  line('left one', 0, 44, 90), line('right one', 56, 100, 90),
  line('left two', 0, 44, 80), line('right two', 56, 100, 80),
  line('left three', 0, 44, 70), line('right three', 56, 100, 70),
  line('left four', 0, 44, 60), line('right four', 56, 100, 60)
])
assert.equal(ordered, [
  'A two-column title', 'left one', 'left two', 'left three', 'left four',
  'right one', 'right two', 'right three', 'right four'
].join('\n'))

const merged = mergeOcrPages(['tiny', 'selectable text that is already longer'], [{
  page: 1,
  lines: [
    { text: 'Recognized heading', x: 0.1, y: 0.9, width: 0.8, height: 0.05 },
    { text: 'Recognized body from the scanned page', x: 0.1, y: 0.8, width: 0.8, height: 0.05 }
  ]
}])
assert.equal(merged.ocrPages, 1)
assert.match(merged.pages[0], /Recognized body/)
assert.deepEqual(sparsePages(['short', 'x'.repeat(100)]), [1])

const sidecar = formatPdfText('Paper.pdf', [merged.pages[0], ''], { ocrPages: 1 })
assert.match(sidecar, new RegExp(`^Tulip-PDF-Text: ${PDF_TEXT_FORMAT}`))
assert.match(sidecar, /Vision OCR on 1 page/)
assert.match(sidecar, /--- page 2 of 2 ---\n\n\[No readable text on this page\.\]/)
assert.equal(parsePages(sidecar).length, 2)

const ranked = relevantPdfContext('Where is quantum smoothability discussed?', [{
  path: 'Paper.pdf',
  textPath: '.annotations/Paper.pdf.txt',
  pages: parsePages(formatPdfText('Paper.pdf', [
    'An introduction about gardens and trees.',
    'The quantum smoothability argument is proved in this section.',
    'A bibliography and acknowledgements.'
  ]))
}], { maxPages: 1, maxChars: 2000 })
assert.match(ranked, /Paper\.pdf page 2 of 3/)
assert.doesNotMatch(ranked, /gardens and trees/)

const current = relevantPdfContext('summarize this', [{
  path: 'Book.pdf',
  textPath: '.annotations/Book.pdf.txt',
  openPage: 3,
  pages: parsePages(formatPdfText('Book.pdf', ['one', 'two', 'three', 'four']))
}], { maxPages: 1, maxChars: 2000 })
assert.match(current, /Book\.pdf page 3 of 4/)

/* The sidecar header states how the text was got, and main.js reads the OCR
   count back out of it rather than scanning the book for the wording. */
assert.equal(ocrPagesOf(formatPdfText('S.pdf', ['a', 'b'], { ocrPages: 2 })), 2)
assert.equal(ocrPagesOf(formatPdfText('S.pdf', ['a', 'b'], { ocrPages: 1 })), 1)
assert.equal(ocrPagesOf(formatPdfText('S.pdf', ['a', 'b'])), 0)

/* The folded page and the page as it is displayed have to agree about where
   everything is: a hit is found in the first and reported as a span of the
   second. `toLowerCase` breaks that for the characters that fold to more than
   one — Turkish İ is the common one — and the drift is silent, so it is
   checked rather than trusted. */
{
  const raw = 'İstanbul and Ankara'
  const { display, search, items } = searchablePage(raw, [{ at: 0, y: 700 }])
  assert.equal(search.length, display.length)
  assert.equal(display, raw)
  assert.equal(search.indexOf('stanbul'), display.indexOf('stanbul'))
  assert.equal(search.indexOf('ankara'), display.indexOf('Ankara'))
  assert.equal(foldCase('İ'), 'i')
  assert.equal(foldCase('ABC').length, 3)
  assert.equal(items[0].at, 0)

  // The offsets a hit is turned into a page position through stay in step too.
  const page = searchablePage('İİİ one', [{ at: 0, y: 700 }, { at: 4, y: 650 }])
  assert.equal(page.search.length, page.display.length)
  assert.equal(itemAtOffset(page.items, page.search.indexOf('one')).y, 650)
}

console.log('pdf extraction and retrieval: all checks passed')
