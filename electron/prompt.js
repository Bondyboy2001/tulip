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

/**
 * What is on screen, expressed as bounded context rather than an instruction.
 *
 * The note's own text is not here — see `quoted` below. The two are kept apart
 * because they change at different rates: the caret and the selection move with
 * every question asked, the text only when the note is edited. Quoted together,
 * a note the size of a book was sent again because the reader had moved their
 * cursor one line.
 */
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
  /* A file Tulip cannot show — a picture, a recording, an archive. Said as
     what it is, because the alternative is an `<open-note>` describing a JPEG
     as a note with no text in it. */
  if (context.kind === 'file') {
    const size = context.bytes ? `\n\nIt is ${context.bytes.toLocaleString('en-US')} bytes.` : ''
    return `<open-file>${context.note}\n\nThe reader has this open in Tulip's file viewer; it is ${context.shownAs === 'file' ? 'not something Tulip can display' : `shown as ${context.shownAs}`}. Tulip has quoted none of it — use your own tools if you need its contents.${size}</open-file>`
  }
  if (context.kind !== 'pdf') return `<open-note>${context.note}${caret}${selection}</open-note>`

  const where = `\n\nThe reader is on page ${context.page}${context.pages ? ` of ${context.pages}` : ''}.`
  const words = `\n\nIts text is in ${VAULT_CONTRACT.annotationDirectory}/${context.note}${VAULT_CONTRACT.pdfTextSuffix}.`
  return `<open-pdf>${context.note}${where}${words}${selection}</open-pdf>`
}

const isPdfAttachment = (file) => path.extname(String(file || '')).toLowerCase() === '.pdf'

/**
 * The open note's text, as its own block.
 *
 * Whole wherever it fits — the renderer decides that, and says which it sent.
 * An agent given the whole note answers from it; an agent given a window around
 * the cursor has to decide whether the answer is in the part it cannot see, and
 * the wording here is what tells it there is a part it cannot see.
 */
function noteBody (context) {
  if (!context?.excerpt) return ''
  if (!context.excerptCut) return `${context.note}, in full:\n${context.excerpt}`
  const size = context.noteChars?.toLocaleString?.('en-US') ?? 'a longer'
  return `${context.note}, around the cursor — ${context.excerpt.length.toLocaleString('en-US')} ` +
    `of ${size} characters shown, read the file for the rest:\n${context.excerpt}`
}

/**
 * A note is worth quoting whole, and worth quoting once.
 *
 * Unchanged since it was quoted, it is named. Changed, it is quoted again —
 * unless it is long, where re-sending a book because one line was edited is
 * exactly the cost this memory exists to avoid. There the agent is told the
 * copy it holds is stale and where the current text is, and it keeps being told
 * so until a version it has actually seen comes back around.
 */
const REQUOTE_LIMIT = 40000

function quoted (context, sent) {
  const block = noteBody(context)
  if (!block || !sent) return block
  if (sent.body === block) {
    return `The copy of ${context.note} quoted earlier in this conversation is still current.`
  }
  if (sent.body && block.length > REQUOTE_LIMIT) {
    return `${context.note} has changed since the copy quoted earlier and is too long to quote again — ` +
      'read the file for its current text.'
  }
  sent.body = block
  return block
}

/**
 * What a session has already put in front of the model, so it is not put there
 * twice. One of these per session — see `send` in ai.js.
 */
const nothingSent = () => ({ opened: '', body: '', pdfs: '', pages: '', rules: false })

/**
 * The turn, as the CLI will read it.
 *
 * Every CLI here resumes its thread rather than being told the conversation
 * again, so everything sent on an earlier turn is still in front of the model —
 * and is re-sent, by the CLI, on every turn after it. That makes a block
 * repeated per turn cost the square of the conversation's length: the open note
 * is quoted whole, the ranked PDF pages run to fifteen thousand characters, and
 * twenty turns of them is a megabyte of context nobody asked two questions
 * about. So `sent` remembers what this session has already said, and anything
 * unchanged since is named in a line instead of quoted again. That memory is
 * what pays for the note being sent whole in the first place.
 *
 * With no memory passed — the tests, and the first turn of any thread — the
 * whole thing goes, which is what makes the naming below true afterwards.
 */
function promptFor (text, context, sent = null) {
  const ordinaryAttachments = Array.isArray(context?.attachments)
    ? context.attachments.filter((file) => !isPdfAttachment(file))
    : []
  /* Small ones arrive already read — see `inlineAttachments` in main.js. Quoted
     here rather than named, because a file the prompt can carry whole is one
     the agent should not have to spend a round trip asking for. */
  const inlined = new Map((Array.isArray(context?.attachmentTexts) ? context.attachmentTexts : [])
    .map((file) => [file.path, file.text]))
  const quotedAttachments = ordinaryAttachments
    .filter((file) => inlined.has(file))
    .map((file) => `${file}:\n\`\`\`\n${inlined.get(file)}\n\`\`\``)
  const namedAttachments = ordinaryAttachments.filter((file) => !inlined.has(file))

  /* Not deduplicated: an attachment is named by the message that attached it,
     and the file it points at may have changed since. */
  const attachments = [
    quotedAttachments.length
      ? `The user attached ${quotedAttachments.length === 1 ? 'this file' : 'these files'}:\n\n` +
        quotedAttachments.join('\n\n')
      : '',
    namedAttachments.length
      ? `The user attached ${namedAttachments.length === 1 ? 'a file' : 'files'}. ` +
        `Open ${namedAttachments.length === 1 ? 'it' : 'them'} with your file-reading tool:\n` +
        namedAttachments.map((file) => `- ${file}`).join('\n')
      : ''
  ].filter(Boolean).join('\n\n')
  const pdfs = Array.isArray(context?.pdfDocuments) && context.pdfDocuments.length
    ? `PDF documents are ready as page-marked text${context.pdfDocuments.some((pdf) => pdf.ocrPages) ? ', with Vision OCR where needed' : ''}:\n` +
      context.pdfDocuments.map((pdf) =>
        `- ${pdf.path}: ${pdf.textPath}${pdf.pages ? ` (${pdf.pages} pages)` : ''}`).join('\n') +
      '\n\nRead single pages, never the whole file: `grep -n \'^--- page \' <textPath>` finds the page markers with line numbers; then `sed -n \'START,ENDp\' <textPath>` reads one page.'
    : ''

  /* A block, or a line saying it is already there. The memory is written as the
     prompt is built rather than after it is sent: a turn that fails to spawn
     never reaches the model, and the next one has to carry the whole block —
     `send` clears the memory on a failure for exactly that reason. */
  const once = (key, block, instead) => {
    if (!sent || !block) return block
    if (sent[key] === block) return instead
    sent[key] = block
    return block
  }

  const open = once('opened', context?.note ? opened(context) : '',
    `The open document is still ${context?.note}, at the same place in it.`)
  const body = quoted(context, sent)
  const ready = once('pdfs', pdfs,
    'The same PDF text files as before are ready; read single pages from them as described earlier.')
  const pages = once('pages', context?.pdfContext || '',
    'The pages worth reading are the ones already quoted in this conversation.')

  /* The rules are a standing instruction, and a thread that has them keeps
     them. Repeating them every turn bought nothing and was charged for each
     time. */
  const rules = sent?.rules ? '' : TURN_RULES
  if (sent) sent.rules = true

  return [open, body, attachments, ready, pages, rules, text]
    .filter(Boolean).join('\n\n')
}

module.exports = { systemPrompt, turnRules: TURN_RULES, promptFor, nothingSent }
