'use strict'
/* ================================================================= docx
   A Word document, read into the shape Tulip can draw.

   A `.docx` is a zip of XML: `word/document.xml` is the prose, and everything
   that makes it look like a document — which style a paragraph is in, which
   list it belongs to, which picture a run points at — is a reference into one
   of the parts beside it. So the reading is done here, in the main process,
   where zlib already is: the renderer is handed blocks and runs and never sees
   a zip, an entity or an EMU.

   Deliberately not a converter. Nothing here writes a `.docx` and nothing here
   turns one into Markdown: Word owns the format, the vault does not, and a
   round trip through a partial reader is how a document loses the half of
   itself that this file does not model. What it offers is a faithful *read* —
   the words, their emphasis, the headings, the lists, the tables and the
   pictures — which is what somebody who double-clicks a `.docx` in their vault
   is asking for. The two buttons that hand it to Word are still there, on the
   card, for everything this cannot say.

   Its own module, and free of Electron, so `scripts/test-docx.mjs` can build a
   document in memory and read it back without a window.
   ================================================================== */

const { inflateRawSync, deflateRawSync, inflateRaw } = require('node:zlib')
const { promisify } = require('node:util')
const inflateRawAsync = promisify(inflateRaw)

/* ------------------------------------------------------------------ zip

   Only as much of the format as a `.docx` uses: the central directory, and
   entries that are either stored or deflated. Read from the directory rather
   than by scanning for local headers, because a local header may say the sizes
   are in a descriptor after the data, and the directory always knows. */

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** Where the end-of-central-directory record starts, or -1. It is at the very
 *  end of the file unless there is a comment, which is at most 64K. */
function findEndRecord (buf) {
  const first = Math.max(0, buf.length - 0xffff - 22)
  for (let at = buf.length - 22; at >= first; at--) {
    if (buf.readUInt32LE(at) === EOCD_SIG) return at
  }
  return -1
}

/**
 * Every entry of `buf`, by name, decompressed.
 *
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
function unzip (buf) {
  const files = new Map()
  for (const { name, method, raw, uncompressed } of zipEntries(buf)) {
    if (method === 0) files.set(name, raw)
    else if (method === 8) files.set(name, inflateRawSync(raw, { maxOutputLength: Math.max(uncompressed, 1) }))
    // Anything else — the format allows a dozen — is left out rather than
    // guessed at; a missing part reads as a missing feature, not as nonsense.
  }
  return files
}

/** The same, inflating on the thread pool. The index walk reads documents
 *  thirty-two at a time and the synchronous inflate made that a queue of
 *  thirty-two stalls of the main process; this one lets them overlap and
 *  keeps the event loop free while they do. */
async function unzipAsync (buf) {
  const entries = zipEntries(buf)
  const inflated = await Promise.all(entries.map(({ method, raw, uncompressed }) =>
    method === 8 ? inflateRawAsync(raw, { maxOutputLength: Math.max(uncompressed, 1) }) : null))
  const files = new Map()
  entries.forEach(({ name, method, raw }, i) => {
    if (method === 0) files.set(name, raw)
    else if (method === 8) files.set(name, inflated[i])
  })
  return files
}

/** The central directory, walked: each entry's name, method and raw bytes. */
function zipEntries (buf) {
  const out = []
  const end = findEndRecord(buf)
  if (end < 0) throw new Error('That file is not a Word document.')

  const count = buf.readUInt16LE(end + 10)
  const start = buf.readUInt32LE(end + 16)
  /* Zip64 writes these two as all-ones and puts the real values in a record of
     its own. Nothing produces a Zip64 `.docx` short of a document with tens of
     thousands of parts, and half-reading one would be worse than saying so. */
  if (start === 0xffffffff || count === 0xffff) {
    throw new Error('That Word document uses a zip format Tulip cannot read.')
  }

  let at = start
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIG) break
    const method = buf.readUInt16LE(at + 10)
    const compressed = buf.readUInt32LE(at + 20)
    const uncompressed = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    at += 46 + nameLen + extraLen + commentLen

    // A directory entry, which a zip records as a name ending in a slash.
    if (name.endsWith('/')) continue
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_SIG) continue
    /* The local header's own name and extra lengths, not the directory's: the
       two extra fields differ in practice, and using the wrong one lands the
       read a few bytes into the data. */
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
    const raw = buf.subarray(dataAt, dataAt + compressed)
    out.push({ name, method, raw, uncompressed })
  }
  return out
}

/* The other direction: a zip written back out. Stored or deflated per entry,
   whichever is smaller — a picture is already compressed and deflating it
   again costs time to make it bigger. Everything is written in the order it
   was read, so a saved document differs from the one Word wrote only where the
   words did. */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * @param {Map<string, Buffer>} files
 * @returns {Buffer}
 */
function zip (files) {
  const locals = []
  const central = []
  let at = 0

  for (const [name, raw] of files) {
    const packed = deflateRawSync(raw)
    const stored = packed.length >= raw.length
    const data = stored ? raw : packed
    const nameBytes = Buffer.from(name, 'utf8')
    const sum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(CENTRAL_SIG, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(stored ? 0 : 8, 10)
    entry.writeUInt32LE(sum, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(at, 42)
    central.push(entry, nameBytes)

    at += 30 + nameBytes.length + data.length
  }

  const body = Buffer.concat(locals)
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIG, 0)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}

/* ------------------------------------------------------------------ xml

   A parser small enough to read, because the alternative is a dependency for
   the one document format the vault does not own. It keeps what
   WordprocessingML says with: element names, attributes and text. Comments,
   declarations and processing instructions are skipped, and CDATA is taken as
   text — none of the three carries meaning in a `.docx`. */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const decodeEntities = (text) => text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10)
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
  }
  return ENTITIES[body] ?? whole
})

/** @typedef {{ name: string, attrs: Record<string,string>, kids: Array<XmlNode|string>,
 *              from: number, to: number }} XmlNode
 *
 * `from` and `to` bracket the element in the source it was parsed from — the
 * whole of it, opening tag to closing tag. They are what makes editing a Word
 * document possible without rewriting the whole of it: a paragraph nobody
 * touched is put back into the file as the bytes it arrived as, so the field,
 * the footnote reference and the comment anchor this parser does not model
 * survive a save that had nothing to do with them. See `writeDocxBuffer`. */

const ATTR = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g

function attributesOf (source) {
  const attrs = {}
  ATTR.lastIndex = 0
  let match
  while ((match = ATTR.exec(source))) attrs[match[1]] = decodeEntities(match[2].slice(1, -1))
  return attrs
}

/**
 * @param {string} xml
 * @returns {XmlNode} the document element
 */
function parseXml (xml) {
  const root = /** @type {XmlNode} */ ({ name: '#document', attrs: {}, kids: [], from: 0, to: xml.length })
  /** @type {XmlNode[]} */
  const stack = [root]
  let at = 0

  while (at < xml.length) {
    const open = xml.indexOf('<', at)
    if (open < 0) break
    if (open > at) {
      const text = xml.slice(at, open)
      // Whitespace between elements is layout in the source file, not content;
      // `w:t` keeps its own by being read whole below.
      if (text.trim() || /[^\s]/.test(text)) stack[stack.length - 1].kids.push(decodeEntities(text))
    }

    if (xml.startsWith('<!--', open)) { at = xml.indexOf('-->', open) + 3 || xml.length; continue }
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open)
      stack[stack.length - 1].kids.push(xml.slice(open + 9, close < 0 ? xml.length : close))
      at = close < 0 ? xml.length : close + 3
      continue
    }
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) {
      at = xml.indexOf('>', open) + 1 || xml.length
      continue
    }

    const close = xml.indexOf('>', open)
    if (close < 0) break
    const inside = xml.slice(open + 1, close)

    if (inside[0] === '/') {
      // Closing tags are matched by depth rather than by name: a document that
      // is well-formed makes them the same thing, and one that is not is not
      // worth a second parser to complain about.
      if (stack.length > 1) {
        const closed = stack.pop()
        if (closed) closed.to = close + 1
      }
      at = close + 1
      continue
    }

    const selfClosing = inside.endsWith('/')
    const body = selfClosing ? inside.slice(0, -1) : inside
    const space = body.search(/[\s/]/)
    const name = space < 0 ? body : body.slice(0, space)
    const node = {
      name,
      attrs: space < 0 ? {} : attributesOf(body.slice(space)),
      kids: [],
      from: open,
      to: close + 1
    }
    stack[stack.length - 1].kids.push(node)
    if (!selfClosing) stack.push(node)
    at = close + 1
  }

  for (const kid of root.kids) if (typeof kid !== 'string') return kid
  throw new Error('That Word document could not be read.')
}

/* Namespace prefixes are declared per document and Word's are conventional but
   not guaranteed, so every lookup is by local name. */
const local = (name) => {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

/* Null-tolerant, because half the reads here are of a property element that
   may simply not be there: `child(child(tc, 'tcPr'), 'gridSpan')` is the
   ordinary spelling of "if this cell states a span". */
const children = (node, name) =>
  node ? node.kids.filter((kid) => typeof kid !== 'string' && local(kid.name) === name) : []

const child = (node, name) => children(node, name)[0] || null

/** The first descendant with this local name, at any depth. */
function descendant (node, name) {
  if (!node) return null
  for (const kid of node.kids) {
    if (typeof kid === 'string') continue
    if (local(kid.name) === name) return kid
    const deep = descendant(kid, name)
    if (deep) return deep
  }
  return null
}

/** An attribute by local name — `w:val` is asked for as `val`. */
function attr (node, name) {
  if (!node) return null
  for (const key of Object.keys(node.attrs)) {
    if (local(key) === name) return node.attrs[key]
  }
  return null
}

/** `<w:b/>` and `<w:b w:val="1"/>` are on; `w:val="0"` and `"false"` are off. */
const toggled = (node) => {
  if (!node) return false
  const val = attr(node, 'val')
  return val == null || !(val === '0' || val === 'false' || val === 'off')
}

/* --------------------------------------------------------------- the parts */

/** `rId7` → what it points at, from a `_rels` part. */
function relationships (xml) {
  const map = new Map()
  if (!xml) return map
  for (const rel of children(parseXml(xml), 'Relationship')) {
    map.set(attr(rel, 'Id'), {
      target: attr(rel, 'Target') || '',
      external: (attr(rel, 'TargetMode') || '') === 'External'
    })
  }
  return map
}

/** styleId → what that style means to us: its name, and the heading level it
 *  stands for if it is one. */
function styleTable (xml) {
  const styles = new Map()
  if (!xml) return styles
  for (const style of children(parseXml(xml), 'style')) {
    const id = attr(style, 'styleId') || ''
    const name = attr(child(style, 'name'), 'val') || id
    styles.set(id, { name, level: headingLevel(id, name) })
  }
  return styles
}

/* Word's own heading styles are `Heading1`…`Heading9`; a document written
   somewhere else may only carry the human name, "heading 1". Title and
   Subtitle are headings too — they are what the top of a report is written in,
   and showing them as body text loses the one piece of hierarchy the document
   was sure about. */
function headingLevel (id, name) {
  const from = (text) => {
    const match = /^heading\s*([1-9])$/i.exec(String(text || '').trim())
    return match ? Number(match[1]) : 0
  }
  if (/^title$/i.test(String(id)) || /^title$/i.test(String(name))) return 1
  if (/^subtitle$/i.test(String(id)) || /^subtitle$/i.test(String(name))) return 2
  return from(id) || from(name)
}

/**
 * numId + level → whether that list is numbered or bulleted.
 *
 * Two indirections, both of them Word's: a paragraph names a `w:num`, which
 * names an `w:abstractNum`, which holds the format of each level.
 */
function numberingTable (xml) {
  const ordered = new Map()
  if (!xml) return ordered
  const root = parseXml(xml)

  const abstract = new Map()
  for (const node of children(root, 'abstractNum')) {
    const id = attr(node, 'abstractNumId')
    const levels = new Map()
    for (const lvl of children(node, 'lvl')) {
      const format = attr(child(lvl, 'numFmt'), 'val') || 'bullet'
      levels.set(attr(lvl, 'ilvl') || '0', format !== 'bullet' && format !== 'none')
    }
    abstract.set(id, levels)
  }

  for (const num of children(root, 'num')) {
    const levels = abstract.get(attr(child(num, 'abstractNumId'), 'val'))
    if (levels) ordered.set(attr(num, 'numId'), levels)
  }
  return ordered
}

/* ------------------------------------------------------------- the document

   From here down it is Word's model turned into Tulip's: a flat list of
   blocks, each holding runs. Paragraph properties that have no equivalent on
   screen — spacing in twentieths of a point, tab stop tables, the compatibility
   settings — are dropped rather than approximated. */

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tiff: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
  svg: 'image/svg+xml'
}

/* A picture is handed over as a data URL. The alternative — serving the zip's
   innards over the asset protocol — would mean holding an open document in the
   main process and inventing a URL space for parts inside files; a Word
   document's pictures are small next to that complication. Anything genuinely
   large is left out with a note, because a 40MB data URL is a frozen window. */
const IMAGE_LIMIT = 12 * 1024 * 1024

/** English Metric Units, which is what Word states picture sizes in. */
const EMU_PER_PX = 9525

/** The alignment names CSS shares with Word, and nothing else. */
const ALIGN = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }

/** One part of the zip as text, or '' where the document does not carry it —
 *  a document with no numbering has no `word/numbering.xml`, and that is a
 *  missing feature rather than a missing file. */
const text = (files, name) => {
  const bytes = files.get(name)
  return bytes ? bytes.toString('utf8') : ''
}

function makeReader (files, src) {
  const rels = relationships(text(files, 'word/_rels/document.xml.rels'))
  const styles = styleTable(text(files, 'word/styles.xml'))
  const numbering = numberingTable(text(files, 'word/numbering.xml'))
  /* One data URL per part, however many times the document draws it: a logo in
     a header repeated on forty pages is one picture in the zip and should be
     one string in the reply. */
  const pictures = new Map()

  function picture (id) {
    if (pictures.has(id)) return pictures.get(id)
    const rel = rels.get(id)
    /** @type {string | null} */
    let made = null
    if (rel && !rel.external) {
      const name = `word/${String(rel.target).replace(/^\/+/, '').replace(/^word\//, '')}`
      const bytes = files.get(name)
      const ext = (name.split('.').pop() || '').toLowerCase()
      if (bytes && bytes.length <= IMAGE_LIMIT) {
        made = `data:${MIME[ext] || 'application/octet-stream'};base64,${bytes.toString('base64')}`
      }
    }
    pictures.set(id, made)
    return made
  }

  /** An element exactly as it was written, which is what an untouched
   *  paragraph is put back into the file as. */
  const raw = (node) => (node ? src.slice(node.from, node.to) : '')

  return { rels, styles, numbering, picture, raw }
}

/* The `w:rPr` children this app has a control for. Everything else a run
   states — its font, its size, its colour, its language — is kept verbatim and
   put back untouched, so turning a word bold cannot silently restyle it. */
const RUN_TOGGLES = new Set(['b', 'bCs', 'i', 'iCs', 'strike', 'dstrike', 'u', 'vertAlign'])

/** The formatting a run carries, read off its `w:rPr`. */
function runStyle (r) {
  const props = child(r, 'rPr')
  if (!props) return {}
  const vert = attr(child(props, 'vertAlign'), 'val')
  const style = {}
  if (toggled(child(props, 'b'))) style.bold = true
  if (toggled(child(props, 'i'))) style.italic = true
  if (toggled(child(props, 'strike')) || toggled(child(props, 'dstrike'))) style.strike = true
  // `w:u` states which underline, and "none" is one of them.
  const underline = child(props, 'u')
  if (underline && (attr(underline, 'val') || 'single') !== 'none') style.underline = true
  if (vert === 'superscript') style.vert = 'sup'
  if (vert === 'subscript') style.vert = 'sub'
  const highlight = attr(child(props, 'highlight'), 'val')
  if (highlight && highlight !== 'none') style.mark = true
  return style
}

/** Everything a run's `w:rPr` says apart from the toggles above, as the XML it
 *  was written as — the half of a run's formatting Tulip carries rather than
 *  understands. */
function runRest (r, reader) {
  const props = child(r, 'rPr')
  if (!props) return ''
  let out = ''
  for (const kid of props.kids) {
    if (typeof kid === 'string') continue
    if (!RUN_TOGGLES.has(local(kid.name))) out += reader.raw(kid)
  }
  return out
}

/** The runs of one `w:r`: its text, its breaks and its pictures. */
function runsOf (r, reader, link) {
  const out = []
  const style = runStyle(r)
  const rpr = runRest(r, reader)
  const add = (run) => out.push(
    link ? { ...style, rpr, ...run, href: link } : { ...style, rpr, ...run })

  for (const kid of r.kids) {
    if (typeof kid === 'string') continue
    const name = local(kid.name)
    if (name === 't') add({ text: flatten(kid) })
    else if (name === 'tab') add({ text: '\t' })
    else if (name === 'br') add({ break: true })
    else if (name === 'noBreakHyphen') add({ text: '‑' })
    else if (name === 'softHyphen') add({ text: '­' })
    else if (name === 'sym') {
      // A symbol font character, stated as a code point in a private-use area.
      const code = parseInt(attr(kid, 'char') || '', 16)
      if (Number.isFinite(code)) add({ text: String.fromCodePoint(code) })
    } else if (name === 'drawing' || name === 'pict' || name === 'object') {
      const image = imageOf(kid, reader)
      /* A picture is carried rather than understood: `raw` is the whole run as
         Word wrote it, drawing, anchoring and all, and it is what goes back
         into the file. Tulip can move a picture within a document and delete
         one; it cannot make one, and it does not pretend to rewrite one. */
      if (image) add({ image, raw: reader.raw(r) })
    }
  }
  return out
}

/** Everything a node says, with its own markup taken off. */
function flatten (node) {
  let out = ''
  for (const kid of node.kids) out += typeof kid === 'string' ? kid : flatten(kid)
  return out
}

/** The picture a `w:drawing` (or the older `w:pict`) points at. */
function imageOf (node, reader) {
  const blip = descendant(node, 'blip')
  const id = blip ? attr(blip, 'embed') || attr(blip, 'link') : attr(descendant(node, 'imagedata'), 'id')
  if (!id) return null
  const src = reader.picture(id)
  if (!src) return null

  const extent = descendant(node, 'extent')
  const cx = Number(attr(extent, 'cx') || 0)
  const cy = Number(attr(extent, 'cy') || 0)
  const described = attr(descendant(node, 'docPr'), 'descr')
  return {
    src,
    alt: described || attr(descendant(node, 'docPr'), 'name') || '',
    width: cx > 0 ? Math.round(cx / EMU_PER_PX) : 0,
    height: cy > 0 ? Math.round(cy / EMU_PER_PX) : 0
  }
}

/** One `w:p` as a block: a heading, a list item, or a paragraph. */
function paragraphOf (p, reader) {
  const props = child(p, 'pPr')
  const ppr = reader.raw(props)
  const styleId = attr(child(props, 'pStyle'), 'val') || ''
  const known = reader.styles.get(styleId)
  const level = known ? known.level : headingLevel(styleId, styleId)
  const runs = []

  for (const kid of p.kids) {
    if (typeof kid === 'string') continue
    const name = local(kid.name)
    if (name === 'r') runs.push(...runsOf(kid, reader, null))
    else if (name === 'hyperlink') {
      const rel = reader.rels.get(attr(kid, 'id'))
      const href = rel ? rel.target : (attr(kid, 'anchor') ? `#${attr(kid, 'anchor')}` : null)
      /* Which relationship it was, not only where it points. A link is a
         `w:hyperlink` wrapping its runs and naming an entry in the document's
         relationship part; rewriting the paragraph has to put that wrapper
         back, and the id is the only thing that can. */
      const hyper = { id: attr(kid, 'id') || '', anchor: attr(kid, 'anchor') || '' }
      for (const inner of children(kid, 'r')) {
        for (const run of runsOf(inner, reader, href)) runs.push({ ...run, hyper })
      }
    } else if (name === 'smartTag' || name === 'ins' || name === 'sdt' || name === 'sdtContent') {
      /* Wrappers around ordinary runs: a tracked insertion, a content control,
         one of Word's old smart tags. The runs inside are the document. A
         deletion (`w:del`) is deliberately not here — it is text that is not in
         the document any more. */
      for (const inner of children(name === 'sdt' ? (child(kid, 'sdtContent') || kid) : kid, 'r')) {
        runs.push(...runsOf(inner, reader, null))
      }
    }
  }

  const numPr = child(props, 'numPr')
  const numId = attr(child(numPr, 'numId'), 'val')
  const ilvl = attr(child(numPr, 'ilvl'), 'val') || '0'
  const list = numId
    ? { ordered: reader.numbering.get(numId)?.get(ilvl) ?? false, level: Number(ilvl) || 0 }
    : null

  const align = ALIGN[attr(child(props, 'jc'), 'val') || ''] || null
  const style = known ? known.name : styleId

  /* `ppr` and `at` are what a save is built from: the properties carry the
     style, the numbering and the spacing through an edit to the words, and the
     range is where the untouched original still is. */
  if (level > 0) return { type: 'heading', level, runs, align, style, ppr, at: [p.from, p.to] }
  return { type: 'paragraph', runs, align, list, style, ppr, at: [p.from, p.to] }
}

/** A `w:tbl` as rows of cells, each cell holding blocks of its own. */
function tableOf (tbl, reader) {
  const rows = []
  /* The table's own shape — its borders, its widths, its column grid — kept
     whole. Tulip edits what a cell says, never how the table is drawn. */
  const props = reader.raw(child(tbl, 'tblPr')) + reader.raw(child(tbl, 'tblGrid'))
  for (const tr of children(tbl, 'tr')) {
    const cells = []
    for (const tc of children(tr, 'tc')) {
      const span = Number(attr(child(child(tc, 'tcPr'), 'gridSpan'), 'val') || 1)
      /* A vertically merged cell that is a continuation carries no content of
         its own; it is drawn as the cell above growing, which the renderer does
         by leaving this one out and spanning. */
      const merge = child(child(tc, 'tcPr'), 'vMerge')
      const continues = merge != null && (attr(merge, 'val') || 'continue') === 'continue'
      cells.push({
        blocks: blocksOf(tc, reader),
        span: span > 0 ? span : 1,
        continues,
        tcpr: reader.raw(child(tc, 'tcPr'))
      })
    }
    /* A header row, which Word states on the row and CSS says with <th>. */
    const head = child(child(tr, 'trPr'), 'tblHeader') != null
    rows.push({ cells, head, trpr: reader.raw(child(tr, 'trPr')) })
  }
  return { type: 'table', rows, props, at: [tbl.from, tbl.to] }
}

/** The blocks of a body, a table cell, or anything else that holds paragraphs. */
function blocksOf (node, reader) {
  const blocks = []
  for (const kid of node.kids) {
    if (typeof kid === 'string') continue
    const name = local(kid.name)
    if (name === 'p') blocks.push(paragraphOf(kid, reader))
    else if (name === 'tbl') blocks.push(tableOf(kid, reader))
    else if (name === 'sdt') {
      // A content control — a table of contents, a form field — whose contents
      // are ordinary blocks.
      const inner = child(kid, 'sdtContent')
      if (inner) blocks.push(...blocksOf(inner, reader))
    }
  }
  return blocks
}

/* A run of nothing is not a run. Word writes plenty of them — a formatting
   change with no text under it, an empty bookmark — and each one would
   otherwise become an empty <span> in the page. */
const meaningful = (run) => run.break || run.image || (run.text || '') !== ''

/**
 * A document's words, as plain text — what the vault index holds for it.
 *
 * Headings keep their hashes and a table row its tabs, for the same reason the
 * viewer's own `text` does it: a run of cells folded into one line is not what
 * the table says, and a search result reading "Day\tRain" is one somebody can
 * recognise. Pictures and their data are not here at all.
 *
 * @param {any[]} blocks
 * @returns {string}
 */
function docxText (blocks) {
  const lines = []
  const walk = (list) => {
    for (const block of list) {
      if (block.type === 'table') {
        for (const row of block.rows) {
          lines.push(row.cells.map((cell) => {
            const before = lines.length
            walk(cell.blocks)
            return lines.splice(before).join(' ')
          }).join('\t'))
        }
        continue
      }
      const line = (block.runs || []).map((run) => (run.break ? '\n' : (run.text || ''))).join('')
      lines.push(block.type === 'heading'
        ? `${'#'.repeat(Math.min(block.level, 6))} ${line}`
        : line)
    }
  }
  walk(blocks)
  return lines.join('\n')
}

/** How many words a block holds, for the line along the foot of the window. */
function wordsIn (blocks) {
  let words = 0
  const count = (text) => {
    const matched = String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*|[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/gu)
    words += matched ? matched.length : 0
  }
  const walk = (list) => {
    for (const block of list) {
      if (block.type === 'table') {
        for (const row of block.rows) for (const cell of row.cells) walk(cell.blocks)
      } else {
        for (const run of block.runs) if (run.text) count(run.text)
      }
    }
  }
  walk(blocks)
  return words
}

/* What a document holds that this app draws none of, and would therefore lose
   from any paragraph it rewrote. Named so the viewer can say so once, before
   the first edit, rather than after the save — see `fragile` in src/docx.js.

   Only the constructs that live *inside* a paragraph are here. A header, a
   footer or a footnote's own text is a part of its own in the zip and is
   carried through a save untouched, so it is not at risk. */
/** @type {[RegExp, string][]} */
const FRAGILE = [
  [/<w:(fldSimple|instrText)[\s>]/, 'fields — a page number, a cross-reference, a table of contents'],
  [/<w:(footnoteReference|endnoteReference)[\s/>]/, 'footnote and endnote marks'],
  [/<w:commentRangeStart[\s/>]/, 'comments'],
  [/<w:(ins|del)[\s>]/, 'tracked changes'],
  [/<w:sdt[\s>]/, 'content controls — a form field, a citation, a date picker']
]

const fragileIn = (source) =>
  FRAGILE.filter(([pattern]) => pattern.test(source)).map(([, said]) => said)

/**
 * A `.docx` in memory, read into blocks.
 *
 * @param {Buffer} buffer  the file
 * @returns {{ blocks: any[], words: number, title: string, stamp: string,
 *             body: [number, number], after: number, fragile: string[],
 *             headingStyles: Record<number, string> }}
 */
function readDocxBuffer (buffer) {
  return readDocxFiles(unzip(buffer))
}

/** `readDocxBuffer`, with the inflating off the main thread. */
async function readDocxBufferAsync (buffer) {
  return readDocxFiles(await unzipAsync(buffer))
}

function readDocxFiles (files) {
  const source = text(files, 'word/document.xml')
  if (!source) throw new Error('That file has no Word document inside it.')

  const reader = makeReader(files, source)
  const document = parseXml(source)
  const root = child(document, 'body') || document
  const blocks = blocksOf(root, reader)

  for (const block of blocks) if (block.runs) block.runs = block.runs.filter(meaningful)

  /* Where the body's *contents* start and end. A save rebuilds this range and
     nothing else: the document element, its dozen namespace declarations and
     the section properties at the foot are put back exactly as they were. */
  const inner = [source.indexOf('>', root.from) + 1, root.to - (root.name.length + 3)]
  /* Where the last paragraph or table ends. What follows it — the section
     properties, and only ever those in a real document — is the one part of
     the body a save carries through rather than rebuilds. */
  const after = blocks.length ? blocks[blocks.length - 1].at[1] : inner[0]

  return {
    blocks,
    words: wordsIn(blocks),
    /* What the document says it is called, which is not what the file is
       called. Shown nowhere by default — the tab carries the file name — but
       the copilot is told it, the way it is told a website's title. */
    title: titleOf(text(files, 'docProps/core.xml')),
    /* The reading a save is written against. Every untouched paragraph goes
       back into the file as a range of *this* document.xml, so a save that
       found a different one would splice one document's bytes into another —
       see `writeDocxBuffer`, which refuses rather than trying. */
    stamp: stampOf(source),
    /* Which style id means "Heading 1" *in this document*. A style is applied
       by naming it, and a name the file's own stylesheet does not define is a
       paragraph that looks like every other one — so the app asks the document
       rather than assuming Word's spelling. */
    headingStyles: headingStylesIn(reader.styles),
    body: /** @type {[number, number]} */ (inner),
    after,
    fragile: fragileIn(source)
  }
}

/** level → the styleId this document writes that heading with. */
function headingStylesIn (styles) {
  /** @type {Record<number, string>} */
  const found = {}
  for (const [id, style] of styles) {
    /* Word's own `Heading1` wins over a second style that merely says it is a
       heading 1: it is the one Word's toolbar applies, and a document usually
       has both. */
    if (style.level && (!found[style.level] || /^heading\s*\d$/i.test(id))) found[style.level] = id
  }
  return found
}

/* Long enough to identify a file and cheap enough to take on every read. Not a
   security claim: it is here to catch a document that changed underneath an
   open window, which is a race and not an attack. */
const stampOf = (source) =>
  `${source.length}:${require('node:crypto').createHash('sha1').update(source).digest('hex')}`

/* ---------------------------------------------------------------- writing

   Tulip edits the words of a Word document and nothing else about it, and the
   way it does that is by putting most of the file back untouched.

   A save is a list of items, in the order the document now reads. An item is
   either a range of the original `word/document.xml` — a paragraph nobody
   touched, spliced back byte for byte — or a paragraph the reader changed,
   built from its own properties and its runs. Everything outside the body's
   contents (the namespaces, the section properties, the styles, the numbering,
   the pictures, the headers and footers, the theme) is carried through
   verbatim, because none of it was read as anything but bytes.

   That is what makes this honest. A writer that serialised the whole document
   from this app's model would quietly drop every part of Word that this app
   does not draw. This one can only lose what was *inside a paragraph the
   reader edited* — which is the one place a person can see they are editing.
   ================================================================== */

const escapeXml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/* The order ECMA-376 states `w:rPr`'s children in. A document with them out of
   order is one Word offers to repair, so the toggles this app writes are
   merged into the run's own properties rather than appended to them. */
const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike',
  'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden',
  'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect',
  'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout',
  'specVanish', 'oMath'
]

/** The `w:rPr` for a run: what it already said, with this app's toggles put in
 *  their proper places. */
function runProps (run) {
  const rest = String(run.rpr || '')
  /** @type {{ order: number, xml: string }[]} */
  const parts = []
  if (rest) {
    const wrapped = `<w:rPr>${rest}</w:rPr>`
    for (const kid of parseXml(wrapped).kids) {
      if (typeof kid === 'string') continue
      const at = RPR_ORDER.indexOf(local(kid.name))
      parts.push({ order: at < 0 ? RPR_ORDER.length : at, xml: wrapped.slice(kid.from, kid.to) })
    }
  }
  const add = (name, xml) => parts.push({
    order: RPR_ORDER.indexOf(name) < 0 ? RPR_ORDER.length : RPR_ORDER.indexOf(name),
    xml
  })
  if (run.bold) add('b', '<w:b/>')
  if (run.italic) add('i', '<w:i/>')
  if (run.strike) add('strike', '<w:strike/>')
  if (run.underline) add('u', '<w:u w:val="single"/>')
  if (run.vert === 'sup') add('vertAlign', '<w:vertAlign w:val="superscript"/>')
  if (run.vert === 'sub') add('vertAlign', '<w:vertAlign w:val="subscript"/>')

  if (!parts.length) return ''
  // Stable, so two children of equal rank keep the order they arrived in.
  return `<w:rPr>${parts.map((part, i) => ({ part, i }))
    .sort((a, b) => a.part.order - b.part.order || a.i - b.i)
    .map(({ part }) => part.xml).join('')}</w:rPr>`
}

/** One run, as Word writes one. A picture is put back as the run it arrived
 *  as — see `raw` in `runsOf`. */
function runXml (run) {
  if (run.raw) return run.raw
  const props = runProps(run)
  if (run.break) return `<w:r>${props}<w:br/></w:r>`
  /* `xml:space="preserve"` on every run this app writes: a run ending in a
     space is ordinary in a sentence built from several, and without it the
     space is the reader's to lose. Tabs are their own element — inside `w:t`
     they would be collapsed to a space. */
  const pieces = String(run.text ?? '').split('\t')
  const body = pieces
    .map((piece) => (piece ? `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>` : ''))
    .join('<w:tab/>')
  return `<w:r>${props}${body}</w:r>`
}

/** The runs of a paragraph, with each stretch of link runs back inside the
 *  `w:hyperlink` it came from. */
function runsXml (runs) {
  let out = ''
  for (let i = 0; i < runs.length;) {
    const hyper = runs[i].hyper
    if (!hyper || (!hyper.id && !hyper.anchor)) { out += runXml(runs[i]); i++; continue }
    let to = i
    while (to < runs.length && runs[to].hyper &&
      runs[to].hyper.id === hyper.id && runs[to].hyper.anchor === hyper.anchor) to++
    const id = hyper.id ? ` r:id="${escapeXml(hyper.id)}"` : ''
    const anchor = hyper.anchor ? ` w:anchor="${escapeXml(hyper.anchor)}"` : ''
    out += `<w:hyperlink${id}${anchor}>${runs.slice(i, to).map(runXml).join('')}</w:hyperlink>`
    i = to
  }
  return out
}

const paragraphXml = (p) => `<w:p>${p.ppr || ''}${runsXml(p.runs || [])}</w:p>`

const tableXml = (tbl) => `<w:tbl>${tbl.props || ''}${(tbl.rows || []).map((row) =>
  `<w:tr>${row.trpr || ''}${(row.cells || []).map((cell) =>
    `<w:tc>${cell.tcpr || ''}${itemsXml(cell.items || [], '')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`

/**
 * A list of items as the XML they stand for.
 *
 * `source` is the original `word/document.xml`, which a kept item's `at` is a
 * range of. A table cell being rebuilt passes it too: a cell whose neighbour
 * was edited keeps its own paragraphs verbatim, exactly as the body does.
 */
/** @param {any[]} items @param {string} source */
function itemsXml (items, source) {
  let out = ''
  for (const item of items) {
    if (item.keep && item.at) out += source.slice(item.at[0], item.at[1])
    else if (item.p) out += paragraphXml(item.p)
    else if (item.tbl) out += tableXml(item.tbl)
  }
  return out
}

/* ------------------------------------------------------- numbering

   Making a list is the one edit that cannot be written from the paragraph
   alone. Word states a list twice: the paragraph names a numbering, and the
   numbering says what the bullets or the numerals are — in `word/numbering.xml`,
   a part a document with no lists in it does not have at all.

   So the page writes a placeholder — `w:numId w:val="TULIP_BULLET"` — and the
   real id is resolved here, at the last moment, against the document being
   written into: an existing definition of the right sort where there is one,
   and a new one added to the package where there is not. The page does not
   have to know what a `w:abstractNum` is, and a document that already has
   bullets does not gain a second definition of them. */

const LIST_PLACEHOLDER = { bullet: 'TULIP_BULLET', ordered: 'TULIP_ORDERED' }

const BULLET_LEVELS = Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}">
<w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${'•◦▪'[level % 3]}"/>
<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr>
</w:lvl>`).join('')

const NUMBER_LEVELS = Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}">
<w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][level % 3]}"/>
<w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr>
</w:lvl>`).join('')

const EMPTY_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:numbering>`

/** The largest id already in use, so a new definition cannot collide. */
const highestId = (source, tag, attribute) => {
  let top = 0
  const pattern = new RegExp(`<w:${tag}[^>]*w:${attribute}="(\\d+)"`, 'g')
  for (const found of source.matchAll(pattern)) top = Math.max(top, Number(found[1]) || 0)
  return top
}

/**
 * A numbering id of this sort, in this document — found, or made.
 *
 * @param {Map<string, Buffer>} files  the package, added to where a part is missing
 * @param {'bullet' | 'ordered'} sort
 * @returns {string} the `w:numId` to write
 */
function numberingFor (files, sort) {
  let source = text(files, 'word/numbering.xml') || EMPTY_NUMBERING

  /* An existing definition of the right sort, so a document with bullets in it
     does not gain a second way of saying bullet. */
  const table = numberingTable(source)
  for (const [numId, levels] of table) {
    const ordered = levels.get('0')
    if (ordered === (sort === 'ordered')) return numId
  }

  const abstractId = String(highestId(source, 'abstractNum', 'abstractNumId') + 1)
  const numId = String(highestId(source, 'num', 'numId') + 1)
  const abstract = `<w:abstractNum w:abstractNumId="${abstractId}">
<w:multiLevelType w:val="${sort === 'ordered' ? 'multilevel' : 'hybridMultilevel'}"/>
${sort === 'ordered' ? NUMBER_LEVELS : BULLET_LEVELS}</w:abstractNum>`
  const num = `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`

  /* Order matters to the schema: every `w:abstractNum` comes before every
     `w:num`, so the pair is spliced in at the right seam rather than appended. */
  const firstNum = source.indexOf('<w:num ')
  source = firstNum === -1
    ? source.replace('</w:numbering>', `${abstract}${num}</w:numbering>`)
    : source.slice(0, firstNum) + abstract + num + source.slice(firstNum)
  files.set('word/numbering.xml', Buffer.from(source, 'utf8'))

  /* A part is not in a package until the package says it is: the content type
     that names it, and the relationship the document reaches it by. */
  const types = text(files, '[Content_Types].xml')
  if (types && !types.includes('/word/numbering.xml')) {
    files.set('[Content_Types].xml', Buffer.from(types.replace('</Types>',
      '<Override PartName="/word/numbering.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      '</Types>'), 'utf8'))
  }
  const rels = text(files, 'word/_rels/document.xml.rels')
  if (rels && !/Target="numbering\.xml"/.test(rels)) {
    // Relationship ids are `rIdN`; the highest in the part, plus one.
    const next = Math.max(...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])), 0) + 1
    files.set('word/_rels/document.xml.rels', Buffer.from(rels.replace('</Relationships>',
      `<Relationship Id="rId${next}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" ' +
      'Target="numbering.xml"/></Relationships>'), 'utf8'))
  }
  return numId
}

/** Every placeholder in a body, resolved against the document being written. */
function resolveLists (body, files) {
  let out = body
  for (const [sort, placeholder] of Object.entries(LIST_PLACEHOLDER)) {
    if (!out.includes(placeholder)) continue
    const numId = numberingFor(files, /** @type {'bullet' | 'ordered'} */ (sort))
    out = out.split(`w:val="${placeholder}"`).join(`w:val="${numId}"`)
  }
  return out
}

/**
 * A `.docx` with its body rewritten, as bytes ready to be written to disk.
 *
 * @param {Buffer} buffer  the file as it is on disk
 * @param {{ stamp: string, body: [number, number], after: number, items: any[] }} edit
 * @returns {Buffer}
 */
function writeDocxBuffer (buffer, edit) {
  const files = unzip(buffer)
  const source = text(files, 'word/document.xml')
  if (!source) throw new Error('That file has no Word document inside it.')
  /* The ranges below are ranges of the document that was read. If the file has
     changed since — Word saved it again, a sync client brought a new one — they
     are ranges of something else, and splicing them would build a document out
     of two. Refused, and the renderer reopens the file. */
  if (edit.stamp && edit.stamp !== stampOf(source)) {
    const err = /** @type {Error & { code?: string }} */ (new Error('That Word document changed on disk while it was open.'))
    err.code = STALE_DOCX
    throw err
  }

  const [from, to] = edit.body
  /* Where the body's own paragraphs and tables are. Worked out here rather than
     taken on trust from the caller, because it decides what happens to a
     paragraph that was *deleted*: what lies between two items comes with them
     — a bookmark, a comment range — but a paragraph the reader threw away is
     not "what lay between", and carrying it would put it straight back. */
  const bodyNode = child(parseXml(source), 'body')
  const spans = (bodyNode ? bodyNode.kids : [])
    .filter((kid) => typeof kid !== 'string')
    .map((kid) => [kid.from, kid.to])

  /** The source between two items, minus the blocks inside it. */
  function gap (start, end) {
    let out = ''
    let at = start
    for (const [spanFrom, spanTo] of spans) {
      if (spanTo <= at || spanFrom >= end) continue
      if (spanFrom > at) out += source.slice(at, spanFrom)
      at = Math.max(at, spanTo)
    }
    return at < end ? out + source.slice(at, end) : out
  }

  let body = ''
  /* How far through the original this has read. Everything before it has been
     dealt with — kept, rewritten, or deliberately dropped — and nothing may be
     taken from behind it again, or a paragraph would be written twice. */
  let cursor = from

  for (const item of edit.items) {
    /* An item that came from the document says where it was, and what sat
       between there and the last one comes with it. Only while the order is the
       one it was read in — a paragraph moved back above its neighbour leaves
       what sat beside it behind, which is the honest reading of having moved
       it, and is certainly better than writing those bytes twice. */
    const at = item.at
    if (at && at[0] >= cursor) body += gap(cursor, at[0])
    body += item.keep && at ? source.slice(at[0], at[1]) : itemsXml([item], source)
    if (at) cursor = Math.max(cursor, at[1])
  }

  /* The section properties at the foot of the body. Taken from after the last
     paragraph the document *had*, not from wherever the splice happens to have
     reached: a document whose paragraphs were all rewritten would otherwise
     have every one of its originals appended after the new ones. */
  body += source.slice(Math.max(cursor, edit.after ?? from), to)

  /* A list the reader made says which *sort* of list it is and leaves the id
     to be resolved here, against this document's own numbering. */
  const resolved = resolveLists(body, files)

  files.set('word/document.xml',
    Buffer.from(source.slice(0, from) + resolved + source.slice(to), 'utf8'))
  return zip(files)
}

function titleOf (xml) {
  if (!xml) return ''
  try {
    const node = descendant(parseXml(xml), 'title')
    return node ? flatten(node).trim() : ''
  } catch {
    return ''
  }
}

/* -------------------------------------------------------- a blank one

   The smallest package Word opens without offering to repair it: the content
   types it insists on, the one relationship that says which part is the
   document, an empty body, and a stylesheet.

   The stylesheet is why this is not four lines. A new document with no styles
   in it is one where "Heading 1" has nothing to mean — the app applies a style
   by naming it, and a name no `word/styles.xml` defines is a paragraph that
   looks exactly like every other. So a document made here starts with the
   handful Word itself starts with, spelled the way Word spells them, and a
   heading written in Tulip is a heading when the file is opened in Word. */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

/** A heading style, in the shape Word writes one. `outlineLvl` is what makes it
 *  a heading to the navigation pane as well as to the eye. */
const headingStyle = (level, size) => `<w:style w:type="paragraph" w:styleId="Heading${level}">
<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style>
${headingStyle(1, 40)}${headingStyle(2, 32)}${headingStyle(3, 28)}${headingStyle(4, 24)}
${headingStyle(5, 24)}${headingStyle(6, 24)}
</w:styles>`

const BLANK_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

/** A new, empty Word document. @returns {Buffer} */
function blankDocxBuffer () {
  return zip(new Map([
    ['[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf8')],
    ['_rels/.rels', Buffer.from(PACKAGE_RELS, 'utf8')],
    ['word/_rels/document.xml.rels', Buffer.from(DOCUMENT_RELS, 'utf8')],
    ['word/document.xml', Buffer.from(BLANK_DOCUMENT, 'utf8')],
    ['word/styles.xml', Buffer.from(STYLES, 'utf8')]
  ]))
}

/** The refusal above, recognisable by the caller that can do something about it. */
const STALE_DOCX = 'DOCX_STALE'
const isStaleDocxError = (err) => err?.code === STALE_DOCX

module.exports = {
  isStaleDocxError,
  readDocxBufferAsync,
  readDocxBuffer, writeDocxBuffer, blankDocxBuffer, docxText, LIST_PLACEHOLDER,
  unzip, zip, parseXml
}
