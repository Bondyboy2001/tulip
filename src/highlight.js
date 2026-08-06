/* ============================================================ highlight
   One token spec, two consumers: CodeMirror styles the live document with it,
   and the reading view runs the same lezer parsers over the same spec to build
   static spans. Both land on the same `.hl-*` classes, so a colour is changed
   in exactly one place — the stylesheet.
   ================================================================== */

import { tags as t, tagHighlighter, highlightCode } from '@lezer/highlight'
import { languageId } from './languages.js'

export const codeTokens = [
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword,
          t.moduleKeyword, t.modifier, t.self], class: 'hl-keyword' },
  { tag: [t.atom, t.bool, t.null, t.unit, t.constant(t.variableName),
          t.standard(t.variableName)], class: 'hl-atom' },
  { tag: [t.number, t.integer, t.float, t.color], class: 'hl-number' },
  { tag: [t.string, t.docString, t.character, t.attributeValue], class: 'hl-string' },
  { tag: [t.regexp, t.escape, t.special(t.string)], class: 'hl-string2' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'hl-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
    class: 'hl-function' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], class: 'hl-def' },
  { tag: [t.typeName, t.className, t.namespace], class: 'hl-type' },
  { tag: [t.propertyName, t.attributeName], class: 'hl-property' },
  { tag: t.tagName, class: 'hl-tag' },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator,
          t.compareOperator, t.updateOperator, t.definitionOperator,
          t.bitwiseOperator, t.typeOperator, t.controlOperator], class: 'hl-operator' },
  { tag: [t.punctuation, t.separator, t.bracket, t.angleBracket, t.squareBracket,
          t.paren, t.brace], class: 'hl-punct' },
  // processingInstruction and labelName are left alone: lezer-markdown uses
  // them for its own marks, which the live preview styles separately.
  { tag: [t.meta, t.documentMeta, t.annotation], class: 'hl-meta' },
  { tag: t.inserted, class: 'hl-inserted' },
  { tag: t.deleted, class: 'hl-deleted' },
  { tag: t.changed, class: 'hl-changed' },
  { tag: t.invalid, class: 'hl-invalid' }
]

const staticHighlighter = tagHighlighter(codeTokens)

/* A block that leaves Reading view's extended viewport gives its highlighted
   DOM back so a long note does not retain thousands of spans. Scrolling back
   used to parse the identical source again before rebuilding those spans. Keep
   the parser's small, inert answer instead: text and class names, never DOM.

   The cache is byte-bounded as well as entry-bounded because one 100 kB block
   is not the same memory promise as one ten-line snippet. Map insertion order
   is the LRU; a hit is reinserted at the end. */
const tokenCache = new Map()
const TOKEN_CACHE_ENTRIES = 96
const TOKEN_CACHE_BYTES = 2 * 1024 * 1024
let tokenCacheBytes = 0

function tokenKey (language, code) {
  return `${language}\0${code}`
}

function cachedTokens (key) {
  const hit = tokenCache.get(key)
  if (!hit) return null
  tokenCache.delete(key)
  tokenCache.set(key, hit)
  return hit.tokens
}

function rememberTokens (key, code, tokens) {
  /* UTF-16 strings are two bytes per code unit. Class names are shared literals
     in practice, but counting them too keeps the bound conservative. */
  const bytes = 2 * (key.length + code.length +
    tokens.reduce((sum, token) => sum + token.text.length + token.classes.length, 0))
  if (bytes > TOKEN_CACHE_BYTES) return

  tokenCache.set(key, { tokens, bytes })
  tokenCacheBytes += bytes
  while (tokenCache.size > TOKEN_CACHE_ENTRIES || tokenCacheBytes > TOKEN_CACHE_BYTES) {
    const oldest = tokenCache.keys().next().value
    const dropped = tokenCache.get(oldest)
    tokenCache.delete(oldest)
    tokenCacheBytes -= dropped.bytes
  }
}

/* Exported only as observability for the focused regression/benchmark script.
   Production callers use highlightInto; exposing counts avoids timing-based
   correctness tests. */
export function highlightCacheStats () {
  return { entries: tokenCache.size, bytes: tokenCacheBytes }
}

export function clearHighlightCache () {
  tokenCache.clear()
  tokenCacheBytes = 0
}

/* A language pack is a dynamic import; two blocks of the same language in one
   note must not each pay for it, and must not each start their own request. */
const loading = new Map()

function support (desc) {
  if (desc.support) return desc.support
  if (!loading.has(desc.name)) {
    const request = desc.load()
    /* A failed fetch must not be remembered as the answer — cached, it turned
       one offline moment into a language that never highlighted again. The
       next block asks fresh. */
    request.catch(() => loading.delete(desc.name))
    loading.set(desc.name, request)
  }
  return loading.get(desc.name)
}

/* Parsing is linear but not free, and a pasted 200kB payload is not something
   anyone reads token by token. */
const MAX_HIGHLIGHT = 120_000

/* Fences whose word names something Tulip does with the block rather than the
   language it is written in. A Manim scene is Python and a TikZ picture is
   LaTeX — they are called what they are because of what Tulip renders them
   into — so they are parsed as the languages they are written in. An SVG
   drawing is XML for the same reason, and a three.js scene is JavaScript.

   Keyed on the canonical id as well as the raw word, so a kind with spellings
   of its own — `three`, `threejs`, `3js` — is one entry here rather than one
   per alias. languages.js already holds that list, and the second copy this
   avoids is the kind that silently stops colouring when the first one grows. */
/* `cuda` is here for the same reason as the rest: language-data has no CUDA
   parser, and its fuzzy matcher answers nothing for the word. The C++ parser
   is the right one — a .cu file is C++ plus `__global__`, `<<<…>>>` and the
   builtin variables, none of which stop it parsing. */
const FENCE_ALIAS = { manim: 'python', tikz: 'latex', svg: 'xml', three: 'javascript', cuda: 'cpp' }
const descriptions = new Map()

/* ------------------------------------------------- the language registry

   `LanguageDescription` comes from @codemirror/language, which imports
   @codemirror/view: naming it in an import at the top of this file put the
   whole editing stack — half of everything the app compiles at launch — behind
   the reading view, which needs this module to colour a code block.

   So it arrives one of two ways, and never at startup:

   - the editor primes it as it loads (`primeLanguageDescription`), because it
     holds the real import anyway and its parser calls `languageFor`
     synchronously, with no await to hide a fetch behind;
   - the reading view awaits `languageSupport()` before colouring, which is a
     no-op once the editor has been anywhere near.

   Both settle on the same class. Fetching it twice would be worse than a
   wasted request: two `LanguageDescription`s are two different types, and the
   matcher would stop recognising its own descriptions. */
let LanguageDescription = null
let arriving = null

/** Called by editor.js at load, with the class it already has to hand. */
export function primeLanguageDescription (cls) {
  LanguageDescription ||= cls
}

/** The class, fetched if the editor has not already supplied it. */
async function languageSupport () {
  if (LanguageDescription) return LanguageDescription
  arriving ||= import('@codemirror/language').then((mod) => {
    LanguageDescription ||= mod.LanguageDescription
    return LanguageDescription
  })
  return arriving
}

/**
 * The parser for a fence's language word, aliases resolved. Both views ask
 * through here, so a word that colours in one of them colours in the other.
 */
export function languageFor (token) {
  const word = String(token || '').trim().split(/\s+/)[0].toLowerCase()
  if (!word) return null
  /* The chip table's aliases are the vault's dialect — `py`, `jl`, `rs` — and
     language-data's matcher knows none of them: it never consults extensions,
     only names and its own aliases. Asking with the raw word alone left half
     the spellings languages.js blesses (and three that run) without colours
     in either view, so the chip table's canonical id stands behind the word.
     The word as written is still tried first: `cmake`, `postgresql`, `less`
     name dialect parsers of their own that the canonical id folds away. */
  const name = FENCE_ALIAS[word] || FENCE_ALIAS[languageId(word)] || word
  const canon = name === word ? languageId(word) : name
  /* Plain text is the one id that must not reach the fuzzy matcher: "text"
     contains "tex", which language-data reads as LaTeX, and a block that says
     it is plain came out coloured as maths. */
  if (canon === 'text') return null
  if (!descriptions.has(name)) {
    descriptions.set(name, LanguageDescription.of({
      name,
      alias: [name],
      async load () {
        const { languages } = await import('@codemirror/language-data')
        const real = LanguageDescription.matchLanguageName(languages, name, true) ||
          (canon && canon !== name &&
            LanguageDescription.matchLanguageName(languages, canon, true)) || null
        if (!real) throw new Error(`Unknown code language: ${name}`)
        return support(real)
      }
    }))
  }
  return descriptions.get(name)
}

/**
 * Replace `el`'s contents with highlighted spans for `code`.
 *
 * @returns {Promise<boolean>} false when the language is unknown, the block is
 *   oversized, or the element left the document while its parser loaded.
 */
export async function highlightInto (el, code, token) {
  if (!token || code.length > MAX_HIGHLIGHT) return false

  // Before `languageFor`, which cannot build a description without it.
  await languageSupport()
  const desc = languageFor(token)
  if (!desc) return false

  let support_
  try {
    support_ = await support(desc)
  } catch {
    return false
  }
  if (!el.isConnected) return false

  const key = tokenKey(desc.name, code)
  let tokens = cachedTokens(key)
  if (!tokens) {
    const tree = support_.language.parser.parse(code)
    tokens = []
    highlightCode(
      code,
      tree,
      staticHighlighter,
      (text, classes) => tokens.push({ text, classes: classes || '' }),
      () => tokens.push({ text: '\n', classes: '' })
    )
    rememberTokens(key, code, tokens)
  }

  /* Loading a language may have yielded long enough for the note to change.
     The earlier check protects the parse; this one protects the DOM write. */
  if (!el.isConnected) return false
  const frag = document.createDocumentFragment()

  for (const token of tokens) {
    if (!token.classes) { frag.append(document.createTextNode(token.text)); continue }
    const span = document.createElement('span')
    span.className = token.classes
    span.textContent = token.text
    frag.append(span)
  }

  el.replaceChildren(frag)
  return true
}
