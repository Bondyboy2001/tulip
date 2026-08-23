/* The half of the Word viewer that only a browser can answer: what it draws,
 * and what typing into it produces.
 *
 * The reading and the writing are tested without a window in
 * scripts/test-docx.cjs — that is the zip, the XML and the splice. This mounts
 * the viewer between them and asks the two questions that need a real
 * contenteditable to answer: what ended up in the DOM, and what a save would
 * send back after somebody has typed in it. Run from scripts/test-docx-view.mjs.
 */
import { mountDocx } from '../src/docx.js'

const runs = (...items) => items.map((item) =>
  typeof item === 'string' ? { text: item, rpr: '' } : { rpr: '', ...item })

const para = (text, extra = {}) => ({
  type: 'paragraph', runs: runs(text), align: null, list: null, style: '', ppr: '', ...extra
})

/* One document holding every shape the viewer draws, so the assertions below
   are about one page rather than about six. The ranges are made up — nothing
   here splices — but they have to be distinct, because they are what a save
   says "this one is unchanged" with. */
const BLOCKS = [
  { type: 'heading', level: 1, runs: runs('Field notes'), align: null, style: 'Title', ppr: '<w:pPr><w:pStyle w:val="Title"/></w:pPr>', at: [10, 20] },
  { type: 'heading', level: 2, runs: runs('Monday'), align: null, style: 'heading 2', ppr: '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>', at: [20, 30] },
  {
    type: 'paragraph',
    align: 'center',
    list: null,
    style: '',
    ppr: '<w:pPr><w:jc w:val="center"/></w:pPr>',
    at: [30, 40],
    runs: runs(
      { text: 'Warm ', bold: true, rpr: '<w:sz w:val="28"/>' },
      { text: 'and bright', italic: true, underline: true },
      { break: true },
      { text: 'a link', href: 'https://example.com/log', hyper: { id: 'rId9', anchor: '' } },
      { image: { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', alt: 'the paddock', width: 120, height: 60 }, raw: '<w:r><w:drawing/></w:r>' })
  },
  { ...para('quoted'), style: 'Intense Quote', at: [40, 50] },
  { ...para('outer one'), list: { ordered: false, level: 0 }, ppr: '<w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr>', at: [50, 60] },
  { ...para('inner one'), list: { ordered: true, level: 1 }, at: [60, 70] },
  { ...para('inner two'), list: { ordered: true, level: 1 }, at: [70, 80] },
  { ...para('outer two'), list: { ordered: false, level: 0 }, at: [80, 90] },
  { ...para('after the list'), at: [90, 100] },
  {
    type: 'table',
    at: [100, 140],
    props: '<w:tblPr/><w:tblGrid/>',
    rows: [
      { head: true, trpr: '<w:trPr><w:tblHeader/></w:trPr>', cells: [{ blocks: [{ ...para('Day'), at: [102, 106] }], span: 1, continues: false, tcpr: '' }, { blocks: [{ ...para('Rain'), at: [106, 110] }], span: 1, continues: false, tcpr: '' }] },
      {
        head: false,
        trpr: '',
        cells: [
          { blocks: [{ ...para('Mon'), at: [112, 116] }], span: 1, continues: false, tcpr: '' },
          { blocks: [{ ...para('4mm'), at: [116, 120] }], span: 2, continues: false, tcpr: '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' },
          { blocks: [{ ...para(''), at: [120, 124] }], span: 1, continues: true, tcpr: '<w:tcPr><w:vMerge/></w:tcPr>' }
        ]
      }
    ]
  }
]

const document_ = (over = {}) => ({
  ok: true,
  blocks: JSON.parse(JSON.stringify(BLOCKS)),
  words: 12,
  title: 'Field notes, week 12',
  stamp: 'stamp-1',
  body: [5, 400],
  after: 140,
  fragile: [],
  headingStyles: { 1: 'Heading1', 2: 'Heading2', 3: 'Heading3' },
  ...over
})

/** Put the caret in `node`, at a character offset (or across a range of one). */
function caret (node, start, end = start) {
  const range = document.createRange()
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let at = 0
  let done = 0
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const length = text.nodeValue.length
    if (!done && at + length >= start) { range.setStart(text, start - at); done = 1 }
    if (done && at + length >= end) { range.setEnd(text, end - at); done = 2; break }
    at += length
  }
  // An empty paragraph — a cell of a table that has just been made — holds no
  // text node to put a caret in, so the element itself is the caret's home.
  if (!done) { range.selectNodeContents(node); range.collapse(true) }
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  node.focus?.()
}

const chord = (host, key, extra = {}) => host.dispatchEvent(
  new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...extra }))

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

export async function run () {
  const host = document.getElementById('host')
  const opened = []
  const warned = []
  const asked = []
  const writes = []
  let status = ''
  let dirty = null
  let saved = 0
  /* What the stub write answers with. A real save comes back with the document
     as it now stands — one block per item that was sent, at its new place in
     the file — and the page is told where everything now is rather than drawn
     again. This builds that reply out of the items it was given, with every
     offset moved, which is what a real save does to them. */
  let answerWith = (edit) => ({
    ok: true,
    document: {
      ...document_(),
      stamp: 'stamp-2',
      blocks: edit.items.map((item, i) => (item.tbl || item.at?.[0] === 100
        ? { ...BLOCKS[BLOCKS.length - 1], at: [1000 + i * 10, 1005 + i * 10] }
        : { type: 'paragraph', runs: [], align: null, list: null, style: '', ppr: '', at: [1000 + i * 10, 1005 + i * 10] }))
    }
  })
  let fragile = []

  const docx = mountDocx({
    host,
    docx: {
      read: async (path) => (path.endsWith('.docx')
        ? document_({ fragile })
        : { ok: false, error: 'That Word document could not be read.' }),
      write: async (path, edit) => { writes.push({ path, edit }); return answerWith(edit) }
    },
    openExternal: (url) => opened.push(['external', url]),
    ask: async (question) => { asked.push(question); return asked.length < 2 },
    onDirty: (isDirty) => { dirty = isDirty },
    onSaved: () => { saved++ },
    onStatus: (text) => { status = text },
    onWarn: (text) => warned.push(text)
  })

  const result = {}
  const page = () => host.querySelector('.docx-page')

  /* ------------------------------------------------------------ reading */

  window.__stage = 'opening'
  docx.setReadonly(true)
  await docx.open('Notes/Field notes.docx')

  result.headings = [...host.querySelectorAll('.docx-h')].map((h) => `${h.tagName}:${h.textContent}`)
  result.status = status
  result.title = docx.title()
  result.editableWhileReading = page().contentEditable

  const body = host.querySelectorAll('.docx-p')[0]
  result.aligned = body.style.textAlign
  result.emphasis = [...body.querySelectorAll('span')].map((s) => s.className).filter(Boolean)
  result.hasBreak = !!body.querySelector('br')
  result.quoted = !!host.querySelector('.docx-p.is-quote')

  const image = host.querySelector('img.docx-img')
  result.image = image ? { alt: image.alt, width: image.width, height: image.height } : null

  host.querySelector('a.docx-link').dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }))

  const outer = host.querySelectorAll('.docx-page > ul.docx-list')
  result.topLists = outer.length
  result.topItems = outer[0] ? [...outer[0].children].filter((n) => n.tagName === 'LI').length : 0
  result.nested = outer[0]?.querySelector('ol.docx-list') ? 'ol' : ''
  result.nestedInsideItem = outer[0]?.querySelector('li > ol.docx-list') ? 'yes' : 'no'
  result.nestedItems = outer[0]?.querySelectorAll('ol.docx-list > li').length || 0
  result.afterList = host.querySelector('.docx-page > .docx-p:last-of-type')?.textContent || ''

  const table = host.querySelector('table.docx-table')
  result.tableHeaders = [...table.querySelectorAll('thead th')].map((th) => th.textContent)
  result.tableCells = [...table.querySelectorAll('tbody td')].map((td) => td.textContent)
  result.tableSpan = table.querySelector('tbody td:last-child')?.colSpan || 0
  result.tableScrolls = !!table.closest('.docx-table-frame')
  result.text = docx.text().split('\n').slice(0, 3)

  /* ------------------------------------------------------------ editing */

  window.__stage = 'typing'
  docx.setReadonly(false)
  result.editableWhileEditing = page().contentEditable

  // A link is text while the document is being written into.
  host.querySelector('a.docx-link').dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }))
  result.openedWhileEditing = opened.length

  const monday = host.querySelectorAll('.docx-h')[1]
  caret(monday, 6)
  document.execCommand('insertText', false, ' morning')
  await settle()
  result.typed = monday.textContent
  result.dirtyAfterTyping = dirty
  result.wordsAfterTyping = docx.words()

  window.__stage = 'formatting'
  const afterList = [...host.querySelectorAll('.docx-p')].find((p) => p.textContent === 'after the list')
  caret(afterList, 0, 5)
  chord(host, 'b')
  await settle()
  result.bolded = !!afterList.querySelector('.is-bold')
  result.boldedText = afterList.textContent

  window.__stage = 'headings'
  caret(afterList, 1)
  chord(host, '3', { altKey: true })
  await settle()
  const promoted = [...host.querySelectorAll('.docx-h')].find((h) => h.textContent === 'after the list')
  result.promoted = promoted ? promoted.tagName : ''

  window.__stage = 'splitting'
  const quoted = host.querySelector('.docx-p.is-quote')
  caret(quoted, 3)
  host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
  result.split = [...host.querySelectorAll('.docx-p')].map((p) => p.textContent).filter((t) => t.startsWith('quo') || t === 'ted')

  window.__stage = 'a cell'
  const cell = host.querySelector('tbody td')
  caret(cell.querySelector('.docx-p'), 3)
  document.execCommand('insertText', false, 'day')
  await settle()
  result.cellText = cell.textContent

  /* The paragraph holding the picture is edited too, so that the save has to
     put a picture back into a paragraph it rewrote. */
  window.__stage = 'a paragraph with a picture in it'
  caret(body, 4)
  document.execCommand('insertText', false, 'er')
  await settle()
  result.pictureStillDrawn = !!host.querySelector('img.docx-img')

  /* -------------------------------------------------------------- saving */

  window.__stage = 'saving'
  await docx.save({ flush: true })
  const edit = writes[0]?.edit
  result.wrote = writes.length
  result.savedCount = saved
  result.dirtyAfterSave = dirty
  result.stamp = edit?.stamp
  result.kept = edit?.items.filter((item) => item.keep).length
  result.rewritten = edit?.items.filter((item) => item.p).length
  result.newParagraphs = edit?.items.filter((item) => item.p && !item.at).length
  result.itemCount = edit?.items.length

  const rewrittenHeading = edit?.items.find((item) => item.p?.runs.some((r) => r.text?.includes('morning')))
  result.headingKeptItsStyle = rewrittenHeading?.p.ppr || ''
  result.headingKeptItsPlace = rewrittenHeading?.at || null

  const boldItem = edit?.items.find((item) => item.p?.runs.some((r) => r.bold && r.text === 'after'))
  result.boldRun = boldItem ? boldItem.p.runs.map((r) => `${r.bold ? 'b' : ''}${r.text}`) : null
  result.headingStyleWritten = boldItem?.p.ppr || ''

  const listItems = edit?.items.filter((item) => item.keep && item.at[0] >= 50 && item.at[0] < 90).length
  result.listKept = listItems

  const tableItem = edit?.items.find((item) => item.tbl)
  result.tableRewritten = !!tableItem
  result.tableKeptItsGrid = tableItem?.tbl.props || ''
  result.tableCellsKept = tableItem
    ? tableItem.tbl.rows[1].cells.map((cell) => cell.items.every((i) => i.keep))
    : null
  result.mergedCellKept = tableItem ? tableItem.tbl.rows[1].cells.length : 0
  result.pictureCarried = edit?.items.some((item) =>
    item.p?.runs.some((run) => run.raw === '<w:r><w:drawing/></w:r>'))

  /* A second edit, and a second save. The page was not redrawn by the first
     one, so this is where it shows whether it knows where it now is. */
  window.__stage = 'saving again'
  const second = [...host.querySelectorAll('.docx-p')].find((p) => p.textContent === 'after the list' ||
    p.textContent.startsWith('quo'))
  caret(second, 3)
  document.execCommand('insertText', false, '!')
  await settle()
  await docx.save({ flush: true })
  const again = writes[1]?.edit
  result.secondStamp = again?.stamp
  result.secondKept = again?.items.filter((item) => item.keep).length
  result.secondRewritten = again?.items.filter((item) => item.p).length
  result.secondRanges = again?.items.slice(0, 3).map((item) => item.at?.[0])

  /* -------------------------------------------------------------- undo */

  window.__stage = 'undoing'
  const undoable = [...host.querySelectorAll('#host .docx-h')].find((h) => h.textContent.startsWith('Monday'))
  caret(undoable, undoable.textContent.length)
  document.execCommand('insertText', false, ' and Tuesday')
  await settle()
  result.beforeUndo = undoable.textContent
  result.undid = docx.history(false)
  result.afterUndo = [...host.querySelectorAll('#host .docx-h')].find((h) => h.textContent.startsWith('Monday'))?.textContent
  result.redid = docx.history(true)
  result.afterRedo = [...host.querySelectorAll('#host .docx-h')].find((h) => h.textContent.startsWith('Monday'))?.textContent

  /* A run of typing with no pause in it is one change, not one per letter. */
  window.__stage = 'undoing a burst'
  const burst = [...host.querySelectorAll('#host .docx-p')].find((p) => p.textContent.startsWith('quo'))
  caret(burst, burst.textContent.length)
  for (const letter of 'abcdef') {
    document.execCommand('insertText', false, letter)
    await settle()
  }
  result.burstTyped = burst.textContent
  docx.history(false)
  result.afterBurstUndo = [...host.querySelectorAll('#host .docx-p')]
    .map((p) => p.textContent).find((t) => t.startsWith('quo'))

  // And an undo is itself a change: the file has to catch up with it.
  await docx.save({ flush: true })
  result.savedAfterUndo = writes.length

  /* The file was renamed while it was open. The viewer writes back to the path
     it was given, so it has to be told — otherwise the next save goes to a name
     that is no longer there. */
  window.__stage = 'what the bar shows'
  const heading = [...host.querySelectorAll('#host .docx-h')].at(-1)
  caret(heading, 1)
  result.formatHeading = docx.format()
  const bolded = host.querySelector('#host .is-bold')
  caret(bolded, 1)
  result.formatMarks = docx.format().marks
  caret(host.querySelector('#host .docx-li'), 1)
  result.formatList = docx.format().list
  caret(host.querySelector('#host td .docx-p') || host.querySelector('#host .docx-p'), 0)
  result.formatTable = docx.format().table

  window.__stage = 'a rename'
  docx.retarget('Notes/Field notes renamed.docx')
  caret(host.querySelector('#host .docx-p'), 1)
  document.execCommand('insertText', false, '~')
  await settle()
  await docx.save({ flush: true })
  result.wroteTo = writes.at(-1)?.path
  result.noFooter = !host.querySelector('.docx-actions')

  /* --------------------------------------------------- lists and tables */

  window.__stage = 'making a list'
  const plain = [...host.querySelectorAll('#host .docx-p')].find((p) => p.textContent.startsWith('quo'))
  caret(plain, 2)
  await docx.setList('bullet')
  const madeItem = [...host.querySelectorAll('#host .docx-li')].find((li) => li.textContent.startsWith('quo'))
  result.listedInto = madeItem?.parentElement?.tagName
  result.listedJoined = madeItem?.parentElement === host.querySelector('#host ul.docx-list')

  window.__stage = 'and taking it out again'
  /* The same button again, not a different one: asking for the list you are
     already in is asking to leave it, the way it is in Word. */
  caret(madeItem, 2)
  await docx.setList('bullet')
  const backToPlain = [...host.querySelectorAll('#host .docx-p')].find((p) => p.textContent.startsWith('quo'))
  result.unlisted = Boolean(backToPlain) &&
    !backToPlain.dataset.li && backToPlain.parentElement?.classList.contains('docx-page')

  window.__stage = 'a table'
  caret(backToPlain, 2)
  await docx.insertTable(2, 3)
  // The one with no `data-at`: a table that was made rather than read.
  const made = [...host.querySelectorAll('#host .docx-table-frame')].find((f) => !f.dataset.at)
  result.tableShape = made
    ? [made.querySelectorAll('tr').length, made.querySelectorAll('tr')[0].children.length]
    : null
  result.tableHasHeader = !!made?.querySelector('thead th')

  window.__stage = 'a row and a column'
  // Typed into first, so that adding a row has something to lose.
  caret(made.querySelector('thead .docx-p'), 0)
  document.execCommand('insertText', false, 'Kept')
  await settle()
  caret(made.querySelector('tbody .docx-p'), 0)
  await docx.editTable('row')
  await docx.editTable('column')
  const grown = [...host.querySelectorAll('#host .docx-table-frame')].find((f) => !f.dataset.at)
  result.grownShape = [grown.querySelectorAll('tr').length, grown.querySelectorAll('tr')[0].children.length]
  result.grownKept = grown.querySelector('thead th')?.textContent
  result.inTable = docx.inTable()

  await docx.save({ flush: true })
  const made_edit = writes.at(-1)?.edit
  const newTable = made_edit?.items.find((item) => item.tbl && !item.at)
  result.tableWritten = newTable
    ? [newTable.tbl.rows.length, newTable.tbl.rows[0].cells.length]
    : null
  result.tableBordered = /tblBorders/.test(newTable?.tbl.props || '')
  const listItem = made_edit?.items.find((item) => item.p?.runs.some((run) => run.text?.startsWith('quo')))
  result.listPlaceholderGone = !/TULIP_/.test(listItem?.p.ppr || '')

  /* ---------------------------------------------- emptied altogether

     A contenteditable will give up its last paragraph, and Word documents Tulip
     itself had written with an empty body were the result: nothing on the page
     to put a caret in, so every button on the bar did nothing and everything
     typed afterwards was dropped by the next save. */

  window.__stage = 'emptying the document'
  await docx.open('Notes/Field notes.docx')
  docx.setReadonly(false)
  const all = document.createRange()
  all.selectNodeContents(page())
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(all)
  document.execCommand('delete')
  await settle()
  /* And once more, which is what takes the last paragraph itself. */
  page().focus()
  document.execCommand('delete')
  await settle()
  result.emptiedTo = page().children.length
  result.emptiedShape = [...page().children].map((n) => n.tagName)

  document.execCommand('insertText', false, 'typed into nothing')
  await settle()
  result.typedIntoEmpty = page().textContent
  result.typedIntoAParagraph = page().querySelector('.docx-p')?.textContent || ''

  // The bar's commands act on the paragraph the caret is in, so there has to
  // be one for them to reach.
  await docx.setList('bullet')
  result.listedFromEmpty = !!page().querySelector('.docx-li')

  await docx.save({ flush: true })
  const emptied = writes.at(-1)?.edit
  result.emptySaveItems = emptied?.items.length
  result.emptySaveText = emptied?.items.flatMap((item) => item.p?.runs.map((run) => run.text) || []).join('')

  /* An empty paragraph is drawn with a <br> so that it has a height and
     somewhere to put a caret. It is not a line break the document holds, and
     reading it back as one gave every blank line a `w:br` it did not have. */
  window.__stage = 'a blank line'
  await docx.open('Notes/Field notes.docx')
  docx.setReadonly(false)
  const ending = [...host.querySelectorAll('.docx-p')].find((p) => p.textContent === 'after the list')
  caret(ending, ending.textContent.length)
  host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
  await docx.save({ flush: true })
  const blanked = writes.at(-1)?.edit
  const blank = blanked?.items.find((item) => item.p && !item.at)
  result.blankLineRuns = blank ? blank.p.runs.length : -1

  /* ------------------------------------------------- the one question */

  window.__stage = 'the warning'
  fragile = ['fields', 'comments']
  await docx.open('Notes/Field notes.docx')
  docx.setReadonly(false)
  const first = host.querySelector('.docx-p')
  caret(first, 1)
  document.execCommand('insertText', false, '!')
  await settle()
  result.askedOnce = asked.length
  result.askedAbout = asked[0]?.detail || ''
  result.stillEditing = page().contentEditable

  // The second document is refused — `ask` above says no the second time — and
  // a refusal puts the document back into its reading view.
  await docx.open('Notes/Field notes.docx')
  docx.setReadonly(false)
  caret(host.querySelector('.docx-p'), 1)
  document.execCommand('insertText', false, '?')
  await settle()
  await settle()
  result.refusedEditing = page().contentEditable
  result.askedTwice = asked.length

  /* --------------------------------------------------------- and closing */

  window.__stage = 'a second document'
  fragile = []
  await docx.open('Notes/Field notes.docx')
  host.scrollTop = 40
  result.place = docx.place()?.top

  let refused = ''
  try {
    await docx.open('Notes/broken.doc')
  } catch (err) {
    refused = String(err.message)
  }
  result.refused = refused
  result.stillDrawn = host.querySelectorAll('.docx-h').length

  docx.close()
  result.closedTo = host.childElementCount

  result.opened = opened
  result.warned = warned
  return result
}
