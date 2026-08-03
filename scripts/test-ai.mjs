/**
 * The copilot's parsers, checked against what the CLIs actually say.
 *
 * Everything the panel knows about a turn arrives through four hand-rolled
 * readers — a streaming-JSON reader for arguments still being typed, a
 * line-splitter over a pipe, two catalogue parsers — plus one regular
 * expression tried at every `[` of every reply. None of them is reachable from
 * the six calls electron/ai.js exports, and nothing short of running all three
 * programs exercises any of it, so a regression here is invisible until the
 * copilot is being used for real: a note half-written into the preview, a
 * catalogue that silently loses its models, a citation that eats a link.
 *
 * All of it is pure, which is the whole reason this file can exist. The inputs
 * below are copied from real output — see the shapes in `codex exec --json` and
 * `opencode models --verbose` — rather than invented, because a parser tested
 * against a guess about its input is a parser tested against nothing.
 *
 *   npm run test:ai
 */
import MarkdownIt from 'markdown-it'

import ai from '../electron/ai.js'
import { citePlugin } from '../src/cite.js'

const { draftFields, detailOf, readLines, parseCodex, parseOpencode, codexTool } = ai.parsers

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}
const same = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
        `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)

/* ------------------------------------------------------------ draftFields */

/* The one that matters most: this is what the editor draws a live preview from
   while the copilot types a note, so every case here is a way the preview can
   show something that was never written. */

same('a field that has closed',
     draftFields('{"file_path":"Notes/A.md"}'), { file_path: 'Notes/A.md' })

// The point of the whole function: the last field is still arriving, and its
// tail is what the preview is made of.
same('the open field comes back as `writing`',
     draftFields('{"file_path":"A.md","new_string":"hel'),
     { file_path: 'A.md', new_string: 'hel', writing: 'new_string' })

check('a closed object names nothing as writing',
      draftFields('{"content":"hi"}').writing === undefined)

same('the JSON escapes are undone',
     draftFields('{"content":"a\\nb\\"c\\\\d"}'), { content: 'a\nb"c\\d' })

same('\\u escapes are undone',
     draftFields('{"content":"caf\\u00e9"}'), { content: 'café' })

/* A fragment can end in the middle of an escape, and half an escape is not a
   character. Guessing at the rest would put a stray backslash in the note. */
same('a backslash at the very end is not decoded',
     draftFields('{"content":"a\\'), { content: 'a', writing: 'content' })
same('half a \\u escape is not decoded',
     draftFields('{"content":"a\\u00'), { content: 'a', writing: 'content' })

// `replace_all` — nothing reads it, but stopping at the wrong place would
// strand every field after it.
check('a boolean is skipped and the field after it survives',
      draftFields('{"replace_all":true,"new_string":"x"}').new_string === 'x')
check('a number is skipped and the field after it survives',
      draftFields('{"n":12,"new_string":"x"}').new_string === 'x')

/* The bracket inside a string. Counted as a bracket it closes the array a
   character early, the skip then stops on the real `]`, and `new_string` — the
   text of the note — is never seen at all. Nothing Edit or Write sends is
   shaped like this today; this is here so that stays a fact about the tools
   rather than a thing this parser depends on. */
check('a bracket inside a string does not end the skip',
      draftFields('{"todos":["a]b"],"new_string":"x"}').new_string === 'x',
      JSON.stringify(draftFields('{"todos":["a]b"],"new_string":"x"}')))
check('a brace inside a string does not end the skip',
      draftFields('{"o":{"k":"}"},"new_string":"x"}').new_string === 'x')
check('a comma inside a nested string does not end the skip',
      draftFields('{"todos":["a,b"],"new_string":"x"}').new_string === 'x')

// A key that has not finished arriving is not a key yet.
same('half a key is not reported',
     draftFields('{"file_path":"A.md","new_st'), { file_path: 'A.md' })

same('nothing at all', draftFields(''), {})
same('not an object', draftFields('hello'), {})
same('the opening brace alone', draftFields('{'), {})

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

/* Shaped as `codex debug models` answers: the entries say which of themselves
   to show, in what order, and what reasoning levels each takes. */
const codexCatalogue = JSON.stringify({
  models: [
    {
      slug: 'gpt-6', display_name: 'GPT-6', priority: 2, context_window: 400000,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }],
      default_reasoning_level: 'high'
    },
    { slug: 'internal', display_name: 'Internal', visibility: 'hide', priority: 0 },
    { slug: 'gpt-6-mini', display_name: 'GPT-6 mini', priority: 1, context_window: 200000 }
  ]
})

const codexModels = parseCodex(codexCatalogue)
same('hidden models are dropped and priority decides the order',
     codexModels.map((m) => m.id), ['gpt-6-mini', 'gpt-6'])
same('the levels a model takes are read off it',
     codexModels[1].efforts, ['low', 'high', 'xhigh'])
check('and its default is honoured', codexModels[1].effort === 'high')
check('the context window is carried', codexModels[1].context === 400000)
check('a model with no levels offers none', codexModels[0].efforts.length === 0)

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

/* -------------------------------------------------------------- codexTool */

/* Codex announces a call twice — running, then finished — and both have to name
   it the same way, or the panel draws two rows for one command. */
same('a command is a Bash step',
     codexTool({ type: 'command_execution', command: 'ls -l' }),
     { name: 'Bash', path: 'ls -l' })
same('a file search is a Grep step',
     codexTool({ type: 'file_search', query: 'wave equation' }),
     { name: 'Grep', path: 'wave equation' })
same('a web search is a Fetch step',
     codexTool({ type: 'web_search', query: 'bicycle history' }),
     { name: 'Fetch', path: 'bicycle history' })
check('and everything else is not a tool call at all',
      codexTool({ type: 'agent_message', text: 'hello' }) === null &&
      codexTool({ type: 'reasoning' }) === null)

/* ------------------------------------------------------------- citations */

/* Same options the panel builds its renderer with, so what is asserted here is
   what a reply actually renders as. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true })
  .use(citePlugin)

const cited = (text) => md.render(text)
const pageOf = (text) => /data-cite-page="(\d+)"/.exec(cited(text))?.[1] || null
const pathOf = (text) => /data-cite-path="([^"]*)"/.exec(cited(text))?.[1] || null

check('[p. 12]', pageOf('See [p. 12].') === '12')
check('[pp. 12–14] cites the first page', pageOf('See [pp. 12–14].') === '12')
check('[pp. 12-14] with a plain hyphen', pageOf('See [pp. 12-14].') === '12')
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
