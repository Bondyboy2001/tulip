'use strict'

/* ================================================== what the bytes say

   Every text file the vault opens used to be read as UTF-8 and written back as
   UTF-8, with no step in between that asked whether it was. For a note that is
   right — the app wrote it and the app writes it again — but the vault also
   holds files it did not write, and the one kind people hand it in quantity is
   a spreadsheet export. Excel on a Western Windows still writes `.csv` in
   windows-1252 by default, and it still writes UTF-8 with a byte-order mark so
   it can recognise its own work later.

   Read as UTF-8, a cp1252 export opens with U+FFFD wherever an accent was, and
   the next autosave writes those replacement characters back over the reader's
   data — silently, permanently, and without anyone having touched the cell. The
   BOM has the same shape in reverse: dropped on read and not restored on write,
   a file Excel understood becomes one it opens as mojibake.

   So the bytes are asked. `decodeText` reports the encoding it chose, whether a
   mark preceded it, which line ending the file uses, and — the part that
   matters most — whether the decode was lossless. A caller told `clean: false`
   knows that saving would destroy something, and can decline. */

/** The characters windows-1252 puts in 0x80–0x9F, where Latin-1 has controls.
 *  The rest of the range is Latin-1, which is the identity mapping.
 *
 *  `null` marks the five slots the original Microsoft code page left undefined.
 *  The encoding standard the platform's decoder implements does not leave them
 *  undefined: it maps each to the C1 control of the same number, which makes
 *  windows-1252 a total map over all 256 bytes. That is worth having exactly
 *  because it means no file can fail to decode under it — so the fallback below
 *  never loses a byte — and the encoder here is built to be its precise
 *  inverse, nulls included, or a round trip would not come back. */
const CP1252_HIGH = [
  0x20AC, null, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017D, null,
  null, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, null, 0x017E, 0x0178
]

/** codepoint → byte, for the encoder. Built once. */
const CP1252_BY_CODEPOINT = (() => {
  const map = new Map()
  for (let byte = 0; byte < 0x80; byte++) map.set(byte, byte)
  for (let byte = 0xA0; byte <= 0xFF; byte++) map.set(byte, byte)
  CP1252_HIGH.forEach((codepoint, i) => {
    map.set(codepoint === null ? 0x80 + i : codepoint, 0x80 + i)
  })
  return map
})()

const ENCODINGS = new Set(['utf8', 'utf16le', 'utf16be', 'windows-1252'])

/** The mark, if the file opens with one. */
function readBom (buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return { encoding: 'utf8', length: 3 }
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return { encoding: 'utf16le', length: 2 }
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return { encoding: 'utf16be', length: 2 }
  }
  return null
}

const bomBytes = (encoding) => {
  if (encoding === 'utf8') return Buffer.from([0xEF, 0xBB, 0xBF])
  if (encoding === 'utf16le') return Buffer.from([0xFF, 0xFE])
  if (encoding === 'utf16be') return Buffer.from([0xFE, 0xFF])
  return Buffer.alloc(0)
}

/** Whether every byte of `buffer` is a well-formed UTF-8 sequence. The strict
 *  decoder answers this exactly, and answering it any other way is how a file
 *  that is *nearly* UTF-8 gets called UTF-8. */
function isUtf8 (buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/**
 * Which encoding a file of unknown provenance is written in.
 *
 * A mark settles it outright. Failing that, valid UTF-8 is UTF-8 — the
 * encoding is self-checking, and a byte sequence that decodes cleanly under it
 * is essentially never anything else. Everything left is a single-byte legacy
 * encoding, and windows-1252 is the one Western exports are written in; it is
 * also a superset of Latin-1 in the range that matters, so choosing it cannot
 * be worse than choosing Latin-1.
 *
 * Note what is deliberately not attempted: guessing between windows-1252,
 * windows-1251 and Shift-JIS by letter frequency. A wrong guess there produces
 * text that looks like text, which is far worse than one that looks wrong.
 */
function detectEncoding (buffer) {
  const bom = readBom(buffer)
  if (bom) return { encoding: bom.encoding, bom: true, skip: bom.length }
  if (isUtf8(buffer)) return { encoding: 'utf8', bom: false, skip: 0 }
  return { encoding: 'windows-1252', bom: false, skip: 0 }
}

/** The line ending most of the file uses. A file is allowed to be inconsistent;
 *  what is wanted is the one to write back, so the majority wins. */
function detectNewline (text) {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r') {
      if (text[i + 1] === '\n') { crlf++; i++ } else cr++
    } else if (ch === '\n') lf++
  }
  if (crlf >= lf && crlf >= cr && crlf > 0) return '\r\n'
  if (cr > lf && cr > 0) return '\r'
  return '\n'
}

/**
 * A file's bytes as text, with everything the writer will need to put it back
 * the way it was found.
 *
 * `clean` is the promise the caller actually depends on: false means the bytes
 * did not decode losslessly under the encoding finally chosen, so somewhere in
 * the returned string is a U+FFFD that was not in the file. Writing that string
 * back would make the replacement permanent, and a caller told this should
 * decline to save rather than ask.
 *
 * In practice it can only be false for a file that carries a mark and then
 * contradicts it — a UTF-8 mark over bytes that are not UTF-8, or an odd-length
 * UTF-16 body. The unmarked fallback is windows-1252, which has a meaning for
 * every one of the 256 bytes and therefore cannot fail. What that fallback
 * cannot promise is that it is *right*: a Cyrillic windows-1251 export read
 * this way round-trips byte for byte and still reads as nonsense on screen.
 * That is a limit of guessing, not a decode error, and it is why nothing here
 * tries to tell one single-byte encoding from another by frequency.
 */
function decodeText (buffer) {
  const { encoding, bom, skip } = detectEncoding(buffer)
  const body = skip ? buffer.subarray(skip) : buffer
  const label = encoding === 'utf8' ? 'utf-8'
    : encoding === 'utf16le' ? 'utf-16le'
      : encoding === 'utf16be' ? 'utf-16be'
        : 'windows-1252'
  let text
  let clean = true
  try {
    text = new TextDecoder(label, { fatal: true }).decode(body)
  } catch {
    text = new TextDecoder(label).decode(body)
    clean = false
  }
  return { text, encoding, bom, newline: detectNewline(text), clean }
}

/** Thrown when a character in the buffer has no spelling in the file's own
 *  encoding — a € typed into a Latin-1 export, say. Named so the caller can
 *  tell it apart from a disk failure and offer to save as UTF-8 instead. */
class UnencodableError extends Error {
  constructor (character, encoding) {
    super(`“${character}” cannot be written in ${encoding}.`)
    this.name = 'UnencodableError'
    this.character = character
    this.encoding = encoding
  }
}

const isUnencodableError = (err) => err instanceof UnencodableError ||
  err?.name === 'UnencodableError'

/**
 * Text back into the bytes the file was read as.
 *
 * Refuses rather than substitutes. A `?` written where a character was is the
 * same silent data loss the U+FFFD above was, only arriving from the other
 * direction, and the caller has a better answer available — offer to save the
 * file as UTF-8, which can spell anything.
 */
function encodeText (text, { encoding = 'utf8', bom = false } = {}) {
  const value = String(text ?? '')
  if (!ENCODINGS.has(encoding)) throw new Error(`Unknown encoding ${encoding}.`)
  const mark = bom ? bomBytes(encoding) : Buffer.alloc(0)
  if (encoding === 'utf8') return Buffer.concat([mark, Buffer.from(value, 'utf8')])
  if (encoding === 'utf16le') return Buffer.concat([mark, Buffer.from(value, 'utf16le')])
  if (encoding === 'utf16be') {
    const little = Buffer.from(value, 'utf16le')
    const big = Buffer.allocUnsafe(little.length)
    for (let i = 0; i + 1 < little.length; i += 2) {
      big[i] = little[i + 1]
      big[i + 1] = little[i]
    }
    return Buffer.concat([mark, big])
  }
  const out = Buffer.allocUnsafe(value.length)
  let n = 0
  for (const character of value) {
    const byte = CP1252_BY_CODEPOINT.get(character.codePointAt(0))
    if (byte === undefined) throw new UnencodableError(character, encoding)
    out[n++] = byte
  }
  return Buffer.concat([mark, out.subarray(0, n)])
}

module.exports = {
  detectEncoding,
  detectNewline,
  decodeText,
  encodeText,
  UnencodableError,
  isUnencodableError
}
