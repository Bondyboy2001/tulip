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
import { citePlugin } from '../src/cite.js'
import {
  DEFAULT_CATALOGUE, modelFromConfig, offeredModels,
  COPILOT_MODES, copilotModeFromConfig
} from '../src/models.js'

const { detailOf, measure, readLines, parseOpencode, contextSize } = ai.parsers
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
same('a string output is its own length', measure('twelve chars'), 12)
same('blocks are counted through', measure([{ text: 'ab' }, 'cde']), 5)
same('an output on a field of its own is counted', measure({ output: 'abcd' }), 4)
same('nothing said is nothing counted', measure(null), 0)

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
   its whole length for the sake of one changed line, so the agent is told the
   copy is stale instead — and keeps being told until it sees the new text. */
const bookText = 'x'.repeat(60000)
const book = { note: 'notes/book.md', kind: 'note', line: 1,
               excerpt: bookText, excerptCut: false, noteChars: bookText.length }
const reading = nothingSent()
check('a long note is quoted whole the first time',
      promptFor('Summarise this.', book, reading).includes(bookText))
const rewritten = { ...book, excerpt: `${bookText}y` }
const afterEdit = promptFor('And now?', rewritten, reading)
check('an edit to a long note names the file rather than re-quoting it',
      !afterEdit.includes(bookText) &&
      afterEdit.includes('notes/book.md has changed since the copy quoted earlier'))
check('and keeps saying so while the copy the model holds is stale',
      promptFor('Still?', rewritten, reading)
        .includes('has changed since the copy quoted earlier'))
check('a long note back to the version already quoted is named as current',
      promptFor('Reverted?', book, reading)
        .includes('The copy of notes/book.md quoted earlier'))

const pages = { pdfContext: '--- book.pdf page 4 of 90 ---\nTIME: 16:00' }
const askedOnce = nothingSent()
promptFor('When?', pages, askedOnce)
check('the same ranked PDF pages are not re-sent',
      !promptFor('And where?', pages, askedOnce).includes('TIME: 16:00'))

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

/* ----------------------------------------------------------------- report */

if (failures) {
  console.error(`\n${failures} check${failures === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('the copilot parsers hold')
