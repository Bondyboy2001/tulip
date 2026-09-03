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

   Its own module, and free of Electron, so `scripts/test-docx.cjs` can build a
   document in memory and read it back without a window.

   The blocks and runs this produces are the whole surface src/docx.js knows
   about, and the ones its saves hand back are the whole surface this writes.
   That model is the contract between the two files, held to agreement by the
   read-write-read round trips in `scripts/test-docx.cjs`: a field whose shape
   or meaning changes here changes there in the same commit.
   ================================================================== */

const { inflateRawSync, deflateRawSync, inflateRaw } = require('node:zlib')
const { promisify } = require('node:util')
const { createHash } = require('node:crypto')
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
  /* A file shorter than the record itself cannot hold one, and asking for the
     four bytes at a negative offset throws a RangeError rather than answering
     — which is how a download that stopped after a few bytes used to reach the
     reader as a stack trace instead of a sentence. */
  if (buf.length < 22) return -1
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
const unzip = (buf) => openZip(buf).files

/** The same, inflating on the thread pool. The index walk reads documents
 *  thirty-two at a time and the synchronous inflate made that a queue of
 *  thirty-two stalls of the main process; this one lets them overlap and
 *  keeps the event loop free while they do. */
async function unzipAsync (buf) {
  const entries = zipEntries(buf)
  const inflated = await Promise.all(entries.map((entry) => (entry.method === 8
    ? inflateRawAsync(entry.raw, { maxOutputLength: Math.max(entry.uncompressed, 1) })
      .catch(() => { throw damaged(entry.name) })
    : null)))
  const files = new Map()
  entries.forEach((entry, i) => {
    if (entry.method === 0) files.set(entry.name, checked(entry, entry.raw))
    else if (entry.method === 8) files.set(entry.name, checked(entry, inflated[i]))
  })
  return files
}

/**
 * The package as both halves of itself: the entries as they lie in the file,
 * and their contents by name.
 *
 * A save needs the first as much as the second. An entry whose buffer is still
 * the very one that came out of the file goes back into the new one as the
 * bytes it arrived as — see `rezip` — and that identity is the only record of
 * "nobody touched this" there is.
 *
 * @param {Buffer} buf
 * @returns {{ entries: any[], files: Map<string, Buffer> }}
 */
function openZip (buf) {
  const entries = zipEntries(buf)
  const files = new Map()
  for (const entry of entries) {
    if (entry.method === 0) entry.bytes = checked(entry, entry.raw)
    else if (entry.method === 8) {
      let out
      try {
        out = inflateRawSync(entry.raw, { maxOutputLength: Math.max(entry.uncompressed, 1) })
      } catch { throw damaged(entry.name) }
      entry.bytes = checked(entry, out)
    }
    // Anything else — the format allows a dozen — is left out rather than
    // guessed at; a missing part reads as a missing feature, not as nonsense.
    if (entry.bytes) files.set(entry.name, entry.bytes)
  }
  return { entries, files }
}

const damaged = (name) =>
  new Error(`That Word document is damaged: the part “${name}” inside it could not be unpacked.`)

/* What the zip recorded the part should add up to. A `.docx` that lost bytes
   in transit — a sync client that wrote half of one, an archive that went
   through something that thought it was text — otherwise reads as a document
   with a paragraph missing rather than as a file that did not arrive, and the
   first anybody hears of it is a save spliced into nonsense. */
function checked (entry, bytes) {
  if (crc32(bytes) !== entry.crc) {
    throw new Error(`That Word document is damaged: the part “${entry.name}” inside it does not match its checksum.`)
  }
  return bytes
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
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
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
    /* Bit 0 of the general-purpose flags is the one a password sets. The parts
       are then ciphertext, and inflating them produces either an error from
       zlib or bytes that are not XML — neither of which says the one thing the
       reader needs to hear. */
    if (flags & 1) {
      throw new Error('That Word document is password-protected, and Tulip cannot open it.')
    }
    /* The per-entry half of Zip64: the sizes are all-ones and the real ones are
       in the entry's extra field. Same answer as the directory's own sentinels
       above, and it has to be given here too — a document with one enormous
       picture in it reaches this line rather than that one. */
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localAt === 0xffffffff) {
      throw new Error('That Word document uses a zip format Tulip cannot read.')
    }
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_SIG) {
      throw new Error(`That Word document is incomplete: the part “${name}” inside it is not where the file says it is.`)
    }
    /* The local header's own name and extra lengths, not the directory's: the
       two extra fields differ in practice, and using the wrong one lands the
       read a few bytes into the data. */
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
    if (dataAt + compressed > buf.length) {
      throw new Error(`That Word document is incomplete: it ends part way through the part “${name}”.`)
    }
    const raw = buf.subarray(dataAt, dataAt + compressed)
    out.push({ name, method, raw, uncompressed, crc, bytes: /** @type {Buffer | null} */ (null) })
  }
  return out
}

/* The other direction: a zip written back out. Stored or deflated per entry,
   whichever is smaller — a picture is already compressed and deflating it
   again costs time to make it bigger. Everything is written in the order it
   was read, so a saved document differs from the one Word wrote only where the
   words did. */

/* Node's own, in native code: every part of every document is summed on the
   way in and again on the way out, and a byte-at-a-time table walk in
   JavaScript was the larger half of what a save cost. */
const { crc32 } = require('node:zlib')

/** Parts a zip is never asked to compress. A picture, a font and an embedded
 *  object are compressed formats already: deflating one spends time to make it
 *  a few bytes bigger, and a document with a dozen photographs in it spent
 *  that on every autosave. */
const ALREADY_PACKED = /^word\/(media|embeddings|fonts)\//

/** One entry, packed: stored or deflated, whichever is smaller. */
function packEntry (name, raw) {
  const packed = ALREADY_PACKED.test(name) ? null : deflateRawSync(raw)
  const stored = !packed || packed.length >= raw.length
  return { name, method: stored ? 0 : 8, data: stored ? raw : packed, size: raw.length, crc: crc32(raw) }
}

/** Packed entries, in order, as the file they make up. */
function writeZip (packed) {
  const locals = []
  const central = []
  let at = 0

  for (const { name, method, data, size, crc } of packed) {
    const nameBytes = Buffer.from(name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(CENTRAL_SIG, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(size, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(at, 42)
    central.push(entry, nameBytes)

    at += 30 + nameBytes.length + data.length
  }

  const body = Buffer.concat(locals)
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIG, 0)
  end.writeUInt16LE(packed.length, 8)
  end.writeUInt16LE(packed.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}

/**
 * @param {Map<string, Buffer>} files
 * @returns {Buffer}
 */
function zip (files) {
  return writeZip([...files].map(([name, raw]) => packEntry(name, raw)))
}

/**
 * The package written back out, reusing every entry nobody touched.
 *
 * A save rewrites one part of a `.docx` and leaves the other forty alone, and
 * `zip` above nevertheless deflated all forty from scratch — including every
 * picture, which it deflated only to discover that storing it was smaller. On
 * a document with photographs in it that is the whole cost of an autosave, and
 * it is paid again on the next keystroke's worth of idle.
 *
 * An entry whose buffer is still the one `openZip` inflated is an entry the
 * save did not touch, and it goes back into the new file as the bytes it
 * arrived as — its compression method, its checksum and its compressed length
 * exactly as Word wrote them. Nothing is re-deflated but the parts that
 * changed.
 *
 * @param {any[]} entries  what `openZip` read
 * @param {Map<string, Buffer>} files  the same parts, some of them replaced
 * @returns {Buffer}
 */
function rezip (entries, files) {
  const originals = new Map(entries.map((entry) => [entry.name, entry]))
  return writeZip([...files].map(([name, raw]) => {
    const was = originals.get(name)
    return was && was.bytes === raw
      ? { name, method: was.method, data: was.raw, size: was.uncompressed, crc: was.crc }
      : packEntry(name, raw)
  }))
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

/** The elements whose text content is the document's own words rather than the
 *  source file's indentation. Matched on the whole tag name, prefix and all,
 *  because a namespace prefix is a document's own choice. */
const TEXT_ELEMENT = /(^|:)(t|delText|instrText)$/

/**
 * Where the tag opening at `open` ends, ignoring any `>` inside an attribute.
 *
 * A raw `>` is perfectly legal in an attribute value — Word writes one into a
 * field instruction, a bookmark name or an alt text without a second thought —
 * and taking the first one for the end of the tag does not merely lose an
 * attribute. It ends the element in the wrong place, which moves every `from`
 * and `to` after it, which are the offsets a save splices by. A file was
 * silently rebuilt out of the wrong bytes.
 */
function tagEnd (xml, open) {
  let quote = ''
  for (let at = open + 1; at < xml.length; at++) {
    const ch = xml[at]
    if (quote) { if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') return at
  }
  return -1
}

/** Where a `<!…>` ends. A DOCTYPE may carry an internal subset in brackets,
 *  whose entity declarations hold `>` of their own, so the bracket is what
 *  decides where to look for the end. */
function declarationEnd (xml, open) {
  const plain = xml.indexOf('>', open)
  const bracket = xml.indexOf('[', open)
  if (bracket < 0 || plain < 0 || bracket > plain) return plain + 1 || xml.length
  const subset = xml.indexOf(']', bracket)
  if (subset < 0) return xml.length
  return xml.indexOf('>', subset) + 1 || xml.length
}

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
      const parent = stack[stack.length - 1]
      const text = xml.slice(at, open)
      /* Whitespace between elements is layout in the source file, not content
         — except inside the three elements whose whole content is text, where
         it is the words. Word writes a run holding one space between two
         differently formatted words constantly ("Warm", " ", "and"), and
         trimming those away spelled the sentence "Warmand" on screen and then
         saved it that way. */
      if (text.trim() || TEXT_ELEMENT.test(parent.name)) parent.kids.push(decodeEntities(text))
    }

    if (xml.startsWith('<!--', open)) { at = xml.indexOf('-->', open) + 3 || xml.length; continue }
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open)
      stack[stack.length - 1].kids.push(xml.slice(open + 9, close < 0 ? xml.length : close))
      at = close < 0 ? xml.length : close + 3
      continue
    }
    if (xml.startsWith('<!', open)) { at = declarationEnd(xml, open); continue }
    if (xml.startsWith('<?', open)) {
      at = xml.indexOf('>', open) + 1 || xml.length
      continue
    }

    const close = tagEnd(xml, open)
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

/** styleId → what that style means to us: its name, the heading level it
 *  stands for if it is one, and the list it puts a paragraph in if it does. */
function styleTable (xml) {
  /** @type {Map<string, any>} */
  const styles = new Map()
  if (!xml) return styles

  /* Read flat first and resolved afterwards, because a style is defined in
     terms of another one: "Report Heading" is `basedOn` Heading1 and says
     nothing about being a heading itself, and "Body Bullet" is `basedOn` List
     Paragraph and carries the numbering there. Reading each style alone made
     both of them ordinary body text — which is most of what a house template
     is, so a document written to one drew as a flat page of prose. */
  /** @type {Map<string, any>} */
  const flat = new Map()
  for (const style of children(parseXml(xml), 'style')) {
    const id = attr(style, 'styleId') || ''
    const props = child(style, 'pPr')
    const numPr = child(props, 'numPr')
    flat.set(id, {
      id,
      /* Only paragraph styles put a paragraph in a list or make it a heading. A
         character style may be called "Heading 1 Char" and is not one. */
      paragraph: (attr(style, 'type') || 'paragraph') === 'paragraph',
      name: attr(child(style, 'name'), 'val') || id,
      basedOn: attr(child(style, 'basedOn'), 'val') || '',
      outline: attr(child(props, 'outlineLvl'), 'val'),
      numId: attr(child(numPr, 'numId'), 'val'),
      ilvl: attr(child(numPr, 'ilvl'), 'val')
    })
  }

  /** The chain from a style up to the one nothing is based on, cycles and all.
   *  A template that has been edited by hand can name itself as its own
   *  ancestor, and following that is a window that never opens. */
  const chainOf = (id) => {
    const chain = []
    const seen = new Set()
    for (let at = id; at && !seen.has(at); at = flat.get(at)?.basedOn || '') {
      seen.add(at)
      const entry = flat.get(at)
      if (!entry) break
      chain.push(entry)
    }
    return chain
  }

  for (const [id, entry] of flat) {
    const chain = chainOf(id)
    let level = 0
    let numId = null
    let ilvl = null
    for (const step of chain) {
      if (!entry.paragraph) break
      /* `w:outlineLvl` is what makes a style a heading to Word's own navigation
         pane, and it counts from zero — with nine meaning "body text", which is
         how a style says it is deliberately not a heading. */
      const outline = step.outline == null ? -1 : Number(step.outline)
      if (!level) level = headingLevel(step.id, step.name)
      if (!level && outline >= 0 && outline <= 8) level = outline + 1
      if (numId == null && step.numId != null) { numId = step.numId; ilvl = step.ilvl }
    }
    styles.set(id, { name: entry.name, level, numId, ilvl })
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

/** What a list level looks like, as far as anything on screen is concerned. */
const levelOf = (lvl) => {
  const format = attr(child(lvl, 'numFmt'), 'val') || 'bullet'
  return {
    ordered: format !== 'bullet' && format !== 'none',
    format,
    start: Number(attr(child(lvl, 'start'), 'val') || 1) || 1,
    text: attr(child(lvl, 'lvlText'), 'val') || ''
  }
}

/**
 * numId + level → what that list level is drawn as.
 *
 * Two indirections, both of them Word's: a paragraph names a `w:num`, which
 * names an `w:abstractNum`, which holds the format of each level. The `w:num`
 * may also override where a level starts counting, which is how a second
 * numbered list in a document begins at 1 rather than carrying on from the
 * first.
 *
 * @returns {Map<string, Map<string, { ordered: boolean, format: string,
 *                                     start: number, text: string }>>}
 */
function numberingTable (xml) {
  /** @type {Map<string, Map<string, any>>} */
  const lists = new Map()
  if (!xml) return lists
  const root = parseXml(xml)

  const abstract = new Map()
  for (const node of children(root, 'abstractNum')) {
    const levels = new Map()
    for (const lvl of children(node, 'lvl')) levels.set(attr(lvl, 'ilvl') || '0', levelOf(lvl))
    abstract.set(attr(node, 'abstractNumId'), levels)
  }

  for (const num of children(root, 'num')) {
    const levels = abstract.get(attr(child(num, 'abstractNumId'), 'val'))
    if (!levels) continue
    const own = new Map(levels)
    for (const override of children(num, 'lvlOverride')) {
      const ilvl = attr(override, 'ilvl') || '0'
      const start = attr(child(override, 'startOverride'), 'val')
      const lvl = child(override, 'lvl')
      const was = own.get(ilvl) || { ordered: false, format: 'bullet', start: 1, text: '' }
      own.set(ilvl, {
        ...was,
        ...(lvl ? levelOf(lvl) : {}),
        ...(start != null ? { start: Number(start) || 1 } : {})
      })
    }
    lists.set(attr(num, 'numId'), own)
  }
  return lists
}

/** Which abstract numbering a document already has of this sort, if any — what
 *  a new list borrows its bullets or its numerals from. */
function abstractOfSort (xml, sort) {
  if (!xml) return null
  for (const node of children(parseXml(xml), 'abstractNum')) {
    const levels = children(node, 'lvl')
    const zero = levels.find((lvl) => (attr(lvl, 'ilvl') || '0') === '0') || levels[0]
    if (!zero) continue
    if (levelOf(zero).ordered === (sort === 'ordered')) return attr(node, 'abstractNumId')
  }
  return null
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
  avif: 'image/avif',
  svg: 'image/svg+xml'
}

/* The formats a browser will actually draw. EMF and WMF are Windows
   metafiles — a chart pasted from Excel, an old equation, one of Word's own
   drawings — and no browser has ever drawn either; handed to an <img> they
   produce the broken-image icon, which tells the reader the document is
   damaged when it is not. TIFF is the same story outside Safari. Named here so
   the page can draw a labelled space instead, and so the picture still goes
   back into the file as the run it arrived as. */
const DRAWABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif', 'svg'])

/* A picture is handed over as a data URL. The alternative — serving the zip's
   innards over the asset protocol — would mean holding an open document in the
   main process and inventing a URL space for parts inside files; a Word
   document's pictures are small next to that complication. Anything genuinely
   large is left out with a note, because a 40MB data URL is a frozen window. */
const IMAGE_LIMIT = 12 * 1024 * 1024

/** English Metric Units, which is what Word states picture sizes in. */
const EMU_PER_PX = 9525

/** Twentieths of a point — Word's unit for a width or an indent — as CSS
 *  pixels, which are ninety-six to the inch against typography's seventy-two. */
const dxaToPx = (twips) => Math.round((Number(twips) || 0) / 20 * (96 / 72))

/** The alignment names CSS shares with Word, and nothing else. */
const ALIGN = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }

/** One part of the zip as text, or '' where the document does not carry it —
 *  a document with no numbering has no `word/numbering.xml`, and that is a
 *  missing feature rather than a missing file. */
const text = (files, name) => {
  const bytes = files.get(name)
  return bytes ? bytes.toString('utf8') : ''
}

function makeReader (files, src, relsPart = 'word/_rels/document.xml.rels') {
  const rels = relationships(text(files, relsPart))
  const styles = styleTable(text(files, 'word/styles.xml'))
  const numbering = numberingTable(text(files, 'word/numbering.xml'))
  /* One data URL per part, however many times the document draws it: a logo in
     a header repeated on forty pages is one picture in the zip and should be
     one string in the reply. */
  const pictures = new Map()

  function picture (id) {
    if (pictures.has(id)) return pictures.get(id)
    const rel = rels.get(id)
    /** @type {{ src: string | null, format: string, missing: string } | null} */
    let made = null
    if (rel && !rel.external) {
      const name = `word/${String(rel.target).replace(/^\/+/, '').replace(/^word\//, '')}`
      const bytes = files.get(name)
      const ext = (name.split('.').pop() || '').toLowerCase()
      /* Three ways a picture can be in the file and still not be drawable, and
         the page says which: too big to hand over as a string, a format no
         browser draws, or a relationship pointing at a part that is not
         there. */
      if (!bytes) made = { src: null, format: ext, missing: 'missing' }
      else if (!DRAWABLE.has(ext)) made = { src: null, format: ext, missing: 'format' }
      else if (bytes.length > IMAGE_LIMIT) made = { src: null, format: ext, missing: 'size' }
      else {
        made = {
          src: `data:${MIME[ext] || 'application/octet-stream'};base64,${bytes.toString('base64')}`,
          format: ext,
          missing: ''
        }
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
   states — its font, its size, its language — is kept verbatim and put back
   untouched, so turning a word bold cannot silently restyle it. */
const RUN_TOGGLES = new Set(['b', 'bCs', 'i', 'iCs', 'strike', 'dstrike', 'u', 'vertAlign', 'highlight', 'color'])

/** A six-digit hex colour as CSS, or nothing where Word said "whatever the
 *  theme says" — which is not a colour this app can name. */
const hexColour = (value) => (/^[0-9a-fA-F]{6}$/.test(String(value || '')) ? `#${value}` : null)

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
  if (highlight && highlight !== 'none') { style.mark = true; style.highlight = highlight }
  const colour = hexColour(attr(child(props, 'color'), 'val'))
  if (colour) style.colour = colour
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

/* What a run may hold that is not a word and not a picture: a mark pointing at
   a footnote, the two halves of a field, the invisible ends of a bookmark. The
   app draws none of them, and used to drop every one of them from any
   paragraph somebody typed in — so editing the sentence a cross-reference sat
   in silently deleted the cross-reference. They are carried instead: the
   element goes back into the file as the bytes it arrived as, inside a run of
   its own. See `raw` in `runXml`. */
const NOTE_MARKS = { footnoteReference: 'footnote', endnoteReference: 'endnote', commentReference: 'comment' }

/** The runs of one `w:r`: its text, its breaks, its pictures, and whatever
 *  else it was carrying. */
function runsOf (r, reader, ctx) {
  const out = []
  const style = runStyle(r)
  const rpr = runRest(r, reader)
  const props = reader.raw(child(r, 'rPr'))
  const add = (run) => out.push({ ...style, rpr, ...ctx, ...run })

  for (const kid of r.kids) {
    if (typeof kid === 'string') continue
    const name = local(kid.name)
    if (name === 'rPr') continue
    if (name === 't') add({ text: flatten(kid) })
    else if (name === 'tab') add({ text: '\t' })
    else if (name === 'br') {
      /* Which sort of break. A page break read as a plain one is written back
         as a plain one, and a document's pagination quietly became line
         breaks the first time anybody typed in the paragraph holding it. */
      const kind = attr(kid, 'type') || ''
      const clear = attr(kid, 'clear') || ''
      add({ break: true, ...(kind && kind !== 'textWrapping' ? { breakType: kind } : {}), ...(clear ? { breakClear: clear } : {}) })
    } else if (name === 'cr') {
      /* Word's older spelling of `<w:br/>`, and the same thing on the page. It
         goes back as a `w:br`, which is what Word itself writes now. */
      add({ break: true })
    } else if (name === 'noBreakHyphen') add({ text: '‑' })
    else if (name === 'softHyphen') add({ text: '­' })
    else if (name === 'sym') {
      // A symbol font character, stated as a code point in a private-use area.
      const code = parseInt(attr(kid, 'char') || '', 16)
      if (Number.isFinite(code)) add({ text: String.fromCodePoint(code) })
    } else if (name === 'lastRenderedPageBreak') {
      /* Where Word's own layout engine happened to break the page last time it
         drew the document. It is a cache, not content: Word writes a fresh one
         every time it repaginates, and carrying a stale one would be worse
         than carrying none. */
      continue
    } else if (name === 'drawing' || name === 'pict' || name === 'object') {
      const image = imageOf(kid, reader)
      /* A picture is carried rather than understood: `raw` is the whole run as
         Word wrote it, drawing, anchoring and all, and it is what goes back
         into the file. Tulip can move a picture within a document and delete
         one; it cannot make one, and it does not pretend to rewrite one. */
      if (image) add({ image, raw: reader.raw(r) })
      else add({ raw: reader.raw(r) })
    } else {
      /* Everything else a run may hold, put back as it arrived: a footnote
         mark, half of a field, the anchor of a comment. A run of its own is
         valid wherever the run it came from was, and it keeps the run
         properties so the mark is still in the font Word gave it. */
      const note = NOTE_MARKS[name]
      add({
        raw: `<w:r>${props}${reader.raw(kid)}</w:r>`,
        ...(note ? { note: { kind: note, id: attr(kid, 'id') || '' } } : {})
      })
    }
  }
  return out
}

/* Wrappers Word puts around ordinary runs. The runs inside are the document:
   a tracked insertion, a content control, a moved passage, one of Word's old
   smart tags. A deletion (`w:del`, `w:moveFrom`) is deliberately not here — it
   is text that is not in the document any more. */
const WRAPPERS = new Set(['smartTag', 'ins', 'sdt', 'sdtContent', 'moveTo', 'bdo', 'dir', 'customXml'])
const NOT_CONTENT = new Set(['del', 'moveFrom', 'pPr', 'rPr', 'sdtPr', 'sdtEndPr', 'proofErr',
  'moveFromRangeStart', 'moveFromRangeEnd'])

/**
 * Every run inside a paragraph, however deeply Word wrapped it.
 *
 * One recursive descent rather than a list of the three wrappers that were
 * known about: a hyperlink holding a tracked insertion used to lose its words
 * altogether, because only `w:r` children of a `w:hyperlink` were looked at and
 * the runs were one level further down.
 *
 * `ctx` is what the wrappers on the way down mean for the runs at the bottom —
 * the link they are inside, the field whose result they are. It is carried on
 * each run so that a save can put the wrapper back around them.
 */
function runsWithin (node, reader, ctx) {
  const out = []
  for (const kid of node.kids) {
    if (typeof kid === 'string') continue
    const name = local(kid.name)
    if (name === 'r') { out.push(...runsOf(kid, reader, ctx)); continue }
    if (NOT_CONTENT.has(name)) continue
    if (name === 'hyperlink') {
      const rel = reader.rels.get(attr(kid, 'id'))
      const anchor = attr(kid, 'anchor') || ''
      const href = rel ? rel.target : (anchor ? `#${anchor}` : null)
      /* Which relationship it was, not only where it points. A link is a
         `w:hyperlink` wrapping its runs and naming an entry in the document's
         relationship part; rewriting the paragraph has to put that wrapper
         back, and the id is the only thing that can. */
      out.push(...runsWithin(kid, reader,
        { ...ctx, href, hyper: { id: attr(kid, 'id') || '', anchor } }))
      continue
    }
    if (name === 'fldSimple') {
      /* A field written the short way: the instruction is an attribute and the
         result is the runs inside. Those runs were invisible until now — the
         page drew nothing where a page number or a cross-reference was — and
         the wrapper is carried the way a hyperlink's is, so that editing the
         sentence around it does not turn the field into plain text. */
      out.push(...runsWithin(kid, reader, { ...ctx, fld: { instr: attr(kid, 'instr') || '' } }))
      continue
    }
    if (WRAPPERS.has(name)) { out.push(...runsWithin(kid, reader, ctx)); continue }
    /* Something that lives between the runs rather than inside one: the ends
       of a bookmark, the ends of a comment's range. Carried as it was written,
       so that editing the sentence does not break the cross-reference pointing
       at it. */
    out.push({ raw: reader.raw(kid) })
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
  const part = reader.picture(id)
  if (!part) return null

  const extent = descendant(node, 'extent')
  const cx = Number(attr(extent, 'cx') || 0)
  const cy = Number(attr(extent, 'cy') || 0)
  const described = attr(descendant(node, 'docPr'), 'descr')
  return {
    src: part.src,
    format: part.format,
    missing: part.missing,
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
  const runs = runsWithin(p, reader, {})

  /* A paragraph names its numbering, or its style does. "List Paragraph" with
     the numbering on the style is how a template says "a bullet", and reading
     only the paragraph drew the whole list as body text. `w:numId w:val="0"` is
     Word's way of saying explicitly that this paragraph is *not* in a list,
     which is how a paragraph opts out of the one its style would give it. */
  const numPr = child(props, 'numPr')
  let numId = attr(child(numPr, 'numId'), 'val')
  let ilvl = attr(child(numPr, 'ilvl'), 'val')
  if (numId == null && known && known.numId != null) {
    numId = known.numId
    if (ilvl == null) ilvl = known.ilvl
  }
  ilvl = ilvl || '0'
  const shape = numId ? reader.numbering.get(numId)?.get(ilvl) : null
  const list = numId && numId !== '0'
    ? {
        ordered: shape ? shape.ordered : false,
        level: Number(ilvl) || 0,
        numId,
        format: shape ? shape.format : 'bullet',
        start: shape ? shape.start : 1
      }
    : null

  const align = ALIGN[attr(child(props, 'jc'), 'val') || ''] || null
  const style = known ? known.name : styleId

  /* `ppr` and `at` are what a save is built from: the properties carry the
     style, the numbering and the spacing through an edit to the words, and the
     range is where the untouched original still is. */
  if (level > 0) return { type: 'heading', level, runs, align, style, ppr, at: [p.from, p.to] }
  return { type: 'paragraph', runs, align, list, style, ppr, at: [p.from, p.to] }
}

/* How Word's border names read in CSS. The ones with no equivalent — the
   forty ornamental borders a certificate is drawn with — come out as a plain
   line, which is nearer than nothing. */
const BORDER_STYLE = {
  single: 'solid', thick: 'solid', wave: 'solid', doubleWave: 'double',
  double: 'double', triple: 'double',
  dotted: 'dotted', dotDash: 'dashed', dotDotDash: 'dashed', dashed: 'dashed',
  dashSmallGap: 'dashed', dashDotStroked: 'dashed',
  inset: 'inset', outset: 'outset'
}

/** One `w:tblBorders` or `w:tcBorders` side, as the CSS it means — or `null`
 *  where the document said nothing, which is not the same as saying none. */
function cssBorder (node) {
  if (!node) return null
  const val = attr(node, 'val') || 'nil'
  if (val === 'nil' || val === 'none') return 'none'
  // `w:sz` is in eighths of a point, and a hairline still has to be a pixel.
  const size = Math.max(1, Math.round((Number(attr(node, 'sz')) || 4) / 8 * (96 / 72)))
  return `${size}px ${BORDER_STYLE[val] || 'solid'} ${hexColour(attr(node, 'color')) || 'currentColor'}`
}

/** What a `w:shd` fills its cell with, where that is a colour and not the
 *  theme's idea of one. */
const shadingOf = (node) => {
  if (!node) return null
  if ((attr(node, 'val') || 'clear') === 'nil') return null
  return hexColour(attr(node, 'fill'))
}

/** A `w:tblW` or `w:tcW` as the CSS width it stands for. */
function widthOf (node) {
  if (!node) return null
  const kind = attr(node, 'type') || 'dxa'
  const value = Number(attr(node, 'w')) || 0
  if (!value) return null
  // Fiftieths of a percent is how Word states a proportion of the page.
  if (kind === 'pct') return `${Math.min(value / 50, 100)}%`
  if (kind === 'dxa') return `${dxaToPx(value)}px`
  return null
}

/** A `w:tbl` as rows of cells, each cell holding blocks of its own. */
function tableOf (tbl, reader) {
  const rows = []
  /* The table's own shape — its borders, its widths, its column grid — kept
     whole. Tulip edits what a cell says, never how the table is drawn. */
  const tblPr = child(tbl, 'tblPr')
  const props = reader.raw(tblPr) + reader.raw(child(tbl, 'tblGrid'))

  /* And the same shape again, read rather than carried, because a table drawn
     with no borders at all looks like every other table in the vault — which
     is what every Word table used to look like here. The two accounts do not
     conflict: this one is for the screen and never goes back into the file. */
  const sides = child(tblPr, 'tblBorders')
  const outside = {
    top: cssBorder(child(sides, 'top')),
    left: cssBorder(child(sides, 'left')),
    bottom: cssBorder(child(sides, 'bottom')),
    right: cssBorder(child(sides, 'right'))
  }
  const insideH = cssBorder(child(sides, 'insideH'))
  const insideV = cssBorder(child(sides, 'insideV'))
  const tableShade = shadingOf(child(tblPr, 'shd'))
  const grid = children(child(tbl, 'tblGrid'), 'gridCol')
  const columns = grid.map((col) => dxaToPx(attr(col, 'w')))
  const across = columns.reduce((sum, width) => sum + width, 0)

  const lines = children(tbl, 'tr')
  lines.forEach((tr, r) => {
    const cells = []
    let column = 0
    for (const tc of children(tr, 'tc')) {
      const tcPr = child(tc, 'tcPr')
      const span = Number(attr(child(tcPr, 'gridSpan'), 'val') || 1)
      const wide = span > 0 ? span : 1
      /* A vertically merged cell that is a continuation carries no content of
         its own; it is drawn as the cell above growing, which the renderer does
         by leaving this one out and spanning. */
      const merge = child(tcPr, 'vMerge')
      const continues = merge != null && (attr(merge, 'val') || 'continue') === 'continue'
      const own = child(tcPr, 'tcBorders')
      cells.push({
        blocks: blocksOf(tc, reader),
        span: wide,
        continues,
        tcpr: reader.raw(tcPr),
        /* Where this very cell is in the file. A table with one cell typed into
           puts every other cell back as the bytes it arrived as, the way the
           body puts back a paragraph nobody touched. */
        at: [tc.from, tc.to],
        /* A cell's own borders win over the table's, and the table's differ
           between its edges and its inside. */
        look: {
          top: cssBorder(child(own, 'top')) || (r === 0 ? outside.top : insideH),
          bottom: cssBorder(child(own, 'bottom')) || (r === lines.length - 1 ? outside.bottom : insideH),
          left: cssBorder(child(own, 'left')) || (column === 0 ? outside.left : insideV),
          right: cssBorder(child(own, 'right')) ||
            (column + wide >= columns.length ? outside.right : insideV),
          background: shadingOf(child(tcPr, 'shd')) || tableShade,
          width: widthOf(child(tcPr, 'tcW')) ||
            (across && columns[column] ? `${Math.round(columns.slice(column, column + wide)
              .reduce((sum, w) => sum + w, 0) / across * 1000) / 10}%` : null)
        }
      })
      column += wide
    }
    /* A header row, which Word states on the row and CSS says with <th>. */
    const head = child(child(tr, 'trPr'), 'tblHeader') != null
    /* `w:tblPrEx` is a row saying the table's own properties do not apply to
       it — a width or a set of borders of its own. It comes before `w:trPr` in
       the schema, and it is carried with it. */
    rows.push({
      cells,
      head,
      trpr: reader.raw(child(tr, 'tblPrEx')) + reader.raw(child(tr, 'trPr')),
      at: [tr.from, tr.to]
    })
  })
  return {
    type: 'table',
    rows,
    props,
    look: { width: widthOf(child(tblPr, 'tblW')) },
    at: [tbl.from, tbl.to]
  }
}

/**
 * The blocks of a body, a table cell, or anything else that holds paragraphs.
 *
 * `top` says whether this is the body itself, which decides what happens to a
 * `w:sdt` — see below.
 */
function blocksOf (node, reader, top = false) {
  const blocks = []
  for (const kid of node.kids) {
    if (typeof kid === 'string') continue
    const name = local(kid.name)
    if (name === 'p') blocks.push(paragraphOf(kid, reader))
    else if (name === 'tbl') blocks.push(tableOf(kid, reader))
    else if (name === 'sdt') {
      const inner = child(kid, 'sdtContent')
      if (!inner) continue
      if (!top) { blocks.push(...blocksOf(inner, reader)); continue }
      /* A content control standing where a paragraph would: a table of
         contents, a cover page, a citation bibliography. Flattening it to the
         paragraphs inside dropped the wrapper — the field that makes Word's
         "Update Table" button work, the properties that make a cover page a
         cover page — because a save writes the blocks it was given and the
         wrapper was not one of them. A no-op save stripped it out.

         So the whole of it is one block, kept as the bytes it is. Its
         paragraphs are read for the page to draw, and the page draws them
         without offering to edit them: what is inside a `w:sdt` is Word's to
         rebuild. */
      blocks.push({
        type: 'sdt',
        blocks: blocksOf(inner, reader),
        at: [kid.from, kid.to]
      })
    }
  }
  return blocks
}

/* ------------------------------------------------- what sits around it

   A footnote, a comment and a header each live in a part of their own, which
   is why a save never puts any of them at risk: none of them is inside the
   body it splices. That also meant none of them was ever read, so a document
   whose argument was half in its footnotes drew as half a document. They are
   read here — for the page to show, and only to show. Nothing below is
   editable, and nothing below goes back into the file.
   ================================================================== */

/** A part beside the document, opened with a reader of its own so that its
 *  pictures and its links resolve against its own relationships. */
function partOf (files, name) {
  const src = text(files, name)
  if (!src) return null
  const rels = `word/_rels/${name.split('/').pop()}.rels`
  try {
    return { src, reader: makeReader(files, src, rels), root: parseXml(src) }
  } catch {
    /* A part this app cannot parse is a part the document does without. The
       body is what somebody opened the file to read. */
    return null
  }
}

/** The footnotes or the endnotes, as the text each one says. */
function notesOf (files, part, tag) {
  const opened = partOf(files, part)
  if (!opened) return []
  const out = []
  for (const node of children(opened.root, tag)) {
    /* Ids 0 and -1 are the rule Word draws above a footnote and the one it
       draws where a footnote carries on to the next page — furniture, not
       notes anybody wrote. They say so with a `w:type`. */
    const kind = attr(node, 'type') || 'normal'
    if (kind !== 'normal') continue
    const said = docxText(blocksOf(node, opened.reader)).trim()
    if (said) out.push({ id: attr(node, 'id') || '', text: said })
  }
  return out
}

/** The comments, with who left them. */
function commentsOf (files) {
  const opened = partOf(files, 'word/comments.xml')
  if (!opened) return []
  return children(opened.root, 'comment').map((node) => ({
    id: attr(node, 'id') || '',
    author: attr(node, 'author') || '',
    initials: attr(node, 'initials') || '',
    date: attr(node, 'date') || '',
    text: docxText(blocksOf(node, opened.reader)).trim()
  })).filter((comment) => comment.text)
}

/**
 * The headers and footers the body's sections point at.
 *
 * Read in the order the document names them, and identified by which of the
 * three kinds they are — the first page's, the even pages', and the one for
 * everything else. The page draws them as a band rather than as pages: this
 * app lays a document out in one column and does not repaginate it the way
 * Word does, so putting a header on every drawn sheet would be a claim about
 * where the pages fall that it is in no position to make.
 */
function marginsOf (files, document, reader) {
  const found = []
  const walk = (node) => {
    for (const kid of node.kids) {
      if (typeof kid === 'string') continue
      const name = local(kid.name)
      if (name === 'headerReference' || name === 'footerReference') {
        const rel = reader.rels.get(attr(kid, 'id'))
        if (!rel || rel.external) continue
        const part = `word/${String(rel.target).replace(/^\/+/, '').replace(/^word\//, '')}`
        const opened = partOf(files, part)
        if (!opened) continue
        const said = docxText(blocksOf(opened.root, opened.reader)).trim()
        if (said) {
          found.push({
            kind: name === 'headerReference' ? 'header' : 'footer',
            type: attr(kid, 'type') || 'default',
            text: said
          })
        }
        continue
      }
      walk(kid)
    }
  }
  walk(document)
  /* One band per kind: a document with three sections names the same header
     three times, and three identical bands would say nothing three times. */
  const seen = new Set()
  return found.filter((one) => {
    const key = `${one.kind}:${one.type}:${one.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/* A run of nothing is not a run. Word writes plenty of them — a formatting
   change with no text under it — and each one would otherwise become an empty
   <span> in the page. A run carrying raw bytes says nothing but is not
   nothing: it is a bookmark end, a field half or a footnote mark, and it is
   kept precisely so that it survives. */
const meaningful = (run) => run.break || run.image || run.raw || (run.text || '') !== ''

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
      // A content control kept whole still says something, and a search that
      // could not find the words in a table of contents is a search with a
      // hole in it.
      if (block.type === 'sdt') { walk(block.blocks); continue }
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
      } else if (block.type === 'sdt') {
        walk(block.blocks)
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

   Shorter than it was, because most of what used to be on it now survives. A
   field, a footnote mark, a comment anchor and the two ends of a bookmark are
   carried through a rewritten paragraph as the bytes they arrived as — see the
   note above `NOTE_MARKS` — and warning about something the app no longer
   loses is how a warning stops being read.

   What is left is the two wrappers that go *round* runs and cannot be put back
   from what the page holds: a tracked change, whose `w:ins` says who typed the
   words and when, and a content control sitting inside a paragraph. (One
   standing on its own between paragraphs — a table of contents, a cover page —
   is kept whole and is not at risk; see `blocksOf`.) */
/** @type {[RegExp, string][]} */
const FRAGILE = [
  [/<w:(ins|del)[\s>]/, 'tracked changes — who changed what, and when'],
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
  const blocks = blocksOf(root, reader, true)

  /* Every paragraph, not only the ones at the top: a run of nothing inside a
     table cell or inside a content control is as much an empty <span> in the
     page as one in the body. */
  const prune = (list) => {
    for (const block of list) {
      if (block.runs) block.runs = block.runs.filter(meaningful)
      if (block.blocks) prune(block.blocks)
      if (block.rows) for (const row of block.rows) for (const cell of row.cells) prune(cell.blocks)
    }
  }
  prune(blocks)

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
    fragile: fragileIn(source),
    /* The parts beside the body, read for the page to show and for nothing
       else. A save never touches any of them — each is a part of its own in
       the zip and goes through untouched — so they carry no ranges and nothing
       here can be edited. */
    footnotes: notesOf(files, 'word/footnotes.xml', 'footnote'),
    endnotes: notesOf(files, 'word/endnotes.xml', 'endnote'),
    comments: commentsOf(files),
    margins: marginsOf(files, document, reader)
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
  `${source.length}:${createHash('sha1').update(source).digest('hex')}`

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

/* One escape for both text and attribute values, which is why the quote is in
   it: every attribute this file writes is quoted with `"`, and a link whose URL
   holds one used to close the attribute early and hand Word a document it
   offered to repair. Escaping a quote inside element text is harmless.

   The control characters go the same way. XML 1.0 allows tab, newline and
   carriage return and nothing else below a space, and a stray NUL or form feed
   — pasted out of a terminal, out of a PDF, out of another editor — is not a
   character Word can be given at all: it is the "unreadable content" dialogue. */
const escapeXml = (text) => String(text)
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

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
  /* Word's highlighter is a named colour out of a list of sixteen, not a hex
     value — `w:val="yellow"` — so the page picks from the same list rather
     than offering a colour well that would have to be rounded to it. */
  if (run.highlight) add('highlight', `<w:highlight w:val="${escapeXml(run.highlight)}"/>`)
  if (run.colour) add('color', `<w:color w:val="${escapeXml(String(run.colour).replace(/^#/, ''))}"/>`)

  if (!parts.length) return ''
  // Stable, so two children of equal rank keep the order they arrived in.
  return `<w:rPr>${parts.map((part, i) => ({ part, i }))
    .sort((a, b) => a.part.order - b.part.order || a.i - b.i)
    .map(({ part }) => part.xml).join('')}</w:rPr>`
}

/** One run, as Word writes one. A picture — and every other thing a run may
 *  hold that this app carries rather than draws — is put back as the run it
 *  arrived as; see `raw` in `runsOf`. */
function runXml (run) {
  if (run.raw) return run.raw
  const props = runProps(run)
  if (run.break) {
    /* Which sort of break it was. Written back as a plain `<w:br/>`, a page
       break became a line break and the document's pagination quietly
       collapsed the first time somebody typed in that paragraph. */
    const kind = run.breakType ? ` w:type="${escapeXml(run.breakType)}"` : ''
    const clear = run.breakClear ? ` w:clear="${escapeXml(run.breakClear)}"` : ''
    return `<w:r>${props}<w:br${kind}${clear}/></w:r>`
  }
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

/** Whether two runs are inside the same wrappers, and therefore belong in the
 *  same one when the paragraph is written back out. */
const sameWrap = (run, hyper, fld) =>
  (run.hyper?.id || '') === (hyper?.id || '') &&
  (run.hyper?.anchor || '') === (hyper?.anchor || '') &&
  (run.fld?.instr || '') === (fld?.instr || '')

/**
 * The runs of a paragraph, with each stretch of them back inside the wrapper
 * it came out of.
 *
 * Two wrappers, both of which name something the run itself cannot: a
 * `w:hyperlink` names the relationship the link points through, and a
 * `w:fldSimple` names the instruction whose result the words are. A run that
 * lost either would be plain text where the document had a link or a field.
 */
function runsXml (runs) {
  let out = ''
  for (let i = 0; i < runs.length;) {
    const run = runs[i]
    const hyper = run.hyper && (run.hyper.id || run.hyper.anchor) ? run.hyper : null
    const fld = run.fld && run.fld.instr ? run.fld : null
    if (!hyper && !fld) { out += runXml(run); i++; continue }

    let to = i
    while (to < runs.length && sameWrap(runs[to], hyper, fld)) to++
    let inner = runs.slice(i, to).map(runXml).join('')
    if (hyper) {
      const id = hyper.id ? ` r:id="${escapeXml(hyper.id)}"` : ''
      const anchor = hyper.anchor ? ` w:anchor="${escapeXml(hyper.anchor)}"` : ''
      inner = `<w:hyperlink${id}${anchor}>${inner}</w:hyperlink>`
    }
    // A field wraps the link rather than the other way round: a cross-reference
    // whose result is a link is written that way, and never the reverse.
    if (fld) inner = `<w:fldSimple w:instr="${escapeXml(fld.instr)}">${inner}</w:fldSimple>`
    out += inner
    i = to
  }
  return out
}

const paragraphXml = (p) => `<w:p>${p.ppr || ''}${runsXml(p.runs || [])}</w:p>`

const cellXml = (cell, source) => (cell.keep && cell.at
  ? source.slice(cell.at[0], cell.at[1])
  : `<w:tc>${cell.tcpr || ''}${itemsXml(cell.items || [], source)}</w:tc>`)

const rowXml = (row, source) => (row.keep && row.at
  ? source.slice(row.at[0], row.at[1])
  : `<w:tr>${row.trpr || ''}${(row.cells || []).map((cell) => cellXml(cell, source)).join('')}</w:tr>`)

/**
 * A table, as the XML it stands for.
 *
 * A table that is still where it was in the file is spliced the way the body
 * is, and for the same reason: rebuilding one from rows and cells alone threw
 * away everything between them that this app does not model — a `w:tblPrEx`, a
 * bookmark spanning a column, the `w:sdt` a repeating section is wrapped in,
 * the custom XML a mail merge hangs off. One cell typed into is not a licence
 * to rewrite the table around it, so what is written afresh is that cell, and
 * everything else comes back byte for byte.
 *
 * A table whose *shape* changed — a row added, a column deleted — has no range
 * any more, and is written out whole from the model. That is the one case
 * where the table is genuinely a new one.
 */
function tableXml (tbl, source) {
  const rows = tbl.rows || []
  if (!tbl.at || !source || !rows.length || rows.some((row) => !row.at)) {
    return `<w:tbl>${tbl.props || ''}${rows.map((row) => rowXml(row, source)).join('')}</w:tbl>`
  }
  let out = ''
  let cursor = tbl.at[0]
  for (const row of rows) {
    if (row.at[0] >= cursor) out += source.slice(cursor, row.at[0])
    out += rowXml(row, source)
    cursor = Math.max(cursor, row.at[1])
  }
  // The close of the table, and anything the last row was followed by.
  return out + source.slice(cursor, tbl.at[1])
}

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
    else if (item.tbl) out += tableXml(item.tbl, source)
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
 * A numbering id for a list of this sort, in this document.
 *
 * Always a *new* `w:num`, and — where the document already has one — an
 * existing `w:abstractNum` for it to point at. The two halves are different
 * questions, and answering them the same way was a bug: reusing the whole
 * numbering meant the second list in a document was a continuation of the
 * first, so a list Tulip made under one that ended at "3." opened in Word
 * beginning at "4.". A `w:num` of its own with `w:startOverride` on every
 * level is how Word itself says "this list starts again at one", and it costs
 * one small element rather than a second definition of what a bullet is.
 *
 * @param {Map<string, Buffer>} files  the package, added to where a part is missing
 * @param {'bullet' | 'ordered'} sort
 * @returns {string} the `w:numId` to write
 */
function numberingFor (files, sort) {
  let source = text(files, 'word/numbering.xml') || EMPTY_NUMBERING

  const numId = String(highestId(source, 'num', 'numId') + 1)
  /* An existing definition of the right sort, so a document with bullets in it
     does not gain a second way of saying bullet. */
  let abstractId = abstractOfSort(source, sort)
  let abstract = ''
  if (abstractId == null) {
    abstractId = String(highestId(source, 'abstractNum', 'abstractNumId') + 1)
    abstract = `<w:abstractNum w:abstractNumId="${abstractId}">
<w:multiLevelType w:val="${sort === 'ordered' ? 'multilevel' : 'hybridMultilevel'}"/>
${sort === 'ordered' ? NUMBER_LEVELS : BULLET_LEVELS}</w:abstractNum>`
  }

  /* Every level, not only the first: a sub-list that carried on from the last
     document's sub-list is the same complaint one indent further in. */
  const restart = Array.from({ length: 9 }, (_, level) =>
    `<w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('')
  const num = `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/>${restart}</w:num>`

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
    files.set('word/_rels/document.xml.rels', Buffer.from(rels.replace('</Relationships>',
      `<Relationship Id="${nextRelId(rels)}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" ' +
      'Target="numbering.xml"/></Relationships>'), 'utf8'))
  }
  return numId
}

/** The next free relationship id in a `_rels` part. They are `rIdN`, and the
 *  highest in the part plus one is the only one certainly free. */
const nextRelId = (rels) =>
  `rId${Math.max(...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])), 0) + 1}`

/* ------------------------------------------------------- links

   The same trick as a list, for the same reason. A hyperlink is stated twice:
   the paragraph wraps its runs in a `w:hyperlink` naming a relationship, and
   the relationship — in `word/_rels/document.xml.rels`, a part the page has
   never seen — says where it points. The page cannot mint one: it does not
   hold the part, and two links made before a save would have to agree about
   which ids they had taken.

   So a link the reader makes is written as `r:id="TULIP_LINK:https://…"`, and
   this resolves it against the document being written into — an existing
   relationship to that URL where there is one, and a new one otherwise. Two
   paragraphs linking to the same place come out sharing a relationship, which
   is what Word does too. */

const LINK_PLACEHOLDER = 'TULIP_LINK:'

/** Every link placeholder in a body, turned into a relationship id. */
function resolveLinks (body, files) {
  if (!body.includes(LINK_PLACEHOLDER)) return body
  let rels = text(files, 'word/_rels/document.xml.rels')
  if (!rels) return body.replace(new RegExp(` r:id="${LINK_PLACEHOLDER}[^"]*"`, 'g'), '')

  /** url → the relationship that already points at it. */
  const known = new Map()
  for (const found of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]*)"/.exec(found[0])?.[1]
    const target = /Target="([^"]*)"/.exec(found[0])?.[1]
    if (id && target && /TargetMode="External"/.test(found[0])) known.set(decodeEntities(target), id)
  }

  const added = []
  const out = body.replace(new RegExp(`${LINK_PLACEHOLDER}([^"]*)`, 'g'), (_whole, escaped) => {
    const url = decodeEntities(escaped)
    let id = known.get(url)
    if (!id) {
      id = nextRelId(rels + added.join(''))
      added.push(`<Relationship Id="${id}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
        `Target="${escapeXml(url)}" TargetMode="External"/>`)
      known.set(url, id)
    }
    return id
  })

  if (added.length) {
    rels = rels.replace('</Relationships>', `${added.join('')}</Relationships>`)
    files.set('word/_rels/document.xml.rels', Buffer.from(rels, 'utf8'))
  }
  return out
}

/** Every placeholder in a body, resolved against the document being written.
 *
 *  One numbering per sort per save, which is what makes the four paragraphs a
 *  reader just turned into a list one list rather than four. */
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
  return writeDocx(buffer, edit).buffer
}

/**
 * `writeDocxBuffer`, keeping the parts it built: the caller that goes on to
 * read the saved document back — main does, to index it and answer the page
 * — reads these rather than unzipping and summing what it just zipped.
 *
 * @returns {{ buffer: Buffer, files: Map<string, Buffer> }}
 */
function writeDocx (buffer, edit) {
  /* Both halves of the package: the entries as they lie in the file, so that
     every part this save does not touch goes back into the new one as the
     compressed bytes it arrived as. See `rezip`. */
  const { entries, files } = openZip(buffer)
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

  /* A list the reader made says which *sort* of list it is, and a link the
     reader made says where it points; both leave the id to be resolved here,
     against this document's own numbering and its own relationships. */
  const resolved = resolveLinks(resolveLists(body, files), files)

  files.set('word/document.xml',
    Buffer.from(source.slice(0, from) + resolved + source.slice(to), 'utf8'))
  return { buffer: rezip(entries, files), files }
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
  readDocxBuffer, readDocxFiles, writeDocxBuffer, writeDocx, blankDocxBuffer, docxText,
  /* For the tests, which take a document apart to check what a save wrote. */
  LIST_PLACEHOLDER, unzip
}
