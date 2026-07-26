/* ============================================================ highlight
   One token spec, two consumers: CodeMirror styles the live document with it,
   and the reading view runs the same lezer parsers over the same spec to build
   static spans. Both land on the same `.hl-*` classes, so a colour is changed
   in exactly one place — the stylesheet.
   ================================================================== */

import { tags as t, tagHighlighter, highlightCode } from '@lezer/highlight'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

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

/* A language pack is a dynamic import; two blocks of the same language in one
   note must not each pay for it, and must not each start their own request. */
const loading = new Map()

function support (desc) {
  if (desc.support) return desc.support
  if (!loading.has(desc.name)) loading.set(desc.name, desc.load())
  return loading.get(desc.name)
}

/* Parsing is linear but not free, and a pasted 200kB payload is not something
   anyone reads token by token. */
const MAX_HIGHLIGHT = 120_000

/**
 * Replace `el`'s contents with highlighted spans for `code`.
 *
 * @returns {Promise<boolean>} false when the language is unknown, the block is
 *   oversized, or the element left the document while its parser loaded.
 */
export async function highlightInto (el, code, token) {
  if (!token || code.length > MAX_HIGHLIGHT) return false

  const desc = LanguageDescription.matchLanguageName(languages, token, true)
  if (!desc) return false

  let support_
  try {
    support_ = await support(desc)
  } catch {
    return false
  }
  if (!el.isConnected) return false

  const tree = support_.language.parser.parse(code)
  const frag = document.createDocumentFragment()

  highlightCode(
    code,
    tree,
    staticHighlighter,
    (text, classes) => {
      if (!classes) { frag.append(document.createTextNode(text)); return }
      const span = document.createElement('span')
      span.className = classes
      span.textContent = text
      frag.append(span)
    },
    () => frag.append(document.createTextNode('\n'))
  )

  el.replaceChildren(frag)
  return true
}
