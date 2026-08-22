/**
 * Reading a Word document.
 *
 * The fixture is built here rather than checked in: a `.docx` is a zip, and a
 * binary in the repo is a fixture nobody can read a diff of. Building it also
 * means the zip reader is tested against bytes this file wrote by hand from
 * the format, rather than against whatever Word happened to emit the day
 * somebody saved the fixture.
 *
 *   node scripts/test-docx.cjs
 */
const { deflateRawSync } = require('node:zlib')
const { readDocxBuffer, writeDocxBuffer, blankDocxBuffer } = require('../electron/docx')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------ a zip, by hand */

const CRC = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return (buf) => {
    let c = -1
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()

/** @param entries {[name: string, body: Buffer | string, stored?: boolean][]} */
function makeZip (entries) {
  const locals = []
  const central = []
  let at = 0

  for (const [name, body, stored] of entries) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    const data = stored ? raw : deflateRawSync(raw)
    const nameBytes = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(CRC(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(stored ? 0 : 8, 10)
    entry.writeUInt32LE(CRC(raw), 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(at, 42)
    central.push(entry, nameBytes)

    at += local.length + nameBytes.length + data.length
  }

  const body = Buffer.concat(locals)
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}

/* --------------------------------------------------------- a document, by hand */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Field &amp; Notes</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Monday</w:t></w:r></w:p>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Warm </w:t></w:r>
      <w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>and bright</w:t></w:r>
      <w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>.</w:t></w:r>
      <w:r><w:br/></w:r>
      <w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>1</w:t></w:r>
    </w:p>
    <w:hyperlink r:id="rId9"><w:r><w:t>the log</w:t></w:r></w:hyperlink>
    <w:p><w:hyperlink r:id="rId9"><w:r><w:t>the log</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>first</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>a bullet</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:trPr><w:tblHeader/></w:trPr>
        <w:tc><w:p><w:r><w:t>Day</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Rain</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Mon</w:t></w:r></w:p></w:tc>
        <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>4mm</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="952500"/>
      <wp:docPr id="1" name="Picture 1" descr="the paddock"/>
      <a:graphic><a:graphicData><a:blip r:embed="rId4"/></a:graphicData></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>
    <w:p><w:del><w:r><w:t>struck out</w:t></w:r></w:del></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId4" Type="…/image" Target="media/paddock.png"/>
  <Relationship Id="rId9" Type="…/hyperlink" Target="https://example.com/log" TargetMode="External"/>
</Relationships>`

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="8"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="8"/></w:num>
</w:numbering>`

const CORE = `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="…" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Field notes, week 12</dc:title>
</cp:coreProperties>`

const FILE = makeZip([
  ['[Content_Types].xml', '<Types/>', true],
  ['word/document.xml', DOCUMENT],
  ['word/_rels/document.xml.rels', RELS],
  ['word/styles.xml', STYLES],
  ['word/numbering.xml', NUMBERING],
  ['word/media/paddock.png', PNG, true],
  ['docProps/core.xml', CORE]
])

/** The `word/document.xml` inside a `.docx`, for the checks that are about
 *  bytes rather than about blocks. */
const unzipText = (bytes) => require('../electron/docx').unzip(bytes).get('word/document.xml').toString('utf8')

const doc = readDocxBuffer(FILE)
const blocks = doc.blocks
const runText = (block) => (block.runs || []).map((r) => r.text || (r.break ? '\n' : '')).join('')

/* ------------------------------------------------------------------ the read */

check('the styled paragraphs come back as headings',
  blocks[0].type === 'heading' && blocks[0].level === 1 &&
  blocks[1].type === 'heading' && blocks[1].level === 2,
  JSON.stringify(blocks.slice(0, 2).map((b) => [b.type, b.level])))

check('an entity in the text is decoded', runText(blocks[0]) === 'Field & Notes', runText(blocks[0]))

const body = blocks[2]
check('emphasis is read off each run',
  body.runs[0].bold === true && body.runs[1].italic === true && body.runs[1].underline === true,
  JSON.stringify(body.runs))
check('w:val="0" turns a toggle off rather than on', !body.runs[2].bold)
check('xml:space="preserve" keeps the space it was written for',
  body.runs[0].text === 'Warm ', JSON.stringify(body.runs[0].text))
check('alignment survives', body.align === 'center', String(body.align))
check('a break is a run of its own', body.runs.some((r) => r.break === true))
check('superscript is carried', body.runs.at(-1).vert === 'sup', JSON.stringify(body.runs.at(-1)))

const linked = blocks.find((b) => b.runs?.some((r) => r.href))
check('a hyperlink lands on the runs inside it',
  linked && linked.runs[0].href === 'https://example.com/log' && linked.runs[0].text === 'the log',
  JSON.stringify(linked))

const list = blocks.filter((b) => b.list)
check('a numbered list is told from a bulleted one',
  list.length === 2 && list[0].list.ordered === true && list[1].list.ordered === false,
  JSON.stringify(list.map((b) => b.list)))

const table = blocks.find((b) => b.type === 'table')
check('the table comes back as rows of cells',
  table && table.rows.length === 2 && table.rows[0].cells.length === 2 &&
  table.rows[0].cells[0].blocks[0].runs[0].text === 'Day',
  JSON.stringify(table && table.rows.map((r) => r.cells.length)))
check('a header row says so', table.rows[0].head === true && table.rows[1].head === false)
check('a merged cell keeps its span', table.rows[1].cells[1].span === 2)

const picture = blocks.flatMap((b) => b.runs || []).find((r) => r.image)
check('the picture arrives as data, sized in pixels',
  picture && picture.image.src.startsWith('data:image/png;base64,') &&
  picture.image.width === 200 && picture.image.height === 100,
  JSON.stringify(picture && { ...picture.image, src: picture.image.src.slice(0, 24) }))
check('and keeps the alt text Word recorded', picture.image.alt === 'the paddock')

check('deleted text is not in the document',
  !blocks.some((b) => (b.runs || []).some((r) => (r.text || '').includes('struck out'))))

check('empty runs are dropped',
  blocks.every((b) => !(b.runs || []).some((r) => !r.break && !r.image && !r.text)))

check('the word count counts the words',
  doc.words === 16, String(doc.words))

check('the document title is read from its properties',
  doc.title === 'Field notes, week 12', doc.title)

/* ------------------------------------------------------------ writing it back

   The whole of the fidelity argument: a save splices. What was not edited goes
   back as the bytes it arrived as, so the checks below are as much about what
   the file still holds as about what changed in it. */

const items = doc.blocks.map((block) => ({ at: block.at, keep: true }))
const edited = items.map((item, i) => (i === 1
  ? { at: doc.blocks[1].at, p: { ppr: doc.blocks[1].ppr, runs: [{ text: 'Tuesday', rpr: '' }] } }
  : item))

const saved = readDocxBuffer(writeDocxBuffer(FILE, {
  stamp: doc.stamp, body: doc.body, after: doc.after, items: edited
}))

check('the paragraph that was edited says what it was given',
  saved.blocks[1].runs[0].text === 'Tuesday', runText(saved.blocks[1]))
check('and is still the heading it was',
  saved.blocks[1].type === 'heading' && saved.blocks[1].level === 2,
  `${saved.blocks[1].type} ${saved.blocks[1].level}`)
check('every other block is still there, in order',
  saved.blocks.length === doc.blocks.length &&
  saved.blocks.map((b) => b.type).join() === doc.blocks.map((b) => b.type).join(),
  saved.blocks.map((b) => b.type).join())
check('the picture survives a save it had nothing to do with',
  saved.blocks.flatMap((b) => b.runs || []).some((r) => r.image?.src.startsWith('data:image/png')))
/* Compared without `at`: every offset in the file moves when a paragraph
   above it changes length, and where it is is not what the table says. */
const withoutRange = (block) => JSON.stringify(block, (key, value) => (key === 'at' ? 0 : value))
check('and so does the table',
  withoutRange(saved.blocks.find((b) => b.type === 'table')) ===
  withoutRange(doc.blocks.find((b) => b.type === 'table')))

/* A paragraph the reader deleted is one that is not in the items. It has to be
   gone from the file, and not quietly carried back as "what lay between" the
   two paragraphs that were on either side of it. */
const shorter = readDocxBuffer(writeDocxBuffer(FILE, {
  stamp: doc.stamp,
  body: doc.body,
  after: doc.after,
  items: items.filter((_, i) => i !== 1)
}))
check('a paragraph left out of a save is gone from the file',
  shorter.blocks.length === doc.blocks.length - 1 &&
  !shorter.blocks.some((b) => runText(b) === 'Monday'),
  shorter.blocks.map((b) => runText(b)).join(' | '))

/* The bytes, not the reading: a paragraph nobody touched must come back
   character for character, or "spliced" is a claim rather than a fact. */
const before = unzipText(FILE)
const after = unzipText(writeDocxBuffer(FILE, {
  stamp: doc.stamp, body: doc.body, after: doc.after, items: edited
}))
check('an untouched paragraph is put back byte for byte',
  after.includes(before.slice(doc.blocks[5].at[0], doc.blocks[5].at[1])),
  'the list item was rewritten')
check('and so is everything outside the body',
  after.slice(0, doc.body[0]) === before.slice(0, doc.body[0]))
check('the section properties are kept, and kept once',
  after.split('<w:sectPr').length === 2, String(after.split('<w:sectPr').length - 1))

/* What a rewritten paragraph carries: the run properties it did not
   understand, and the toggles it does — in the order the schema states. */
const styled = readDocxBuffer(writeDocxBuffer(FILE, {
  stamp: doc.stamp,
  body: doc.body,
  after: doc.after,
  items: [{
    at: doc.blocks[2].at,
    p: {
      ppr: doc.blocks[2].ppr,
      runs: [
        { text: 'Bright', rpr: '<w:rFonts w:ascii="Georgia"/><w:sz w:val="28"/>', bold: true, italic: true },
        { break: true, rpr: '' },
        { text: 'and away', rpr: '', vert: 'sup', hyper: { id: 'rId9', anchor: '' } }
      ]
    }
  }, ...items.slice(3)]
}))
const kept = styled.blocks[0].runs
check('a rewritten run keeps the formatting Tulip does not model',
  kept[0].rpr.includes('Georgia') && kept[0].rpr.includes('w:sz'), kept[0].rpr)
check('and gains the toggles it was given', kept[0].bold === true && kept[0].italic === true)
check('a break survives being written', kept.some((r) => r.break))
check('a link is put back inside the hyperlink it came from',
  kept.at(-1).href === 'https://example.com/log' && kept.at(-1).vert === 'sup',
  JSON.stringify(kept.at(-1)))

const rpr = unzipText(writeDocxBuffer(FILE, {
  stamp: doc.stamp,
  body: doc.body,
  after: doc.after,
  items: [{ p: { ppr: '', runs: [{ text: 'x', rpr: '<w:rFonts w:ascii="Georgia"/><w:sz w:val="28"/>', bold: true, underline: true }] } }]
}))
check('run properties come out in the order the schema states them in',
  /<w:rPr><w:rFonts[^>]*\/><w:b\/><w:sz[^>]*\/><w:u[^>]*\/><\/w:rPr>/.test(rpr),
  rpr.slice(rpr.indexOf('<w:rPr>'), rpr.indexOf('</w:rPr>') + 8))

check('a tab is written as a tab rather than swallowed',
  unzipText(writeDocxBuffer(FILE, {
    stamp: doc.stamp, body: doc.body, after: doc.after, items: [{ p: { ppr: '', runs: [{ text: 'a\tb' }] } }]
  })).includes('<w:tab/>'))

check('a save written against a document that has since changed is refused', (() => {
  try {
    writeDocxBuffer(FILE, { stamp: 'something else', body: doc.body, after: doc.after, items })
    return false
  } catch (err) {
    return /changed on disk/.test(err.message)
  }
})())

/* ------------------------------------------------------------ making a list

   The page cannot name a numbering — a document with no lists in it has no
   numbering part at all — so it writes a placeholder and the save resolves it
   against the document being written into. */

const { LIST_PLACEHOLDER } = require('../electron/docx')
const numPr = (sort) => '<w:pPr><w:numPr><w:ilvl w:val="0"/>' +
  `<w:numId w:val="${LIST_PLACEHOLDER[sort]}"/></w:numPr></w:pPr>`

const listed = readDocxBuffer(writeDocxBuffer(blankDocxBuffer(), (() => {
  const empty = readDocxBuffer(blankDocxBuffer())
  return {
    stamp: empty.stamp,
    body: empty.body,
    after: empty.after,
    items: [
      { p: { ppr: numPr('bullet'), runs: [{ text: 'one' }] } },
      { p: { ppr: numPr('bullet'), runs: [{ text: 'two' }] } },
      { p: { ppr: numPr('ordered'), runs: [{ text: 'first' }] } }
    ]
  }
})()))

check('a document with no numbering in it gains one',
  listed.blocks.every((block) => block.list),
  JSON.stringify(listed.blocks.map((b) => b.list)))
check('and the two sorts of list are told apart',
  listed.blocks[0].list.ordered === false && listed.blocks[2].list.ordered === true,
  JSON.stringify(listed.blocks.map((b) => b.list)))
check('two items of one list share its numbering, rather than defining it twice',
  listed.blocks[0].ppr === listed.blocks[1].ppr, listed.blocks[1].ppr)

const listedPackage = require('../electron/docx').unzip(writeDocxBuffer(blankDocxBuffer(), (() => {
  const empty = readDocxBuffer(blankDocxBuffer())
  return {
    stamp: empty.stamp,
    body: empty.body,
    after: empty.after,
    items: [{ p: { ppr: numPr('bullet'), runs: [{ text: 'one' }] } }]
  }
})()))
check('the numbering part is in the package it was added to',
  listedPackage.has('word/numbering.xml'))
check('and the package says so, in both places it has to',
  listedPackage.get('[Content_Types].xml').toString().includes('/word/numbering.xml') &&
  listedPackage.get('word/_rels/document.xml.rels').toString().includes('numbering.xml'))
check('no placeholder is left in the file',
  !listedPackage.get('word/document.xml').toString().includes('TULIP_'))

/* An existing definition is reused rather than a second one written beside it:
   a document whose bullets are Word's own should not come back with two ways
   of saying bullet. */
const twice = require('../electron/docx').unzip(writeDocxBuffer(FILE, {
  stamp: doc.stamp,
  body: doc.body,
  after: doc.after,
  items: [...items, { p: { ppr: numPr('bullet'), runs: [{ text: 'another bullet' }] } }]
}))
check('an existing numbering is reused',
  (twice.get('word/numbering.xml').toString().match(/<w:abstractNum /g) || []).length === 2,
  twice.get('word/numbering.xml').toString().match(/<w:abstractNum /g)?.length)

/* ------------------------------------------------------------- a new one */

const blank = blankDocxBuffer()
const empty = readDocxBuffer(blank)
check('a document Tulip makes is one it can read back',
  empty.blocks.length === 1 && empty.words === 0, JSON.stringify(empty.blocks))
check('and it defines the heading styles, or applying one would mean nothing',
  empty.headingStyles[1] === 'Heading1' && empty.headingStyles[3] === 'Heading3',
  JSON.stringify(empty.headingStyles))
check('nothing in a new document is at risk from editing it', empty.fragile.length === 0)

const written = readDocxBuffer(writeDocxBuffer(blank, {
  stamp: empty.stamp,
  body: empty.body,
  after: empty.after,
  items: [
    { p: { ppr: `<w:pPr><w:pStyle w:val="${empty.headingStyles[1]}"/></w:pPr>`, runs: [{ text: 'Title here' }] } },
    { p: { ppr: '', runs: [{ text: 'And a line under it.' }] } }
  ]
}))
check('a document written from nothing reads back as what was put in it',
  written.blocks.length === 2 && written.blocks[0].type === 'heading' &&
  written.blocks[0].level === 1 && runText(written.blocks[1]) === 'And a line under it.',
  JSON.stringify(written.blocks.map((b) => b.type)))
check('and the paragraph the blank one started with is gone rather than doubled',
  written.words === 7 && written.blocks.length === 2, String(written.words))

/* ----------------------------------------------------------- and the refusals */

const refuses = (name, bytes) => {
  try {
    readDocxBuffer(bytes)
    check(name, false, 'it read something')
  } catch (err) {
    check(name, /Word document|not a Word/.test(err.message), err.message)
  }
}

refuses('a file that is not a zip is refused', Buffer.from('hello, not a zip at all'))
refuses('a zip with no word/document.xml is refused',
  makeZip([['notes.txt', 'just a text file']]))

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('docx: read')
