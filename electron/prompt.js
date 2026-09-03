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

const replace = (source, values) => source.replace(/{{([a-zA-Z]+)}}/g, (_match, key) => {
  if (!(key in values)) throw new Error(`Unknown Copilot prompt value: ${key}`)
  return String(values[key])
})

/* Read and filled on first use, not at require time. This module sits in
   main's top-of-file require graph (via ai.js), and the synchronous read of
   prompt.md was a disk touch on every launch paid before the window existed —
   for a file only the first Copilot turn needs. The cost of laziness is that
   a missing or mangled prompt.md now surfaces at that first turn instead of
   at boot, with the same message. */
let loaded = null
const template = () => {
  if (loaded) return loaded

  /* In the packaged app this sits beside this loader. The second path keeps
     the source test bundle working after esbuild moves its JavaScript into
     .cache. */
  const promptPath = [
    path.join(__dirname, 'prompt.md'),
    path.join(process.cwd(), 'electron', 'prompt.md')
  ].find((candidate) => fs.existsSync(candidate))

  if (!promptPath) throw new Error('Tulip Copilot prompt.md is missing.')

  const PROMPT_TEMPLATE = fs.readFileSync(promptPath, 'utf8').trim()
  const TURN_RULES_MATCH = /<!-- turn-rules:start -->([\s\S]*?)<!-- turn-rules:end -->/.exec(PROMPT_TEMPLATE)
  if (!TURN_RULES_MATCH) throw new Error('Tulip Copilot prompt.md has no turn-rules block.')

  /* The rules come in three parts: the ones every mode gets, the ones that
     only make sense when the agent may write (the rename and search requests
     are *files it writes*, and a read-only agent that is told to write them
     fails the attempt and falls back to grep every turn), and the line that
     stands in for those when it may not. */
  const rules = TURN_RULES_MATCH[1]
  const section = (name) => {
    const found = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`).exec(rules)
    return found ? found[1].trim() : ''
  }
  const writeRules = section('write-rules')
  const readRules = section('read-rules')
  const shared = rules
    .replace(/<!-- write-rules:start -->[\s\S]*?<!-- write-rules:end -->\n?/, '')
    .replace(/<!-- read-rules:start -->[\s\S]*?<!-- read-rules:end -->\n?/, '')
    .trim()

  loaded = {
    turnRules: [shared, writeRules].filter(Boolean).join('\n'),
    readTurnRules: [shared, readRules].filter(Boolean).join('\n'),
    systemTemplate: fillContract(PROMPT_TEMPLATE
      .replace(/<!-- (?:turn|write|read)-rules:(?:start|end) -->\n?/g, ''))
  }
  return loaded
}

/** The standing rules for a mode: `read` gets the read-only set, everything
 *  else — `ask`, `auto`, or a caller that does not say — the full one. */
const turnRulesFor = (mode) => mode === 'read' ? template().readTurnRules : template().turnRules

const fillContract = (source) => replace(
  source,
  {
    vault: '{{vault}}',
    noteExtensions: VAULT_CONTRACT.noteExtensions.join(', '),
    calloutKinds: CALLOUT_KINDS.join(', '),
    runnableLanguages: RUNNABLE_LANGUAGES.join(', '),
    drawnLanguages: DRAWN_LANGUAGES.join(', '),
    flashcardExtension: VAULT_CONTRACT.flashcardExtension,
    codeExtensionCount: VAULT_CONTRACT.codeExtensions.length,
    languageTableSuffix: VAULT_CONTRACT.languageTableSuffix,
    vocabularyColumns: VOCABULARY_COLUMNS.join(', '),
    firstVocabularyColumn: VOCABULARY_COLUMNS[0],
    secondVocabularyColumn: VOCABULARY_COLUMNS[1],
    texExtension: VAULT_CONTRACT.texExtension,
    pdfExtension: VAULT_CONTRACT.pdfExtension,
    annotationDirectory: VAULT_CONTRACT.annotationDirectory,
    pdfTextSuffix: VAULT_CONTRACT.pdfTextSuffix,
    whiteboardExtension: VAULT_CONTRACT.whiteboardExtension,
    notebookExtension: VAULT_CONTRACT.notebookExtension,
    docxExtension: VAULT_CONTRACT.docxExtension,
    dataExtensions: Object.keys(VAULT_CONTRACT.dataExtensions).join(', '),
    siteExtension: VAULT_CONTRACT.siteExtension,
    attachmentDirectory: VAULT_CONTRACT.attachmentDirectory
  }
)

/* All contract values are static for the process. A new Copilot session only
   supplies its vault path instead of walking the full placeholder set again. */
const systemPrompt = (dir) => template().systemTemplate.replace('{{vault}}', String(dir))

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
  if (context.kind === 'flashcards') {
    return `<open-flashcard-bank>${context.note}${selection}</open-flashcard-bank>`
  }
  if (context.kind === 'tex') {
    return `<open-tex-document>${context.note}${caret}${selection}</open-tex-document>`
  }
  /* Unlike a text note, a Word file is a zip container. The renderer has
     already extracted the readable text, so keep it with the document shape
     instead of dropping it into an empty, misleading <open-note>. */
  if (context.kind === 'docx') {
    const title = context.title ? `\n\nThe document is titled “${context.title}”.` : ''
    const words = `\n\nIt has ${Number(context.words || 0).toLocaleString('en-US')} words.`
    const position = context.at
      ? `\n\nThe reader is at paragraph ${context.at}${context.paragraphs ? ` of ${context.paragraphs}` : ''}.`
      : ''
    const text = context.text
      ? `\n\nDocument text around that paragraph${context.truncated ? ' (cut short — use Tulip’s document tools for the rest)' : ''}:\n${context.text}`
      : ''
    return `<open-word-document>${context.note}${title}${words}${position}${selection}${text}</open-word-document>`
  }
  if (context.kind === 'site') {
    const title = context.title ? `\n\nThe page is titled “${context.title}”.` : ''
    /* The page's own words, when the viewer could read them out of the guest.
       Without this the model was told an address and nothing else, and had to
       answer questions about a page it could not see — which it did, from
       whatever it remembered of the site, with no way for the reader to tell
       the difference. */
    const text = context.text
      ? `\n\nWhat the page says${context.truncated ? ' (cut short)' : ''}:\n${context.text}`
      : ''
    return `<open-website>${context.note}\n\nThe reader is looking at ${context.url || 'no page yet'}.${title}${text}</open-website>`
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
  /* The grid on screen, by its shape. The file itself is the agent's to read;
     what it cannot get cheaply is what the grid already shows — the column
     headings and enough rows to know what they hold. */
  if (context.kind === 'data') {
    const shape = `\n\nThe grid shows ${Number(context.rows || 0).toLocaleString('en-US')} rows` +
      ` in ${Number(context.columns || 0).toLocaleString('en-US')} columns.`
    const cell = context.atRow
      ? `\n\nThe active cell is row ${context.atRow}, ${context.column ? `column “${context.column}”` : `column ${context.atColumn}`}` +
        `${context.value ? `, with value “${context.value}”` : ''}.`
      : ''
    const state = context.shownRows && context.shownRows !== context.rows
      ? `\n\nThe current view shows ${context.shownRows} of ${context.rows} rows.`
      : ''
    const order = context.sortedBy?.length ? ` Sorted by ${context.sortedBy.join(', ')}.` : ''
    const filters = context.filteredBy?.length ? ` Filtered by ${context.filteredBy.join(', ')}.` : ''
    const preview = context.text
      ? `\n\nIts headings and rows around the active cell${context.truncated ? ' (cut short — read the file for the rest)' : ''}:\n${context.text}`
      : ''
    return `<open-data-file>${context.note}${shape}${cell}${state}${order}${filters}${preview}</open-data-file>`
  }
  /* A notebook's one expensive fact: the cells as source, without the base64
     the outputs are stored as. An agent that reads the raw .ipynb instead
     pays for every plot in it. */
  if (context.kind === 'notebook') {
    const shape = `\n\nIt has ${Number(context.cells || 0).toLocaleString('en-US')} cells` +
      `${context.language ? `, in ${context.language}` : ''}.`
    const active = context.at ? `\n\nThe reader is in cell ${context.at}.` : ''
    const sources = context.text
      ? `\n\nCell sources around it${context.truncated ? ' (cut short — read the file for the rest, selectively)' : ''}:\n${context.text}`
      : ''
    return `<open-notebook>${context.note}${shape}${active}${sources}</open-notebook>`
  }
  if (context.sourceContext) {
    return `<open-source-file>${context.note}\n\nLanguage: ${context.kind}.${caret}${selection}</open-source-file>`
  }
  if (context.kind !== 'pdf') return `<open-note>${context.note}${caret}${selection}</open-note>`

  const where = `\n\nThe reader is on page ${context.page}${context.pages ? ` of ${context.pages}` : ''}.`
  const words = `\n\nIts text is in ${VAULT_CONTRACT.annotationDirectory}/${context.note}${VAULT_CONTRACT.pdfTextSuffix}.`
  return `<open-pdf>${context.note}${where}${words}${selection}</open-pdf>`
}

const isPdfAttachment = (file) =>
  path.extname(String(file || '')).toLowerCase() === VAULT_CONTRACT.pdfExtension

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

/**
 * How much of a long note's change is worth stating outright.
 *
 * Past this the edit is no longer an edit — it is most of a rewrite, and
 * quoting the middle of it says less than telling the agent to read the file.
 */
const PATCH_LIMIT = 4000

/**
 * What actually changed between two versions of a note, as the run in the
 * middle of them.
 *
 * A common prefix and a common suffix, which is the whole of what a text edit
 * usually is: a line retyped in a long document leaves everything above and
 * below it identical. Scanned by character rather than diffed properly —
 * nothing here needs to be minimal, only correct and cheap, and the answer is
 * used solely to decide whether the change is small enough to state.
 *
 * Null when the two are the same, or when what changed is too much of the note
 * to be worth quoting in place of it.
 */
function changedRun (before, after) {
  if (before === after) return null
  const max = Math.min(before.length, after.length)
  let head = 0
  while (head < max && before[head] === after[head]) head++
  let tail = 0
  while (tail < max - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const removed = before.length - head - tail
  const added = after.length - head - tail
  if (Math.max(removed, added) > PATCH_LIMIT) return null
  /* Widened to line boundaries. A run that starts mid-word reads as corruption,
     and the agent is being asked to apply this to a copy it holds. */
  const from = after.lastIndexOf('\n', head) + 1
  const to = added ? after.indexOf('\n', after.length - tail) : after.length - tail
  let text = after.slice(from, to === -1 || to < from ? after.length : to)
  /* Widening must not swallow the note. A document with no line breaks in it —
     one long paragraph, a minified block, a note written as a single line — has
     no boundary to widen to, so the search runs to both ends and hands back
     everything: the whole note, quoted under a sentence promising the change
     alone. Where that happens the run is used exactly as measured, unwidened. */
  if (text.length > PATCH_LIMIT) text = after.slice(head, after.length - tail)
  if (text.length > PATCH_LIMIT) return null
  /* A run that came out empty says nothing the caller can pass on — a deletion
     that took a whole line with it lands here — and an empty quote reads as a
     note that is now blank. Better to send them to the file. */
  return text ? { at: from, text, removed, added } : null
}

/**
 * A note is worth quoting whole, and worth quoting once.
 *
 * Unchanged since it was quoted, it is named. Changed and short, it is quoted
 * again. Changed and long, the change itself is stated where it is small enough
 * to state — which is the ordinary case, because the reason a long note is
 * being re-sent is almost always that one line of it was edited. Only when the
 * change is itself large does this fall back to telling the agent its copy is
 * stale and to go and read the file.
 */
function quoted (context, sent) {
  const block = noteBody(context)
  if (!block || !sent) return block
  if (sent.body === block) {
    return `The copy of ${context.note} quoted earlier in this conversation is still current.`
  }
  if (context.sourceContext && sent.body) {
    return `${context.note} has changed or the source window moved since the earlier excerpt. ` +
      'Read the file selectively for the current code.'
  }
  /* Changed since it was quoted. The change itself goes wherever it is small
     enough to state — at any size of note, not only the long ones: the reader
     editing the note they are asking about is the ordinary case, and requoting
     thirty thousand characters for one retyped line was most of what a
     conversation about a living note spent, times over on every turn, into a
     thread that re-sends all of it. Only a rewrite still pays for a full
     quote, and only a different document under the same thread starts over —
     which is what `bodyOf` guards: a diff of one note against another is not
     a change, it is nonsense wearing one's name. */
  if (sent.body && sent.bodyOf === context.note) {
    const run = changedRun(sent.body, block)
    if (run) {
      /* The memory moves to the new text even though the whole of it was not
         sent: the agent has been given everything it needs to hold the current
         version, so the next turn's comparison is against what it actually has. */
      sent.body = block
      return `${context.note} has changed since the copy quoted earlier. Everything else in it is ` +
        `unchanged; this is the part that is different now (${run.removed.toLocaleString('en-US')} ` +
        `characters replaced by ${run.added.toLocaleString('en-US')}):\n${run.text}`
    }
    if (block.length > REQUOTE_LIMIT) {
      return `${context.note} has changed since the copy quoted earlier and is too long to quote again — ` +
        'read the file for its current text.'
    }
  }
  sent.body = block
  sent.bodyOf = context.note
  return block
}

/**
 * What a session has already put in front of the model, so it is not put there
 * twice. One of these per session — see `send` in ai.js.
 */
const nothingSent = () => ({
  opened: '', body: '', bodyOf: '', pdfs: '', pageKeys: null, rules: false, rulesMode: null, turns: 0
})

/* The fixed lines `relevantPdfContext` (electron/pdf-context.js) builds its
   block out of, matched here to take the block apart again. The page texts in
   between may hold any prose at all — blank lines included — so the seams are
   the marker lines and the closing instruction's own words, never a split on
   whitespace. */
const PAGE_MARK = /^--- (.+) page (\d+) of \d+ ---$/gm
const PAGE_REVISION = /^<!-- tulip-pdf-revision:([^>]+) -->\s*$/m
const PAGES_CODA = 'Use these pages first.'

/**
 * The ranked pages, minus every page this thread has already been given.
 *
 * The ranking runs against each question, so the block differs every turn and
 * a memo that compares whole blocks never matched — six pages, fourteen
 * thousand characters, quoted again per follow-up into a thread that re-sends
 * everything it holds. Deduped by page instead: a page already in the thread
 * is named, not sent, and an agent that wants it sharper has the text file
 * listed above. A different slice of the same page counts as sent — what the
 * memo tracks is the page's presence in the thread, not the excerpt's edges.
 */
function freshPages (block, sent) {
  if (!block) return block
  const withoutRevisions = (text) => text.replace(/^<!-- tulip-pdf-revision:[^>]+ -->\s*\n?/gm, '')
  if (!sent) return withoutRevisions(block)
  if (!(sent.pageKeys instanceof Set)) sent.pageKeys = new Set()
  const marks = [...block.matchAll(PAGE_MARK)]
  if (!marks.length) return block

  const codaAt = block.lastIndexOf(`\n\n${PAGES_CODA}`)
  const end = codaAt > marks[marks.length - 1].index ? codaAt : block.length
  const lead = block.slice(0, marks[0].index).trim()
  const coda = codaAt > marks[marks.length - 1].index ? block.slice(codaAt).trim() : ''

  const kept = []
  const skipped = []
  marks.forEach((mark, at) => {
    const to = at + 1 < marks.length ? marks[at + 1].index : end
    const pageBlock = block.slice(mark.index, to).trim()
    const revision = pageBlock.match(PAGE_REVISION)?.[1] || ''
    const key = `${mark[1]}\u0000${mark[2]}\u0000${revision}`
    if (sent.pageKeys.has(key)) {
      skipped.push(`${mark[1]} page ${mark[2]}`)
      return
    }
    sent.pageKeys.add(key)
    kept.push(withoutRevisions(pageBlock))
  })

  if (!kept.length) {
    return `The pages ranked for this question — ${skipped.join(', ')} — were all quoted earlier ` +
      'in this conversation and are still in front of you; the text files above have the rest.'
  }
  const already = skipped.length
    ? `Already quoted earlier in this conversation, and still in front of you: ${skipped.join(', ')}.`
    : ''
  return [lead, ...kept, already, coda].filter(Boolean).join('\n\n')
}

/**
 * How many turns the rules are trusted to hold before they are said again.
 *
 * Sending them every turn was pure waste and is why they are remembered at all.
 * But a standing instruction stated once, forty turns and a hundred thousand
 * tokens of tool output ago, is not standing in any useful sense — it is
 * buried, and the behaviour it was holding in place drifts. Worse, the CLI
 * compacts its own thread when it fills, and a summary of "the rules" is not
 * the rules: the quiz-callout shape and the citation forms are exactly the
 * details a summary drops. So the block goes whole, every so often — it is a
 * few hundred tokens against a turn that re-sends the whole thread anyway,
 * and a one-line "the rules still apply" that pointed at a block compaction
 * had already thrown away was a reminder of nothing.
 */
const RULES_REMINDER_TURNS = 10

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
function promptFor (text, context, sent = null, { mode = null } = {}) {
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
  const body = context?.skipExcerpt ? '' : quoted(context, sent)
  const ready = once('pdfs', pdfs,
    'The same PDF text files as before are ready; read single pages from them as described earlier.')
  const pages = freshPages(context?.pdfContext || '', sent)

  /* The rules are a standing instruction, and a thread that has them keeps
     them. Repeating them every turn bought nothing and was charged for each
     time — but never repeating them at all lets them sink out of sight in a
     long conversation, so a line pointing back at them surfaces every so
     often. See `RULES_REMINDER_TURNS`. */
  let rules = turnRulesFor(mode)
  if (sent) {
    sent.turns = (sent.turns || 0) + 1
    /* Said whole again when the mode changed under a resumed thread — the
       rules the thread holds are the other mode's — and every so often
       regardless. */
    if (sent.rules && sent.rulesMode === mode) {
      rules = sent.turns % RULES_REMINDER_TURNS === 0 ? rules : ''
    }
    sent.rules = true
    sent.rulesMode = mode
  }

  return [open, body, attachments, ready, pages, rules, text]
    .filter(Boolean).join('\n\n')
}

module.exports = {
  systemPrompt,
  get turnRules () { return template().turnRules },
  turnRulesFor,
  RULES_REMINDER_TURNS,
  promptFor,
  nothingSent
}
