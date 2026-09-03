'use strict'

/* What the bytes say, and whether they survive the round trip.
   See electron/text-encoding.js. */

const assert = require('node:assert')
const {
  detectEncoding, detectNewline, decodeText, encodeText, isUnencodableError
} = require('../electron/text-encoding')

let checks = 0
const check = (fn) => { fn(); checks++ }

/* ---- detection ---- */

check(() => {
  const plain = Buffer.from('name,age\nAda,36\n', 'utf8')
  assert.deepEqual(detectEncoding(plain), { encoding: 'utf8', bom: false, skip: 0 })
})

check(() => {
  const marked = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a,b\n', 'utf8')])
  assert.deepEqual(detectEncoding(marked), { encoding: 'utf8', bom: true, skip: 3 })
})

check(() => {
  const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('a,b\n', 'utf16le')])
  assert.deepEqual(detectEncoding(utf16), { encoding: 'utf16le', bom: true, skip: 2 })
})

check(() => {
  const big = Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from([0x00, 0x61, 0x00, 0x62])])
  assert.deepEqual(detectEncoding(big), { encoding: 'utf16be', bom: true, skip: 2 })
})

/* The case the whole module exists for: an Excel export with a `é` as one
   Latin-1 byte, which is not valid UTF-8 and must not be read as though it
   were. */
check(() => {
  const excel = Buffer.from([0x43, 0x61, 0x66, 0xE9, 0x2C, 0x31, 0x0D, 0x0A])
  assert.deepEqual(detectEncoding(excel), { encoding: 'windows-1252', bom: false, skip: 0 })
  const read = decodeText(excel)
  assert.equal(read.text, 'Café,1\r\n')
  assert.equal(read.encoding, 'windows-1252')
  assert.equal(read.bom, false)
  assert.equal(read.newline, '\r\n')
  assert.equal(read.clean, true)
})

/* Real UTF-8 accents stay UTF-8: two bytes that happen to be a valid sequence
   are not a Latin-1 file that got lucky. */
check(() => {
  const read = decodeText(Buffer.from('Café,1\n', 'utf8'))
  assert.equal(read.encoding, 'utf8')
  assert.equal(read.text, 'Café,1\n')
  assert.equal(read.clean, true)
})

/* The windows-1252 range Latin-1 leaves as control codes — a smart quote and a
   euro sign, which is exactly what Word and Excel put there. */
check(() => {
  const read = decodeText(Buffer.from([0x93, 0x61, 0x94, 0x2C, 0x80]))
  assert.equal(read.text, '“a”,€')
  assert.equal(read.clean, true)
})

/* The five slots the original code page left undefined map to the C1 controls
   of the same number in the encoding standard, so windows-1252 has a meaning
   for all 256 bytes and no file can fail to decode under it. The encoder has to
   be that map's exact inverse or the round trip below would not come back. */
check(() => {
  const read = decodeText(Buffer.from([0x41, 0x81, 0x42]))
  assert.equal(read.encoding, 'windows-1252')
  assert.equal(read.clean, true)
  assert.equal(read.text, 'A\u0081B')
  assert.deepEqual([...encodeText(read.text, { encoding: 'windows-1252' })], [0x41, 0x81, 0x42])
})

/* A mark that the body then contradicts is the one way a decode can be lossy:
   a UTF-8 mark over bytes that are not UTF-8. The caller has to be told, since
   writing that string back would make the replacement permanent. */
check(() => {
  const lying = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from([0x43, 0xE9, 0x44])])
  const read = decodeText(lying)
  assert.equal(read.encoding, 'utf8')
  assert.equal(read.bom, true)
  assert.equal(read.clean, false)
  assert.ok(read.text.includes('\ufffd'))
})

/* Every byte value round-trips through windows-1252 — the property the
   fallback's safety rests on. */
check(() => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  // Strip the bytes that would make this valid UTF-8 or look like a mark.
  const read = decodeText(all)
  assert.equal(read.encoding, 'windows-1252')
  assert.deepEqual([...encodeText(read.text, { encoding: 'windows-1252' })], [...all])
})

/* ---- newlines ---- */

check(() => {
  assert.equal(detectNewline('a\r\nb\r\nc'), '\r\n')
  assert.equal(detectNewline('a\nb\nc'), '\n')
  assert.equal(detectNewline('a\rb\rc'), '\r')
  assert.equal(detectNewline('no line endings at all'), '\n')
  // Mixed: the majority decides, because one of them has to be written back.
  assert.equal(detectNewline('a\r\nb\r\nc\nd'), '\r\n')
})

/* ---- round trip ---- */

const roundTrip = (bytes) => {
  const read = decodeText(bytes)
  const written = encodeText(read.text, { encoding: read.encoding, bom: read.bom })
  assert.deepEqual([...written], [...bytes])
}

check(() => roundTrip(Buffer.from([0x43, 0x61, 0x66, 0xE9, 0x0D, 0x0A])))
check(() => roundTrip(Buffer.from('Café,€\n', 'utf8')))
check(() => roundTrip(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a,b\r\n', 'utf8')])))
check(() => roundTrip(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('a,b\n', 'utf16le')])))
check(() => roundTrip(Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from([0x00, 0x61, 0x00, 0x0A])])))
check(() => roundTrip(Buffer.from([0x93, 0x61, 0x94, 0x2C, 0x80])))

/* A mark is only written when the file had one. Excel recognises its own UTF-8
   exports by that mark, and a file that never had one must not grow one. */
check(() => {
  assert.deepEqual([...encodeText('a', { encoding: 'utf8', bom: false })], [0x61])
  assert.deepEqual([...encodeText('a', { encoding: 'utf8', bom: true })], [0xEF, 0xBB, 0xBF, 0x61])
})

/* ---- refusal ---- */

/* A character the file's own encoding cannot spell is refused, not replaced
   with a question mark. The caller's answer is to offer UTF-8, which can spell
   anything; a substitution here would be the same silent loss from the other
   direction. */
check(() => {
  assert.throws(
    () => encodeText('Ω', { encoding: 'windows-1252' }),
    (err) => isUnencodableError(err) && err.character === 'Ω'
  )
  assert.throws(
    () => encodeText('日', { encoding: 'windows-1252' }),
    (err) => isUnencodableError(err)
  )
  // Astral planes are no more spellable than the BMP characters above.
  assert.throws(() => encodeText('😀', { encoding: 'windows-1252' }), isUnencodableError)
  // But everything the encoding does hold goes through.
  assert.equal(encodeText('naïve — “ok”', { encoding: 'windows-1252' }).length, 12)
})

check(() => {
  assert.throws(() => encodeText('a', { encoding: 'ebcdic' }), /Unknown encoding/)
})

/* Empty files decode to empty text and encode back to nothing, mark aside. */
check(() => {
  const read = decodeText(Buffer.alloc(0))
  assert.equal(read.text, '')
  assert.equal(read.encoding, 'utf8')
  assert.equal(read.clean, true)
  assert.equal(encodeText('', { encoding: 'utf8', bom: false }).length, 0)
})

/* A file that is nothing but a mark is a file with no text in it. */
check(() => {
  const read = decodeText(Buffer.from([0xEF, 0xBB, 0xBF]))
  assert.equal(read.text, '')
  assert.equal(read.bom, true)
})

console.log(`text encoding: ${checks} checks passed`)
