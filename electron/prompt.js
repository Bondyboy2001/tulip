'use strict'

/**
 * The words Tulip gives its Copilot.
 *
 * The editable briefing lives in prompt.md. This module only fills values from
 * Tulip's shared contracts and adds the bounded current-document context.
 */

const fs = require('node:fs')
const path = require('node:path')
const VAULT_CONTRACT = require('./vault-contract.json')
const RUNNABLE = require('./runnable-languages.json')

/* These values are derived from the same contracts as Tulip's UI so the
   prompt cannot quietly drift from the table, runner and callout features. */
const VOCABULARY_COLUMNS = VAULT_CONTRACT.languageTableTemplates.vocabulary
  .split('\n')[0].split('|').map((cell) => cell.trim()).filter(Boolean)
const RUNNABLE_LANGUAGES = Object.values(RUNNABLE.runners).map((names) => names[0])
const DRAWN_LANGUAGES = Object.values(RUNNABLE.drawn)
const CALLOUT_KINDS = require('./callout-kinds.json').kinds.map((kind) => kind.id)

/* In the packaged app this sits beside this loader. The second path keeps the
   source test bundle working after esbuild moves its JavaScript into .cache. */
const promptPath = [
  path.join(__dirname, 'prompt.md'),
  path.join(process.cwd(), 'electron', 'prompt.md')
].find((candidate) => fs.existsSync(candidate))

if (!promptPath) throw new Error('Tulip Copilot prompt.md is missing.')

const PROMPT_TEMPLATE = fs.readFileSync(promptPath, 'utf8').trim()
const TURN_RULES_MATCH = /<!-- turn-rules:start -->([\s\S]*?)<!-- turn-rules:end -->/.exec(PROMPT_TEMPLATE)
if (!TURN_RULES_MATCH) throw new Error('Tulip Copilot prompt.md has no turn-rules block.')

const TURN_RULES = TURN_RULES_MATCH[1].trim()
const replace = (source, values) => source.replace(/{{([a-zA-Z]+)}}/g, (_match, key) => {
  if (!(key in values)) throw new Error(`Unknown Copilot prompt value: ${key}`)
  return String(values[key])
})

const SYSTEM_TEMPLATE = replace(
  PROMPT_TEMPLATE
    .replace('<!-- turn-rules:start -->', '')
    .replace('<!-- turn-rules:end -->', ''),
  {
    vault: '{{vault}}',
    noteExtensions: VAULT_CONTRACT.noteExtensions.join(', '),
    calloutKinds: CALLOUT_KINDS.join(', '),
    runnableLanguages: RUNNABLE_LANGUAGES.join(', '),
    drawnLanguages: DRAWN_LANGUAGES.join(', '),
    languageTableSuffix: VAULT_CONTRACT.languageTableSuffix,
    vocabularyColumns: VOCABULARY_COLUMNS.join(', '),
    firstVocabularyColumn: VOCABULARY_COLUMNS[0],
    secondVocabularyColumn: VOCABULARY_COLUMNS[1],
    texExtension: VAULT_CONTRACT.texExtension,
    pdfExtension: VAULT_CONTRACT.pdfExtension,
    annotationDirectory: VAULT_CONTRACT.annotationDirectory,
    pdfTextSuffix: VAULT_CONTRACT.pdfTextSuffix,
    whiteboardExtension: VAULT_CONTRACT.whiteboardExtension,
    siteExtension: VAULT_CONTRACT.siteExtension,
    attachmentDirectory: VAULT_CONTRACT.attachmentDirectory
  }
)

/* All contract values are static for the process. A new Copilot session only
   supplies its vault path instead of walking the full placeholder set again. */
const systemPrompt = (dir) => SYSTEM_TEMPLATE.replace('{{vault}}', String(dir))

/** What is on screen, expressed as bounded context rather than an instruction. */
function opened (context) {
  const selection = context.selection
    ? `\n\nSelected text${context.truncated ? ' (cut short — ask to read the file for the rest)' : ''}:\n${context.selection}`
    : ''
  const caret = !context.selection && context.line
    ? `\n\nTheir cursor is on line ${context.line}${context.heading ? `, under the heading “${context.heading}”` : ''}.`
    : ''
  if (context.kind === 'language') {
    return `<open-language-table>${context.note}${selection}</open-language-table>`
  }
  if (context.kind === 'tex') {
    return `<open-tex-document>${context.note}${caret}${selection}</open-tex-document>`
  }
  if (context.kind === 'site') {
    const title = context.title ? `\n\nThe page is titled “${context.title}”.` : ''
    return `<open-website>${context.note}\n\nThe reader is looking at ${context.url || 'no page yet'}.${title}</open-website>`
  }
  if (context.kind === 'whiteboard') {
    const text = context.text ? `\n\nBoard text:\n${context.text}` : ''
    const count = `\n\nThe board has ${context.elements || 0} elements.`
    return `<open-whiteboard>${context.note}${count}${selection}${text}</open-whiteboard>`
  }
  if (context.kind !== 'pdf') return `<open-note>${context.note}${caret}${selection}</open-note>`

  const where = `\n\nThe reader is on page ${context.page}${context.pages ? ` of ${context.pages}` : ''}.`
  const words = `\n\nIts text is in ${VAULT_CONTRACT.annotationDirectory}/${context.note}${VAULT_CONTRACT.pdfTextSuffix}.`
  return `<open-pdf>${context.note}${where}${words}${selection}</open-pdf>`
}

const isPdfAttachment = (file) => path.extname(String(file || '')).toLowerCase() === '.pdf'

function promptFor (text, context) {
  const ordinaryAttachments = Array.isArray(context?.attachments)
    ? context.attachments.filter((file) => !isPdfAttachment(file))
    : []
  const attachments = ordinaryAttachments.length
    ? `The user attached ${ordinaryAttachments.length === 1 ? 'a file' : 'files'}. ` +
      `Open ${ordinaryAttachments.length === 1 ? 'it' : 'them'} with your file-reading tool:\n` +
      ordinaryAttachments.map((file) => `- ${file}`).join('\n')
    : ''
  const pdfs = Array.isArray(context?.pdfDocuments) && context.pdfDocuments.length
    ? `PDF documents are ready as page-marked text${context.pdfDocuments.some((pdf) => pdf.ocrPages) ? ', with Vision OCR where needed' : ''}:\n` +
      context.pdfDocuments.map((pdf) => `- ${pdf.path}: ${pdf.textPath}`).join('\n')
    : ''

  return [
    context?.note ? opened(context) : '', attachments, pdfs,
    context?.pdfContext || '', TURN_RULES, text
  ].filter(Boolean).join('\n\n')
}

module.exports = { systemPrompt, turnRules: TURN_RULES, promptFor }
