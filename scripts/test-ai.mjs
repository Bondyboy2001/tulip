/**
 * The copilot's parsers, checked against what the CLIs actually say.
 *
 * Everything the panel knows about a turn arrives through a handful of
 * hand-rolled readers — a line-splitter over a pipe, two catalogue parsers, the
 * reader that trims what a tool said — plus one regular expression tried at
 * every `[` of every reply. None of them is reachable from the six calls
 * electron/ai.js exports, and nothing short of running both programs exercises
 * any of it, so a regression here is invisible until the copilot is being used
 * for real: a catalogue that silently loses its models, a step with no file on
 * it, a citation that eats a link.
 *
 * All of it is pure, which is the whole reason this file can exist. The inputs
 * below are copied from real output — `devin models list`, `opencode models
 * --verbose` — rather than invented, because a parser tested against a guess
 * about its input is a parser tested against nothing.
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

const { detailOf, readLines, parseDevin, parseOpencode, contextSize } = ai.parsers
const { systemPrompt, turnRules, promptFor } = prompt

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
   fetched. The saved default must survive that first paint instead of becoming
   the first Devin model. */
const savedModel = 'opencode:opencode-go/deepseek-v4-flash'
check('a saved default survives the fallback catalogue',
      modelFromConfig({ aiModel: savedModel }) === savedModel)
check('the saved default leads the offered models before refresh',
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

const noteTurn = promptFor('What does the introduction say?', {
  note: 'notes/lecture.md', kind: 'note', line: 12, heading: 'Introduction',
  excerpt: 'The introduction starts here.\nIt covers the plan.',
  excerptCut: true,
  noteChars: 42000
})
check('a markdown note carries a bounded excerpt around the cursor',
      noteTurn.includes('<open-note>notes/lecture.md') &&
      noteTurn.includes('Note text around the cursor') &&
      noteTurn.includes('The introduction starts here.'))
check('and says how much of the note is not shown',
      noteTurn.includes('42,000 characters shown') && noteTurn.includes('read the file for the rest'))

const wholeNoteTurn = promptFor('Check this note.', {
  note: 'notes/short.md', kind: 'note', line: 1,
  excerpt: 'A short note.', excerptCut: false, noteChars: 12
})
check('a note small enough to show whole says so',
      wholeNoteTurn.includes('the whole note shown') && wholeNoteTurn.includes('A short note.'))

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

/* Shaped as `devin models list` answers: a family line naming the shelf, its
   aliases, and then one indented row per variant. Devin spells the reasoning
   level into the model id rather than taking it as a flag, so a family arrives
   as one row per level — and the parser's whole job is to put the level back on
   the effort dial, where it belongs, instead of leaving five copies of one
   model in the list. */
const devinCatalogue = `Available models (37 families)

Claude Opus 5 (claude-opus-5)
  aliases: opus
  claude-opus-5-medium                   Claude Opus 5 Medium  [1M context, $5 / MTok In · $25 / MTok Out]
  claude-opus-5-high                     Claude Opus 5 High  [1M context, $5 / MTok In · $25 / MTok Out]
  claude-opus-5-high-fast                Claude Opus 5 High Fast  [1M context, $10 / MTok In · $50 / MTok Out]
  claude-opus-5-max-fast                 Claude Opus 5 Max Fast  [1M context, $10 / MTok In · $50 / MTok Out]

GPT-5.6 Sol (gpt-5.6-sol)
  gpt-5-6-sol-none                       GPT-5.6 Sol No Thinking  [272K context, $5 / MTok In]

SWE-1.7 (swe-1.7)
  swe-1-7                                SWE-1.7  [256K context, $1 / MTok In]
  swe-1-7-medium                         SWE-1.7 Medium  [256K context, $1 / MTok In]

Nemotron 3 Ultra (nemotron-3-ultra)
  nemotron-3-ultra-nvfp4                 Nemotron 3 Ultra  [128K context, $1 / MTok In]
`

const devinModels = parseDevin(devinCatalogue)
same('a family of levels is one model, not one model per level',
     devinModels.map((m) => m.id),
     [
       'claude-opus-5-{effort}',
       'claude-opus-5-{effort}-fast',
       'gpt-5-6-sol-{effort}',
       'swe-1-7-{effort}',
       'nemotron-3-ultra-nvfp4'
     ])
same('the levels it was listed at become its effort ladder',
     devinModels[0].efforts, ['medium', 'high'])
check('and one of them is the default', devinModels[0].effort === 'medium')
same('what follows the level is a model of its own, named for it',
     [devinModels[1].label, devinModels[1].efforts], ['Claude Opus 5 Fast', ['high', 'max']])
same('a model is named after its family, never after the level',
     devinModels.map((m) => m.label),
     ['Claude Opus 5', 'Claude Opus 5 Fast', 'GPT-5.6 Sol', 'SWE-1.7', 'Nemotron 3 Ultra'])
same('the family names the shelf it sits on',
     devinModels.map((m) => m.group),
     ['Claude Opus 5', 'Claude Opus 5', 'GPT-5.6 Sol', 'SWE-1.7', 'Nemotron 3 Ultra'])
check('the context window is read out of the brackets',
      devinModels[0].context === 1000000 && devinModels[2].context === 272000)
/* `swe-1-7` and `swe-1-7-medium` are the same model said twice, and two rows
   with one name is worse than one. A tail that is not a level — `nvfp4` — is
   not a level, and that model keeps its own id and offers no dial. */
check('a plain row is dropped when the same model also arrived with levels',
      !devinModels.some((m) => m.id === 'swe-1-7'))
check('and a tail that is not a level leaves the id alone',
      devinModels[4].id === 'nemotron-3-ultra-nvfp4' && devinModels[4].efforts.length === 0)
check('an alias line is not a model', !devinModels.some((m) => /alias/.test(m.id)))
check('and neither is the count at the top',
      !devinModels.some((m) => /families/.test(m.label)))
same('a catalogue with no families at all is empty', parseDevin('Nothing here\n'), [])

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
