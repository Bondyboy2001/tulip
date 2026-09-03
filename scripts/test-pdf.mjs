import assert from 'node:assert/strict'

import context from '../electron/pdf-context.js'
import {
  PDF_TEXT_FORMAT, formatPdfText, mergeOcrPages, orderLines, sparsePages
} from '../src/pdf-text-layout.js'
import { searchablePage, itemAtOffset, foldCase } from '../src/pdf-search.js'
import { quarter, placeIn, placeAt, hitExtent, flattenOutline } from '../src/pdf.js'

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

const revised = relevantPdfContext('quantum', [{
  path: 'Paper.pdf',
  revision: '123:456',
  pages: parsePages(formatPdfText('Paper.pdf', ['quantum result']))
}])
assert.match(revised, /tulip-pdf-revision:123:456/)

const rareWins = relevantPdfContext('common quasar', [{
  path: 'Weights.pdf',
  pages: parsePages(formatPdfText('Weights.pdf', [
    'common common common common common common',
    'common quasar'
  ]))
}], { maxPages: 1 })
assert.match(rareWins, /Weights\.pdf page 2 of 2/)

/* Substrings are not terms: searching for art must not promote start. */
assert.equal(relevantPdfContext('art', [{
  path: 'Words.pdf',
  pages: parsePages(formatPdfText('Words.pdf', ['we start here', 'modern art theory']))
}], { maxPages: 1 }),
relevantPdfContext('art', [{
  path: 'Words.pdf',
  pages: parsePages(formatPdfText('Words.pdf', ['unrelated', 'modern art theory']))
}], { maxPages: 1 }))

const current = relevantPdfContext('summarize this', [{
  path: 'Book.pdf',
  textPath: '.annotations/Book.pdf.txt',
  openPage: 3,
  pages: parsePages(formatPdfText('Book.pdf', ['one', 'two', 'three', 'four']))
}], { maxPages: 1, maxChars: 2000 })
assert.match(current, /Book\.pdf page 3 of 4/)

/* Context is paid for per question, and a conversation spends a lot of turns
   on questions with nothing to search for. "thanks" must not rank six pages
   of a book: with an open page it carries just that page, and with none it
   carries nothing at all. */
{
  const book = {
    path: 'Book.pdf',
    textPath: '.annotations/Book.pdf.txt',
    openPage: 2,
    pages: parsePages(formatPdfText('Book.pdf', [
      'one', 'two', 'three', 'four', 'five', 'six', 'seven'
    ]))
  }
  const open = relevantPdfContext('ok thanks', [book])
  assert.match(open, /Book\.pdf page 2 of 7/)
  assert.equal((open.match(/--- /g) || []).length, 1, 'a termless follow-up carries one page')
  assert.doesNotMatch(open, /page 4 of 7/, 'and never a ranked spread')

  assert.equal(relevantPdfContext('ok thanks', [{ ...book, openPage: 0 }]), '',
    'a termless question with no open page has nothing to ground it')
}

/* A direct page request selects the sheet number even if its body does not
   repeat that number. */
{
  const pages = Array.from({ length: 45 }, (_, at) => at === 41 ? 'requested sheet' : `ordinary sheet ${at + 1}`)
  const direct = relevantPdfContext('show page 42', [{
    path: 'Long.pdf',
    pages: parsePages(formatPdfText('Long.pdf', pages))
  }], { maxPages: 1 })
  assert.match(direct, /Long\.pdf page 42 of 45/)
  assert.match(direct, /requested sheet/)
}

/* A real question's budget scales with the terms it names: two terms buy a
   few pages, not the whole six-page allowance a long question gets. */
{
  const book = {
    path: 'Book.pdf',
    textPath: '.annotations/Book.pdf.txt',
    pages: parsePages(formatPdfText('Book.pdf', Array.from({ length: 20 }, (_, i) =>
      i < 6
        ? `quantum smoothability garden argument lemma section on page ${i + 1}`
        : `page ${i + 1} of twenty`)))
  }
  const twoTerms = relevantPdfContext('quantum smoothability', [book])
  assert.equal((twoTerms.match(/--- /g) || []).length, 3,
    'two terms buy three pages, not six')
  const manyTerms = relevantPdfContext('compare quantum smoothability with the garden argument from the lemma section', [book])
  assert.ok((manyTerms.match(/--- /g) || []).length <= 6, 'the budget stays capped at six pages')
  assert.ok(manyTerms.length > twoTerms.length, 'a longer question earns a larger excerpt')
}

/* A specific question that has no match must not fill its allowance with the
   first pages of an attached document. The model still receives the sidecar
   path and can search it; sending unrelated prose only spends context. */
{
  const attached = {
    path: 'Unrelated.pdf',
    textPath: '.annotations/Unrelated.pdf.txt',
    pages: parsePages(formatPdfText('Unrelated.pdf', ['gardens', 'orchards', 'trees']))
  }
  assert.equal(relevantPdfContext('quantum smoothability', [attached]), '')

  const grounded = relevantPdfContext('quantum smoothability', [{ ...attached, openPage: 2 }])
  assert.match(grounded, /Unrelated\.pdf page 2 of 3/)
  assert.equal((grounded.match(/--- /g) || []).length, 1)
}

/* "page 42" is a question about a number, and a number is searchable from two
   digits — the old three-letter minimum dropped it, and the question fell back
   to the open page. */
{
  const book = {
    path: 'Book.pdf',
    textPath: '.annotations/Book.pdf.txt',
    openPage: 1,
    pages: parsePages(formatPdfText('Book.pdf', [
      'first page', 'page 42 explained here', 'third page', 'page 4 about nothing'
    ]))
  }
  const byNumber = relevantPdfContext('what about page 42?', [book])
  assert.match(byNumber, /Book\.pdf page 2 of 4/, 'a page number ranks the page that has it')
  assert.match(byNumber, /page 42 explained here/, 'and the page it names is actually in the excerpt')
  /* The open page may co-rank by proximity — the point is the number is no
     longer dropped, so the question is not answered from the wrong page. */
  assert.ok(byNumber.indexOf('page 42 explained here') !== -1)
}

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

/* The viewer's own arithmetic — the parts of src/pdf.js that take numbers and
   return numbers, exported precisely so they can be checked without a browser. */

/* A turn is only ever a quarter, whatever a caller hands over. */
assert.equal(quarter(0), 0)
assert.equal(quarter(90), 90)
assert.equal(quarter(360), 0)
assert.equal(quarter(-90), 270)
assert.equal(quarter(450), 90)
assert.equal(quarter(44), 0)     // rounds to the nearest quarter, not up
assert.equal(quarter(46), 90)

/* Zooming anchors on the page being read, not on a fraction of the whole
   document: the reader a third of the way down page 5 must still be a third of
   the way down page 5 when every page has doubled in height. */
{
  const before = { top: 4000, height: 900 }
  const after = { top: 8000, height: 1800 }
  const place = placeIn(4300, before)
  assert.ok(Math.abs(place.into - 1 / 3) < 1e-9)
  assert.equal(placeAt(place, after), 8600)
  // A degenerate page (height 0, seen mid-teardown) anchors at its top rather
  // than dividing by zero.
  assert.equal(placeAt(placeIn(100, { top: 100, height: 0 }), after), 8000)
  // And a missing place is the top of the page, never NaN.
  assert.equal(placeAt(null, { top: 250, height: 500 }), 250)
}

/* A search hit is boxed to the words, by proportion inside the text item that
   carries them. Items are laid out as searchablePage hands them back: `at` is
   where the item starts in the page's string, `span` how much of it the item
   covers, `x`/`w` where the run sits along the line and `y` its height. */
{
  // One ten-character item, 100 units wide, starting at x=50.
  const items = [{ at: 0, span: 10, x: 50, w: 100, y: 700 }]
  const hit = hitExtent(items, 5, 2)
  assert.equal(hit.y, 700)
  assert.equal(hit.x, 100)         // five of ten characters in → halfway along
  assert.equal(hit.w, 20)          // two of ten characters → a fifth of the run

  // A phrase running from one item into the next on the same line ends where
  // it ends in the second item, not at the first item's edge.
  const twoItems = [
    { at: 0, span: 4, x: 0, w: 40, y: 700 },
    { at: 4, span: 4, x: 44, w: 40, y: 700 }
  ]
  const across = hitExtent(twoItems, 2, 4)
  assert.equal(across.x, 20)
  assert.equal(across.x + across.w, 64)   // two characters into the second item

  // Across a line break, the honest answer is the rest of the first line.
  const twoLines = [
    { at: 0, span: 4, x: 0, w: 40, y: 700 },
    { at: 4, span: 4, x: 0, w: 40, y: 680 }
  ]
  const broken = hitExtent(twoLines, 2, 4)
  assert.equal(broken.y, 700)
  assert.equal(broken.x + broken.w, 40)

  // An item with no geometry — OCR text, a malformed page — declines rather
  // than boxing the wrong place.
  assert.equal(hitExtent([{ at: 0, span: 5, y: 700 }], 1, 2), null)
  assert.equal(hitExtent([], 0, 3), null)
}

/* The outline flattens without touching the worker, keeps each entry's
   destination for lazy resolution, and says so when it truncates instead of
   dropping entries in silence. */
{
  const tree = [
    { title: ' Part One ', dest: 'p1', items: [{ title: 'Chapter 1', dest: [{ num: 3 }] }] },
    { title: '', dest: null }
  ]
  const { entries, truncated } = flattenOutline(tree)
  assert.equal(truncated, false)
  assert.deepEqual(entries.map((e) => [e.title, e.level]), [
    ['Part One', 1], ['Chapter 1', 2], ['Untitled', 1]
  ])
  // Pages are unknown until resolved — null, never a claim of page zero.
  assert.ok(entries.every((e) => e.page === null))
  assert.equal(entries[0].dest, 'p1')

  const deep = [{
    title: 'A',
    dest: 'a',
    items: Array.from({ length: 10 }, (_, i) => ({ title: `A.${i}`, dest: `a${i}` }))
  }]
  const capped = flattenOutline(deep, 4)
  assert.equal(capped.truncated, true)
  assert.equal(capped.entries.length, 4)
}

console.log('pdf extraction and retrieval: all checks passed')
