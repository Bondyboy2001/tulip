/**
 * The copilot's parsers, checked against what the CLI actually says.
 *
 * Everything the panel knows about a turn arrives through a handful of
 * hand-rolled readers — a line-splitter over a pipe, the catalogue parser, the
 * reader that trims what a tool said — plus one regular expression tried at
 * every `[` of every reply. None of them is reachable from the six calls
 * electron/ai.js exports, and nothing short of running that program exercises
 * any of it, so a regression here is invisible until the copilot is being used
 * for real: a catalogue that silently loses its models, a step with no file on
 * it, a citation that eats a link.
 *
 * All of it is pure, which is the whole reason this file can exist. The inputs
 * below are copied from real output — `opencode models --verbose` — rather
 * than invented, because a parser tested against a guess about its input is a
 * parser tested against nothing.
 *
 *   npm run test:ai
 */
import MarkdownIt from 'markdown-it'
import { readFileSync } from 'node:fs'

import ai from '../electron/ai.js'
import prompt from '../electron/prompt.js'
import VAULT_CONTRACT from '../electron/vault-contract.json'
import { citePlugin } from '../src/cite.js'
import {
  DEFAULT_CATALOGUE, modelFromConfig, offeredModels,
  COPILOT_MODES, copilotModeFromConfig
} from '../src/models.js'

const {
  detailOf, tokensIn, tokensOf, usageOf, readLines, parseOpencode, contextSize,
  policyEnv, commandCandidates, escapeForCmd, invocation
} = ai.parsers
const { systemPrompt, turnRules, promptFor, nothingSent } = prompt

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}
const same = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
        `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)

/* A provider can have no built-in fallback while its real catalogue is being
   fetched. The saved default must survive that first paint instead of being
   dropped for the first model that arrives. */
const savedModel = 'opencode:opencode-go/deepseek-v4-flash'
check('a saved default survives the fallback catalogue',
      modelFromConfig({ aiModel: savedModel }) === savedModel)
check('the saved default leads the offered models before refresh',
       offeredModels(DEFAULT_CATALOGUE, [savedModel], savedModel)[0]?.key === savedModel)
/* The list is held between calls, because `repaintControls` asks for it five
   times over and the answer is a filter across the whole catalogue. What is
   held has to expire on every part of the question — and must not be handed
   back after the caller has mutated the array it asked with. */
const enabledOnce = [savedModel]
const held = offeredModels(DEFAULT_CATALOGUE, enabledOnce, savedModel)
check('the same question gives back the same list',
      offeredModels(DEFAULT_CATALOGUE, [savedModel], savedModel) === held)
check('a different selection is a different question',
      offeredModels(DEFAULT_CATALOGUE, [savedModel], '') !== held)
enabledOnce.push('opencode:opencode-go/glm-5.2')
check('a caller mutating its own list does not keep the old answer',
      offeredModels(DEFAULT_CATALOGUE, enabledOnce, savedModel) !== held)
check('the held list still leads with the saved default',
      offeredModels(DEFAULT_CATALOGUE, [savedModel], savedModel)[0]?.key === savedModel)

check('new Copilot installs default to read-only',
       copilotModeFromConfig({}) === COPILOT_MODES.READ)
check('legacy write access migrates to Ask',
       copilotModeFromConfig({ aiWrite: true }) === COPILOT_MODES.ASK)
check('legacy read-only access stays read-only',
       copilotModeFromConfig({ aiWrite: false }) === COPILOT_MODES.READ)
check('Auto is an explicit persisted mode',
       copilotModeFromConfig({ aiMode: COPILOT_MODES.AUTO, aiWrite: false }) === COPILOT_MODES.AUTO)

/* --------------------------------------------------------------- prompts */

const briefing = systemPrompt('/tmp/example-vault')
const promptMarkdown = readFileSync('electron/prompt.md', 'utf8')
check('the Copilot prompt lives in Markdown',
      promptMarkdown.startsWith('# Tulip Copilot'))
check('the system prompt stays compact', briefing.length < 4000,
      `${briefing.length.toLocaleString()} characters`)
check('the vault boundary is explicit',
      briefing.includes('inside the vault at /tmp/example-vault'))
check('Tulip-owned annotations stay read-only',
      briefing.includes('.annotations/ is Tulip-managed, read-only context'))
check('capabilities are grouped by file type',
      ['Markdown notes', 'Language tables', 'LaTeX documents', 'PDF documents',
        'Whiteboards', 'Websites', 'Attachments']
        .every((heading) => briefing.includes(`${heading} (`) || briefing.includes(`${heading}:`)))
check('the prompt describes available file actions',
      briefing.includes('read, search, create and edit files'))
check('new notes use plain Markdown',
      turnRules.includes('New notes use plain Markdown'))
check('new notes do not duplicate the filename title',
      turnRules.includes('filename supplies the visible title'))
check('math delimiters are named',
      turnRules.includes('`$…$` inline') && turnRules.includes('Backticks are for code'))
check('renames use Tulip', turnRules.includes('.tulip-copilot-rename.json'))
check('PDF and bibliography citation forms survive',
      turnRules.includes('`[page 12]`') && turnRules.includes('`[@key]`'))
check('TeX documents are part of the Copilot vault contract',
      briefing.includes('LaTeX documents (.tex):') &&
      briefing.includes('Create and edit complete LaTeX source documents'))

const texTurn = promptFor('Tighten the introduction.', {
  note: 'Paper/main.tex', kind: 'tex', line: 24, selection: '\\section{Introduction}'
})
check('the open TeX document reaches Copilot as TeX',
      texTurn.includes('<open-tex-document>Paper/main.tex') &&
      texTurn.includes('\\section{Introduction}'))

const boardTurn = promptFor('Summarise this board.', {
  note: 'Ideas.excalidraw', kind: 'whiteboard', selection: 'Chosen card',
  text: 'Chosen card\nSecond card', elements: 2
})
check('the open whiteboard reaches Copilot as structured context',
      boardTurn.includes('<open-whiteboard>Ideas.excalidraw') &&
      boardTurn.includes('The board has 2 elements.') &&
      boardTurn.includes('Board text:'))

/* The two kinds that used to fall through to an empty <open-note>: the grid
   and the notebook both build real context in the renderer, and the prompt
   dropped it on the floor. */
const dataTurn = promptFor('Which column drifts?', {
  note: 'Data/readings.csv', kind: 'data', selection: '',
  text: 'when,volts\n2026-01-01,3.31', rows: 1200, columns: 2, truncated: true
})
check('the open data file reaches Copilot with its shape and headings',
      dataTurn.includes('<open-data-file>Data/readings.csv') &&
      dataTurn.includes('1,200 rows in 2 columns') &&
      dataTurn.includes('when,volts') &&
      dataTurn.includes('cut short'))

const notebookTurn = promptFor('Why does cell 3 fail?', {
  note: 'Lab/analysis.ipynb', kind: 'notebook', selection: '',
  text: '# Cell 1\nimport numpy as np', cells: 4, language: 'python', truncated: false
})
check('the open notebook reaches Copilot as cells, not as an empty note',
      notebookTurn.includes('<open-notebook>Lab/analysis.ipynb') &&
      notebookTurn.includes('It has 4 cells, in python.') &&
      notebookTurn.includes('import numpy as np') &&
      !notebookTurn.includes('<open-note>'))
/* Spelled from the contract, not by hand: the prompt renders these lists from
   vault-contract.json, and a test that hardcodes today's rendering breaks the
   day an extension is added even though nothing regressed. */
check('the briefing names notebooks and data files',
      briefing.includes(`Notebooks (${VAULT_CONTRACT.notebookExtension}):`) &&
      briefing.includes(`Data files (${Object.keys(VAULT_CONTRACT.dataExtensions).join(', ')}):`))

const pdfTurn = promptFor('What time is the cruise?', {
  attachments: ['.attachments/Chat/ticket.pdf', '.attachments/Chat/photo.png'],
  pdfDocuments: [{
    path: '.attachments/Chat/ticket.pdf',
    textPath: '.annotations/.attachments/Chat/ticket.pdf.txt',
    pages: 12,
    ocrPages: 1
  }],
  pdfContext: '--- ticket.pdf page 1 of 1 ---\nTIME: 16:00'
})
check('PDF attachments name prepared text rather than asking to open the binary',
      pdfTurn.includes('.annotations/.attachments/Chat/ticket.pdf.txt') &&
      !pdfTurn.includes('Open it with your file-reading tool:\n- .attachments/Chat/ticket.pdf'))
check('ranked PDF pages ride the turn', pdfTurn.includes('TIME: 16:00'))
check('ordinary attachments still reach the file tool',
      pdfTurn.includes('.attachments/Chat/photo.png'))
check('the PDF list names the page count so the agent reads selectively',
      pdfTurn.includes('ticket.pdf.txt (12 pages)'))
check('the turn rules show how to read one page instead of a whole book',
      pdfTurn.includes('grep -n \'^--- page \'') &&
      pdfTurn.includes('sed -n \'START,ENDp\'') &&
      pdfTurn.includes('never the whole file'))

/* A small attachment is quoted rather than named — main reads it and sends the
   text along, because asking the agent to open a file it could have been handed
   costs a whole round trip before the question is even addressed. A big one
   still gets the instruction: reading that selectively is the point. */
const inlinedTurn = promptFor('Which column is the date?', {
  attachments: ['Data/rows.csv', 'Data/huge.csv'],
  attachmentTexts: [{ path: 'Data/rows.csv', text: 'when,what\n2026-01-01,start' }]
})
check('a small attachment is quoted into the turn',
      inlinedTurn.includes('2026-01-01,start') &&
      inlinedTurn.includes('The user attached this file:'))
check('a quoted attachment is not also asked for',
      !/Open it with your file-reading tool:\n- Data\/rows\.csv/.test(inlinedTurn))
check('an attachment too big to quote still names itself',
      inlinedTurn.includes('- Data/huge.csv') &&
      inlinedTurn.includes('Open it with your file-reading tool'))
check('an attachment with nothing read for it behaves as it always did',
      promptFor('Read this.', { attachments: ['Data/rows.csv'] })
        .includes('Open it with your file-reading tool:\n- Data/rows.csv'))

/* What a tool put in front of the model, for the context ring. Only the string
   shape was ever counted, so a provider answering in blocks filled the context
   with the ring reading as though nothing had been sent. */
same('blocks are counted through', tokensOf([{ text: 'abc' }, 'def']), 2)
same('an output on a field of its own is counted', tokensOf({ output: 'abcdef' }), 2)
same('nothing said is nothing counted', tokensOf(null), 0)

/* The ring is the only warning a model whose CLI publishes no count ever gets,
   so the estimate has to err towards "fuller than you think". Four characters
   to a token is the English prose rule and is roughly twice wrong for the two
   things a vault is full of. */
same('prose is about three characters to a token', tokensIn('x'.repeat(300)), 100)
check('CJK counts far nearer one character to a token',
      tokensIn('日本語のテキスト') >= 8)
check('and is not counted as though it were English',
      tokensIn('日本語のテキスト') > tokensIn('x'.repeat(8)))
same('nothing is nothing', tokensIn(''), 0)
same('OpenCode usage includes cached input and generated output',
     usageOf({ input: 1005, output: 99, reasoning: 0, cache: { read: 31126, write: 17 } })?.used,
     32247)
same('legacy total usage remains supported', usageOf({ total: 420 })?.used, 420)
check('missing usage is ignored', usageOf({ cache: {} }) === null)

const noteTurn = promptFor('What does the introduction say?', {
  note: 'notes/lecture.md', kind: 'note', line: 12, heading: 'Introduction',
  excerpt: 'The introduction starts here.\nIt covers the plan.',
  excerptCut: true,
  noteChars: 420000
})
check('a note too long to send whole carries a window around the cursor',
      noteTurn.includes('<open-note>notes/lecture.md') &&
      noteTurn.includes('notes/lecture.md, around the cursor') &&
      noteTurn.includes('The introduction starts here.'))
check('and says how much of the note is not shown',
      noteTurn.includes('420,000 characters shown') && noteTurn.includes('read the file for the rest'))

const wholeNoteTurn = promptFor('Check this note.', {
  note: 'notes/short.md', kind: 'note', line: 1,
  excerpt: 'A short note.', excerptCut: false, noteChars: 12
})
check('a note that fits is sent whole, and said to be whole',
      wholeNoteTurn.includes('notes/short.md, in full:') &&
      wholeNoteTurn.includes('A short note.') &&
      !wholeNoteTurn.includes('read the file for the rest'))

const sourceMemo = nothingSent()
const sourceContext = {
  note: 'src/main.cpp', kind: 'c++', line: 8, sourceContext: true,
  excerpt: 'int main() { return 0; }', excerptCut: false, noteChars: 25
}
promptFor('Explain this.', sourceContext, sourceMemo)
const movedSource = promptFor('And this?', {
  ...sourceContext, line: 80, excerpt: 'std::vector<int> values;'
}, sourceMemo)
check('a moved source window is not re-quoted',
      !movedSource.includes('std::vector<int> values;') &&
      movedSource.includes('Read the file selectively for the current code.'))

/* The window moves on every turn a source file is asked about, so the notice
   is not a one-off: there is no point at which the earlier excerpt becomes
   current again, and saying it did would send the agent back to a quote of a
   part of the file it is no longer looking at. */
check('and it says so again for as long as the window keeps moving',
      promptFor('And now?', { ...sourceContext, line: 200, excerpt: 'delete[] buffer;' }, sourceMemo)
        .includes('Read the file selectively for the current code.'))

/* Order matters here, and only shows up at length. A source window that has
   not moved is still current and must be named as such — the unchanged branch
   sits above the source branch — while one that has moved must reach the
   source branch before the long-note branch below it, or two unrelated windows
   of the same file get diffed against each other and the "here is what
   changed" quote is assembled out of two different parts of the file. */
const sameWindow = promptFor('Explain it again.', sourceContext, sourceMemo)
check('an unchanged source window is named rather than described as moved',
      sameWindow.includes('is still current') &&
      !sameWindow.includes('Read the file selectively for the current code.'))

const longSource = 'int value = 0;\n'.repeat(4000)
const longMemo = nothingSent()
promptFor('Explain this.', { ...sourceContext, excerpt: longSource, noteChars: longSource.length }, longMemo)
const longMoved = promptFor('And this?', {
  ...sourceContext, line: 900, excerpt: `${longSource}int other = 1;\n`, noteChars: longSource.length + 15
}, longMemo)
check('a long source window that moved is sent to the file, not diffed',
      longMoved.includes('Read the file selectively for the current code.') &&
      !longMoved.includes('characters replaced by'))

const codeTask = promptFor('Edit this block.', {
  ...sourceContext,
  excerpt: 'int main() { return 0; }',
  skipExcerpt: true
})
check('a focused code task omits the open source excerpt',
      !codeTask.includes('int main() { return 0; }') &&
      codeTask.includes('<open-note>src/main.cpp'))

/* The text is its own block, so a selection can travel with the note rather
   than in place of it: three highlighted lines do not say what they contradict
   four screens further up. */
const selectionTurn = promptFor('Does this contradict anything above?', {
  note: 'notes/short.md', kind: 'note', line: 4, selection: 'the third claim',
  excerpt: 'The first claim.\nThe third claim.', excerptCut: false, noteChars: 33
})
check('a selection does not displace the note it was made in',
      selectionTurn.includes('Selected text') && selectionTurn.includes('The first claim.'))

/* ------------------------------------------------- what is not said twice */

/* Every CLI here resumes its thread, so a block sent on one turn is still in
   front of the model on the next — and is re-sent, by the CLI, for the rest of
   the conversation. Quoting the open note per turn therefore costs the square
   of the chat's length. These check the memory that stops it, and that a note
   which has actually changed is quoted again regardless. */
const chat = { note: 'notes/lecture.md', kind: 'note', line: 12,
               excerpt: 'The introduction starts here.', excerptCut: false, noteChars: 29 }
const sent = nothingSent()
const first = promptFor('What does this say?', chat, sent)
check('the first turn of a thread carries the note and the rules',
      first.includes('The introduction starts here.') && first.includes(turnRules))

const second = promptFor('And the conclusion?', chat, sent)
check('an unchanged note is named rather than quoted again',
      !second.includes('The introduction starts here.') &&
      second.includes('The copy of notes/lecture.md quoted earlier'))
check('and the standing rules are not repeated into a thread that has them',
      !second.includes(turnRules))
check('the question itself still goes', second.includes('And the conclusion?'))

/* The caret moved and the text did not. The framing is cheap and goes again;
   the note is not and does not. */
const moved = promptFor('And here?', { ...chat, line: 40 }, sent)
check('moving the cursor does not re-send the note',
      moved.includes('cursor is on line 40') &&
      !moved.includes('The introduction starts here.'))

const edited = promptFor('Now?', { ...chat, excerpt: 'The introduction was rewritten.' }, sent)
check('a note that changed is quoted again',
      edited.includes('The introduction was rewritten.'))

/* A long note is quoted once. Edited after that, quoting it again would cost
   its whole length for the sake of one changed line — so what goes instead is
   the changed line itself, which is both smaller than the note and more use
   than being told the copy is stale. */
const bookText = 'x'.repeat(60000)
const book = { note: 'notes/book.md', kind: 'note', line: 1,
               excerpt: bookText, excerptCut: false, noteChars: bookText.length }
const reading = nothingSent()
check('a long note is quoted whole the first time',
      promptFor('Summarise this.', book, reading).includes(bookText))
const rewritten = { ...book, excerpt: `${bookText}y` }
const afterEdit = promptFor('And now?', rewritten, reading)
check('an edit to a long note sends the change, not the note',
      !afterEdit.includes(bookText) &&
      afterEdit.includes('notes/book.md has changed since the copy quoted earlier'))
/* A note with no line breaks has no boundary to widen the run out to, and the
   search for one runs to both ends of the file. The change is one character and
   what goes must be about one character. */
check('the change is the change, even in a note with no line breaks',
      afterEdit.length < 400)

/* Having been told what changed, the model holds the current text — so the next
   turn names it rather than describing the same edit again. */
check('a note patched once is current from then on',
      promptFor('Still?', rewritten, reading)
        .includes('The copy of notes/book.md quoted earlier'))

/* And a revert is just another change, described the same way: the copy the
   model holds is the rewritten one, so going back to the original is a diff
   against that rather than a return to something it still has. */
check('a revert is described against what the model actually holds',
      promptFor('Reverted?', book, reading)
        .includes('notes/book.md has changed since the copy quoted earlier'))

/* A rewrite is not an edit. Where the change is most of the note, describing it
   says less than sending the reader to the file. */
const wholesale = { ...book, excerpt: 'y'.repeat(60000) }
check('a wholesale rewrite still falls back to reading the file',
      promptFor('Rewritten?', wholesale, nothingSent2(book))
        .includes('too long to quote again'))

function nothingSent2 (seed) {
  const memo = nothingSent()
  promptFor('Seed.', seed, memo)
  return memo
}

const pages = { pdfContext: '--- book.pdf page 4 of 90 ---\nTIME: 16:00' }
const askedOnce = nothingSent()
promptFor('When?', pages, askedOnce)
check('the same ranked PDF pages are not re-sent',
      !promptFor('And where?', pages, askedOnce).includes('TIME: 16:00'))

/* The ranking runs against each question, so the block is different every
   turn — the dedupe has to work by page, or a follow-up that surfaces one new
   page pays for the five it shares with the last question all over again. */
const coda = 'Use these pages first. The complete page-marked text files are listed above; search or read them if the answer depends on omitted material.'
const rankedFirst = [
  'Relevant PDF pages selected locally from extracted text and OCR:',
  '--- book.pdf page 4 of 90 ---\nThe tide table says 16:00.',
  '--- book.pdf page 5 of 90 ---\nThe harbour closes at dusk.',
  coda
].join('\n\n')
const rankedNext = [
  'Relevant PDF pages selected locally from extracted text and OCR:',
  '--- book.pdf page 5 of 90 ---\nThe harbour closes at dusk, sliced differently.',
  '--- book.pdf page 6 of 90 ---\nMoorings are numbered from the west.',
  coda
].join('\n\n')
const pageMemo = nothingSent()
promptFor('When is high tide?', { pdfContext: rankedFirst }, pageMemo)
const followUp = promptFor('And the moorings?', { pdfContext: rankedNext }, pageMemo)
check('only the pages new to the thread are quoted',
      followUp.includes('Moorings are numbered') &&
      !followUp.includes('harbour closes') &&
      followUp.includes('Already quoted earlier in this conversation'))
check('a re-ranked slice of a sent page does not smuggle the page back in',
      !followUp.includes('sliced differently'))

/* The patch path now covers notes of any size: the reader editing the note
   they are asking about is the ordinary case, and requoting thirty thousand
   characters for one retyped line was most of what such a chat spent. */
const living = nothingSent()
const draft = 'A line of prose in a living note under forty thousand.\n'.repeat(560)
const livingNote = { note: 'notes/living.md', kind: 'note', line: 3,
                     excerpt: draft, excerptCut: false, noteChars: draft.length }
check('a small note is quoted whole the first time',
      promptFor('First question.', livingNote, living).includes(draft))
const grown = { ...livingNote, excerpt: `${draft}A remark added at the foot.\n` }
const patched = promptFor('And after my edit?', grown, living)
check('an edit to a small note sends the change, not the note',
      patched.includes('characters replaced by') && patched.length < 700)
check('the patched small note is current from then on',
      promptFor('Still?', grown, living)
        .includes('The copy of notes/living.md quoted earlier'))

/* One memo, two documents: a diff of one note against another is not a
   change, and must never be dressed up as one. */
const swapped = promptFor('Another note now.', {
  note: 'notes/other.md', kind: 'note',
  excerpt: 'Fresh text of a different note.', excerptCut: false, noteChars: 31
}, living)
check('a different note is quoted fresh, never diffed against the last one',
      swapped.includes('Fresh text of a different note.') &&
      !swapped.includes('characters replaced by'))

check('a caller with no memory still gets the whole context',
      promptFor('What does this say?', chat).includes('The introduction starts here.'))

/* --------------------------------------------------------------- detailOf */

check('a plain string is trimmed', detailOf('  hi  ') === 'hi')
check('content blocks are joined', detailOf([{ text: 'a' }, { text: 'b' }]) === 'a\nb')
check('a list of strings is joined', detailOf(['a', 'b']) === 'a\nb')
check('an object reports its output', detailOf({ output: 'ran' }) === 'ran')
check('an object reports its text', detailOf({ text: 'said' }) === 'said')

/* The cut, and the line saying it happened. A truncation nobody is told about
   reads as a tool that stopped early — and the count has to include the parts
   that were never joined, or a Read of a long note reports the few characters
   over the limit rather than the tens of thousands it actually held. */
const long = detailOf('x'.repeat(2500))
check('a long detail is cut at the limit', long.startsWith('x'.repeat(2000)))
check('and says how much was left', long.endsWith('… 500 more characters'), long.slice(-40))

const many = detailOf(['x'.repeat(2100), 'y'.repeat(1000)])
check('the parts never joined are still counted',
      many.endsWith('… 1,101 more characters'), many.slice(-40))

check('a short detail says nothing about truncation',
      !detailOf('short').includes('more characters'))

/* -------------------------------------------------------------- readLines */

/* A CLI's stdout is a pipe, and a pipe splits wherever it likes — including
   halfway through the JSON of a reply. */
function fakeStream () {
  let onData = () => {}
  return {
    setEncoding () {},
    on (name, fn) { if (name === 'data') onData = fn },
    write (chunk) { onData(chunk) }
  }
}

function lines (chunks) {
  const stream = fakeStream()
  const got = []
  readLines(stream, (msg) => got.push(msg))
  for (const chunk of chunks) stream.write(chunk)
  return got
}

same('one line, one message', lines(['{"a":1}\n']), [{ a: 1 }])
same('two messages in one chunk', lines(['{"a":1}\n{"a":2}\n']), [{ a: 1 }, { a: 2 }])
same('a line split across chunks', lines(['{"a":', '1}\n']), [{ a: 1 }])
same('a line split mid-string', lines(['{"a":"he', 'llo"}\n']), [{ a: 'hello' }])
same('blank lines are skipped', lines(['\n\n{"a":1}\n']), [{ a: 1 }])
same('a line that is not JSON is dropped, not thrown',
     lines(['warning: something\n{"a":1}\n']), [{ a: 1 }])
same('a line with no newline yet is held', lines(['{"a":1}']), [])
same('and delivered when its newline arrives', lines(['{"a":1}', '\n']), [{ a: 1 }])

/* The cursor is what makes a chunk of hundreds of events cheap; it is also
   what a mistake in this function would silently drop data through. */
same('the remainder after several lines is kept whole',
     lines(['{"a":1}\n{"a":2}\n{"a":', '3}\n']), [{ a: 1 }, { a: 2 }, { a: 3 }])

/* A line that never ends must not grow the buffer for the length of a turn:
   past the cap it is dropped whole, and the stream picks itself up at the
   next real line. */
same('a runaway line is dropped rather than held',
     lines(['x'.repeat(8 * 1024 * 1024 + 1), 'tail\n{"a":1}\n']), [{ a: 1 }])

/* ------------------------------------------------------------- catalogues */

check('a context size is read in either unit',
      contextSize('1M') === 1000000 && contextSize('272K') === 272000 &&
      contextSize('128,000') === 128000 && contextSize('') === 0)

/* Shaped as `opencode models --verbose` answers: an id line, then that model's
   JSON pretty-printed one token per line. Copied from the real output — the
   brace-depth scan that finds the block depends on exactly that shape. */
const opencodeCatalogue = `opencode/big-pickle
{
  "id": "big-pickle",
  "name": "Big Pickle",
  "limit": {
    "context": 200000,
    "output": 32000
  },
  "variants": {}
}
anthropic/claude-opus-5
{
  "id": "claude-opus-5",
  "name": "Claude Opus 5",
  "limit": {
    "context": 1000000
  },
  "variants": {
    "high": {
      "reasoningEffort": "high"
    },
    "max": {
      "reasoningEffort": "max"
    }
  }
}
`

const opencodeModels = parseOpencode(opencodeCatalogue)
same('every id line is a model',
     opencodeModels.map((m) => m.id), ['opencode/big-pickle', 'anthropic/claude-opus-5'])
/* The provider is half the name — `glm-5.2` alone says nothing about whose
   subscription is paying for it — so the line is the id and the halves are
   what the settings pane groups and labels by. */
same('the label is the part after the slash and the group the part before',
     [opencodeModels[1].label, opencodeModels[1].group], ['claude-opus-5', 'anthropic'])
same('variants become the levels the effort slider offers',
     opencodeModels[1].efforts, ['high', 'max'])
check('and `high` is preferred as the default', opencodeModels[1].effort === 'high')
check('a model with an empty variants block has no levels',
      opencodeModels[0].efforts.length === 0)
check('the context limit is carried', opencodeModels[1].context === 1000000)

// The same parser reads the plain output: the id lines are identical in both,
// and nothing inside the JSON can pass for one.
same('the non-verbose form is read by the same parser',
     parseOpencode('opencode/big-pickle\nanthropic/claude-opus-5\n').map((m) => m.id),
     ['opencode/big-pickle', 'anthropic/claude-opus-5'])
same('a line that is not an id is not a model', parseOpencode('Models:\n\n'), [])

/* ------------------------------------------------------------- citations */

/* Same options the panel builds its renderer with, so what is asserted here is
   what a reply actually renders as. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true })
  .use(citePlugin)

const cited = (text) => md.render(text)
const pageOf = (text) => /data-cite-page="(\d+)"/.exec(cited(text))?.[1] || null
const pathOf = (text) => /data-cite-path="([^"]*)"/.exec(cited(text))?.[1] || null
const labelOf = (text) => /class="ai-cite"[^>]*>([^<]*)<\/a>/.exec(cited(text))?.[1] || null

check('[p. 12]', pageOf('See [p. 12].') === '12')
check('[p. 12] is displayed as page 12', labelOf('See [p. 12].') === 'page 12')
check('[pp. 12–14] cites the first page', pageOf('See [pp. 12–14].') === '12')
check('[pp. 12–14] is displayed with pages',
      labelOf('See [pp. 12–14].') === 'pages 12–14')
check('[pp. 12-14] with a plain hyphen', pageOf('See [pp. 12-14].') === '12')
check('[pp. 1, 5] remains a citation with a readable label',
      pageOf('See [pp. 1, 5].') === '1' && labelOf('See [pp. 1, 5].') === 'pages 1, 5')
check('[page 3]', pageOf('See [page 3].') === '3')
check('[pages 3 to 5]', pageOf('See [pages 3 to 5].') === '3')
check('a named document', pathOf('See [Paper.pdf p. 12].') === 'Paper.pdf')
check('and the page with it', pageOf('See [Paper.pdf p. 12].') === '12')
check('a name with spaces in it',
      pathOf('See [Fermat and the Rest.pdf p. 4].') === 'Fermat and the Rest.pdf')

/* The rule that has to hold whatever else changes: a citation is claimed at
   every `[`, so anything else written in brackets must be left alone. */
check('an ordinary bracket is not a citation', !cited('A [note] here.').includes('ai-cite'))
check('a link is still a link',
      !cited('See [p. 12](https://example.com).').includes('ai-cite'),
      cited('See [p. 12](https://example.com).'))
check('a wikilink is not a citation', !cited('See [[Some Note]].').includes('ai-cite'))
check('prose that merely mentions a page is not a citation',
      !cited('It is on page 12 of the book.').includes('ai-cite'))

/* The pattern is sticky, which means it carries `lastIndex` between calls. A
   second citation in the same paragraph is exactly what a mistake there would
   lose. */
const two = cited('First [p. 1], then [p. 9].')
check('two citations in one paragraph both render',
      (two.match(/ai-cite/g) || []).length === 2, two)

/* A `.pdf` may not run away up the line looking for one — the name is bounded,
   and past the bound this is prose in brackets like any other. */
check('an over-long name is not a document',
      !cited(`See [${'a'.repeat(130)}.pdf p. 4].`).includes('ai-cite'))

/* ------------------------------------------------------------ the fence */

/* What the agent may reach for is a fact about the process, not a request in
   the prompt — and not a CLI default either. Every mode states its whole grant,
   so a default cannot move underneath the toggle in either direction: handing a
   shell to the mode that asked only for the notes, or withholding one from the
   mode whose label promises it. */
const policy = (mode) => {
  const inline = policyEnv(mode).OPENCODE_CONFIG_CONTENT
  return inline ? JSON.parse(inline).permission : null
}

check('read mode denies the shell', policy('read').bash === 'deny')
check('ask mode allows the shell', policy('ask').bash === 'allow')
check('ask mode still allows the notes',
      policy('ask').edit === 'allow' && policy('ask').write === 'allow')

/* Not one of the questions the switch is about. Reading a page changes nothing
   in the vault, which is what the modes are a promise about, so the mode that
   promises not to touch the notes can still go and read one. */
for (const mode of ['read', 'ask', 'auto']) {
  check(`${mode} mode fetches the web`, policy(mode).webfetch === 'allow')
}

/* Where the line between ask and auto actually falls. Both have the shell; only
   auto's may leave the vault, and `external_directory` is what makes "inside
   the vault" a fact about the process rather than a line in the prompt. */
check('read mode keeps out of other directories',
      policy('read').external_directory === 'deny')
check('ask mode keeps its shell in the vault',
      policy('ask').external_directory === 'deny')
/* Auto is the tier whose own label calls itself dangerous, and every capability
   the label names is granted here rather than left to the CLI. */
check('auto mode allows the shell', policy('auto').bash === 'allow')
check('auto mode allows the web', policy('auto').webfetch === 'allow')
check('auto mode allows the notes',
      policy('auto').edit === 'allow' && policy('auto').write === 'allow')
/* Its own grant, separate from the shell: `cd /tmp && curl …` is a command auto
   was refused on the step out of the vault, not on the shell it ran in. */
check('auto mode allows a command that leaves the vault',
      policy('auto').external_directory === 'allow')

/* The general form of that bug. A headless `run` has nowhere to put a question,
   so anything left to be asked about is refused — see the note on TOOL_POLICY. */
for (const mode of ['read', 'ask', 'auto']) {
  check(`${mode} mode asks nothing it cannot be answered on`,
        Object.values(policy(mode)).every((e) => e === 'allow' || e === 'deny'))
}
check('an unknown mode is left alone', policy(undefined) === null)

/* A user's own inline config is extended, not replaced: only the keys the fence
   is about are stated on top of it. */
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: 'mine/own', permission: { external_directory: 'allow', edit: 'ask' }
})
const merged = JSON.parse(policyEnv('ask').OPENCODE_CONFIG_CONTENT)
check('the user’s own config survives the fence', merged.model === 'mine/own')
check('the fence wins on the keys it is about',
      merged.permission.external_directory === 'deny')

/* The same in the other direction: the mode grants as well as withholds, so a
   config that would put the shell behind a prompt does not get to do that to
   the mode whose whole point is not being asked. */
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  permission: { bash: 'ask', webfetch: 'ask' }
})
const opened = JSON.parse(policyEnv('auto').OPENCODE_CONFIG_CONTENT)
check('auto’s grant wins over a config that would prompt',
      opened.permission.bash === 'allow' && opened.permission.webfetch === 'allow')
delete process.env.OPENCODE_CONFIG_CONTENT

/* ----------------------------------------------------------------- windows */

/* PATHEXT is what "executable" means on Windows — `opencode` installed through
   npm is really `opencode.cmd`, and a doctor that only looked for the bare
   name reported a working install as missing. */
same('a bare name on Windows tries each PATHEXT suffix',
     commandCandidates('opencode', true, ['.COM', '.EXE', '.CMD']),
     ['opencode.COM', 'opencode.EXE', 'opencode.CMD'])
same('a name already wearing a suffix is only itself',
     commandCandidates('opencode.exe', true, ['.COM', '.EXE']), ['opencode.exe'])
same('a dot in a directory is not a suffix',
     commandCandidates('tools.d\\opencode', true, ['.EXE']), ['tools.d\\opencode.EXE'])
same('unix names are only ever themselves',
     commandCandidates('opencode', false, ['.EXE']), ['opencode'])

/* The cmd.exe escaping, pinned. A `.cmd` shim is run through cmd.exe, and the
   vault path rides `--dir` down that line — a space or a quote mishandled is
   a turn run against the wrong directory. The rules are msvcrt's quote dance
   plus cmd's caret pass, doubled for arguments because the shim re-expands
   its `%*` through cmd a second time. */
check('a flag survives the caret passes',
      escapeForCmd('--model', true) === '^^^"--model^^^"')
check('a path with spaces stays one argument',
      escapeForCmd('C:\\My Vault', true) === '^^^"C:\\My^^^ Vault^^^"')
check('a quote inside an argument is escaped for msvcrt',
      escapeForCmd('say "hi"', true) === '^^^"say^^^ \\^^^"hi\\^^^"^^^"')
check('the command itself gets one caret pass and no quotes',
      escapeForCmd('C:\\Program Files\\opencode.cmd', false) ===
        'C:\\Program^ Files\\opencode.cmd')

/* Away from Windows the invocation is exactly what was asked for — the PATH
   walk and the shell are that platform's problem alone. */
const plain = invocation('opencode', ['run', '--format', 'json'])
check('unix spawns the name as given',
      plain.file === 'opencode' && plain.args.length === 3 &&
      Object.keys(plain.options).length === 0)

/* ------------------------------------------------- a copilot per chat */

/* One session per conversation is what lets two notes be worked on at once.
   The turn itself cannot be tested here — it spawns a CLI — but the bookkeeping
   under it can, and getting it wrong is what a single global `session` did for
   years: starting one copilot silently ended the other. `start` spawns nothing
   (a process is per turn), so this is safe to run anywhere. */
ai.setVault('/tmp/tulip-test-vault')
ai.attach(() => {})
const startedA = ai.start({ key: 'chat-a', provider: 'opencode', model: 'm', mode: 'auto', turnId: 't-a' })
const startedB = ai.start({ key: 'chat-b', provider: 'opencode', model: 'm', mode: 'read', turnId: 't-b' })
check('each conversation starts its own copilot', startedA.ok && startedB.ok)
check('starting one does not end the other', ai.canWrite('chat-a') === true)
check('the permission mode is that session\'s own', ai.canWrite('chat-b') === false)
check('an unknown conversation has no copilot', ai.canWrite('chat-c') === false)
check('a message needs the session it names',
      ai.send('chat-c', 'hello', null, 't-c').ok === false)
check('stopping one conversation leaves the other running',
      ai.stop('chat-b').ok === true && ai.canWrite('chat-a') === true)
check('stopping the same one twice is not an error, only a no-op',
      ai.stop('chat-b').ok === false)
ai.stopAll()
check('stopAll takes every copilot', ai.canWrite('chat-a') === false)

/* ----------------------------------------------------------------- report */

if (failures) {
  console.error(`\n${failures} check${failures === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('the copilot parsers hold')
