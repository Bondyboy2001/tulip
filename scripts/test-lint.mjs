/**
 * What the house style must do to a note, and what it must leave alone.
 *
 * The linter runs on every save, over notes whose only copy is the one being
 * rewritten, so the interesting assertions here are the negative ones: a rule
 * that reaches into a code block, renumbers a YAML comment, or turns two
 * sibling headings into a parent and a child does its damage silently and
 * across a whole vault at once.
 *
 * Every case is also checked to be a fixed point — linting the result again
 * changes nothing — because the editor lints on every save, and a rule that
 * disagrees with itself would rewrite the same note forever.
 *
 *   node scripts/test-lint.mjs
 */
import { lintMarkdown, lintEdits } from '../src/lint.js'

let failures = 0
const show = (text) => JSON.stringify(text)

const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** `input` lints to `want`, and `want` lints to itself. */
const lints = (name, input, want) => {
  const got = lintMarkdown(input)
  check(name, got === want, `${show(input)} → ${show(got)}, wanted ${show(want)}`)
  const again = lintMarkdown(got)
  check(`${name}: settles`, again === got, `${show(got)} → ${show(again)}`)
}

/** `input` is already in the house style. */
const untouched = (name, input) => lints(name, input, input)

/* ------------------------------------------------------- rules 1 and 2 */
/* The rules that were here before headings were, so that adding them did not
   quietly change what a note without any looks like. */

lints('blank runs collapse', 'a\n\n\n\nb\n', 'a\n\nb\n')
lints('the file loses its edges', '\n\na\n\n\n', 'a\n')
lints('the file ends in one newline', 'a', 'a\n')
lints('a fence gets its blank lines', 'a\n```js\nx\n```\nb\n', 'a\n\n```js\nx\n```\n\nb\n')
untouched('a blank line inside a fence stays', '```\na\n\n\nb\n```\n')
untouched('an empty file is left alone', '')
untouched('a file of whitespace is left alone', '\n\n\n')

/* ----------------------------------------------- rule 3: blank lines */

lints('a heading gets a blank line above and below',
  '# One\ntext\n## Two\nmore\n',
  '# One\n\ntext\n\n## Two\n\nmore\n')

lints('one blank line, not two',
  '# One\n\n\n\ntext\n',
  '# One\n\ntext\n')

lints('a heading against a code fence asks for one gap, not two',
  '```\nx\n```\n# One\n',
  '```\nx\n```\n\n# One\n')

lints('a heading under a maths block is parted from it',
  '$$\nx = 1\n$$\n# One\n',
  '$$\nx = 1\n$$\n\n# One\n')

lints('two headings in a row are parted', '# One\n## Two\n', '# One\n\n## Two\n')

untouched('a heading at the top of the file wants nothing above it', '# One\n\ntext\n')
lints('a heading at the top of the file loses the blank above it', '\n# One\n', '# One\n')
untouched('a heading at the end of the file wants nothing below it', 'text\n\n# One\n')

/* ----------------------------------------------- rule 4: standalone images */

lints('a standalone image gets a blank line above',
  'Now, let\'s plot the runtime, flops, and memory bandwidth achieved as a function of the compute intensity. Note that everything is on a log-log scale.\n![](https://horace.io/img/perf_intro/microbench.png)\n',
  'Now, let\'s plot the runtime, flops, and memory bandwidth achieved as a function of the compute intensity. Note that everything is on a log-log scale.\n\n![](https://horace.io/img/perf_intro/microbench.png)\n')

lints('a standalone image gets a blank line below',
  '![](https://horace.io/img/perf_intro/microbench.png)\nMore prose.\n',
  '![](https://horace.io/img/perf_intro/microbench.png)\n\nMore prose.\n')

lints('one blank line around an image, not two',
  'before\n\n\n![](a.png)\n\n\nafter\n',
  'before\n\n![](a.png)\n\nafter\n')

lints('two images in a row are parted',
  '![](a.png)\n![](b.png)\n',
  '![](a.png)\n\n![](b.png)\n')

lints('an image under a heading asks for one gap, not two',
  '# Plot\n![](a.png)\n',
  '# Plot\n\n![](a.png)\n')

lints('an image under a fence asks for one gap, not two',
  '```\nx\n```\n![](a.png)\n',
  '```\nx\n```\n\n![](a.png)\n')

lints('a wiki embed is an image too',
  'See the figure.\n![[microbench.png]]\nNext.\n',
  'See the figure.\n\n![[microbench.png]]\n\nNext.\n')

lints('a titled image still counts',
  'before\n![plot](a.png "Runtime")\nafter\n',
  'before\n\n![plot](a.png "Runtime")\n\nafter\n')

untouched('an image at the top of the file wants nothing above it',
  '![](a.png)\n\ntext\n')
untouched('an image at the end of the file wants nothing below it',
  'text\n\n![](a.png)\n')
untouched('a line of badges is one figure, not several',
  'text\n\n![a](a.png) ![b](b.png)\n\nmore\n')
untouched('an image inside a sentence is left alone',
  'See ![](a.png) here.\n')
untouched('a list item image is left alone',
  '- ![](a.png)\n- next\n')
untouched('an image in a code fence is left alone',
  '```md\n![](a.png)\n```\n')

/* -------------------------------------------------- not a heading */

untouched('a hash in a code block is not a heading', '```sh\n# install\nls\n```\n')
untouched('an indented code block is not renumbered',
  'text\n\n    # one\n    ### three\n\nmore\n')
untouched('a tag is not a heading', 'text\n#tag\nmore\n')
untouched('a bare hash is not a heading', 'text\n#\nmore\n')
untouched('seven hashes are not a heading', 'text\n####### nope\nmore\n')

/* -------------------------------------------------- rule 5: heading levels */

lints('a skipped level is closed up', '# One\n\n### Three\n', '# One\n\n## Three\n')

lints('siblings stay siblings',
  '# One\n\n### A\n\n### B\n',
  '# One\n\n## A\n\n## B\n')

lints('a whole outline is pulled up',
  '## Setup\n\n#### Deps\n\n#### Build\n\n## Usage\n',
  '# Setup\n\n## Deps\n\n## Build\n\n# Usage\n')

lints('depth is kept while the gaps are taken out',
  '# One\n\n### Two\n\n##### Three\n\n### Four\n\n# Five\n',
  '# One\n\n## Two\n\n### Three\n\n## Four\n\n# Five\n')

untouched('climbing back is not a mistake',
  '# One\n\n## Two\n\n### Three\n\n# Four\n\n## Five\n')

untouched('a note already in step is left alone', '# One\n\n## Two\n\n### Three\n')

lints('a note that starts deep still comes out at #', '###### Deep\n', '# Deep\n')

lints('the two rules meet on one line',
  'text\n### Three\ntext\n',
  'text\n\n# Three\n\ntext\n')

/* Frontmatter is YAML, where `#` opens a comment. Renumbering one would write
   nonsense into the note's metadata, and the blank line rule would push the
   closing `---` away from the block it closes. */
untouched('frontmatter is not a heading block',
  '---\ntitle: One\n# a comment\ntags: [a]\n---\n\n# One\n')

lints('the heading under frontmatter is still numbered',
  '---\ntitle: One\n---\n\n### Three\n',
  '---\ntitle: One\n---\n\n# Three\n')

/* -------------------------------------------- rule 6: trailing whitespace */

lints('trailing spaces go', '1. 🌟 \n', '1. 🌟\n')
lints('trailing tabs go', 'text\t\n', 'text\n')
lints('the kept blank line is emptied', 'a\n   \n\nb\n', 'a\n\nb\n')
lints('a hard break is trailing space too', 'one  \ntwo\n', 'one\ntwo\n')
lints('three spaces go the same way', 'one   \ntwo\n', 'one\ntwo\n')
untouched('code keeps its trailing spaces', '```\nx  \n```\n')
untouched('maths keeps its trailing spaces', '$$\nx  \n$$\n')
untouched('frontmatter keeps its trailing spaces',
  '---\nkey: a  \n---\n\ntext\n')

/* ------------------------------------------------------------ the edits */

/* The editor applies these to a live document, where an overlapping or
   out-of-order pair is not a wrong answer but a thrown exception. */
const overlaps = (text) => {
  const edits = lintEdits(text)
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].from < edits[i - 1].to) return `${JSON.stringify(edits[i - 1])} then ${JSON.stringify(edits[i])}`
  }
  for (const edit of edits) if (edit.from > edit.to) return JSON.stringify(edit)
  return ''
}

const messy = '\n\n\n## Setup\ntext\n#### Deps\n```\n# not a heading\n```\n### Build\n\n\n\ntext\n![](a.png)\n\n\n'
check('edits are sorted and never overlap', !overlaps(messy), overlaps(messy))
check('edits still line up with trailing space everywhere',
  !overlaps('## Setup  \ntext \t \n#### Deps   \n```\nx  \n```\n![](a.png)  \ntext  \n'),
  overlaps('## Setup  \ntext \t \n#### Deps   \n```\nx  \n```\n![](a.png)  \ntext  \n'))
/* `#### Deps` and `### Build` both hang off `## Setup` — the level between them
   is never written, so they are siblings, and both come out one under Setup. */
lints('the messy note comes out whole', messy,
  '# Setup\n\ntext\n\n## Deps\n\n```\n# not a heading\n```\n\n## Build\n\ntext\n\n![](a.png)\n')

lints('bookmark keeps one leading blank', '\n\n<!-- bookmark -->\n\nText\n', '\n<!-- bookmark -->\n\nText\n')
lints('bookmark keeps one trailing blank', 'Text\n\n<!-- bookmark -->\n\n\n', 'Text\n\n<!-- bookmark -->\n\n')
lints('bookmark alone keeps both blanks', '\n<!-- bookmark -->\n\n', '\n<!-- bookmark -->\n\n')

console.log(failures ? `${failures} failing` : 'lint: all good')
process.exit(failures ? 1 : 0)
