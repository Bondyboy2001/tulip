globalThis.document = {
  createElement: () => ({
    classList: { add () {} }, dataset: {}, style: {}, append () {},
    addEventListener (event, callback) { if (event === 'load') queueMicrotask(callback) }
  }),
  createElementNS: () => ({
    attrs: {}, setAttribute (key, value) { this.attrs[key] = value },
    getAttribute (key) { return this.attrs[key] },
    innerHTML: '', classList: { add () {} }, style: {}, dataset: {}, append () {}, remove () {}
  }),
  documentElement: { style: {} },
  head: { append () {} },
  /* src/math.js resolves katex.css against `document.baseURI`, because that is
     the one base esbuild's splitting cannot move the module away from. A stub
     without one made `new URL('katex.css', undefined)` throw, and this whole
     benchmark stopped running — silently, because the other three still did.
     Any value parses; nothing here ever fetches it. */
  baseURI: 'file:///tulip-benchmark/'
}
globalThis.navigator ||= { userAgent: 'Tulip benchmark', platform: 'MacIntel' }

const { createMarkdown } = await import('../src/markdown.js')
const { findMath, equationIndex, prepareMath } = await import('../src/math.js')

const note = () => Array.from({ length: 250 }, (_, index) => `
## Heading ${index}

The **quick** brown fox has $x_${index % 12}^2 + \\sqrt{2}$ and [[Note ${index}]].

| Word | Meaning |
| --- | --- |
| word-${index} | meaning-${index} |

$$
\\sum_{i=1}^{${index + 1}} i \\label{eq:${index}}
$$
`).join('\n')

const body = note()
const md = createMarkdown({ resolveEmbedSrc: (source) => source })
await prepareMath(body)
const equations = equationIndex(body)

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const time = async (work, runs = 7) => {
  for (let index = 0; index < 2; index++) await work()
  const values = []
  for (let index = 0; index < runs; index++) {
    const start = performance.now()
    await work()
    values.push(performance.now() - start)
  }
  return median(values)
}

const cold = md.render(body, { equations })
const warm = md.render(body, { equations })
if (warm !== cold) throw new Error('cached renderer output differs from the cold render')

const result = {
  lines: body.split('\n').length,
  characters: body.length,
  outputBytes: cold.length,
  mathSpans: findMath(body).length,
  equationLabels: equations.size,
  medianMs: {
    findMath: Number((await time(() => findMath(body))).toFixed(2)),
    equationIndex: Number((await time(() => equationIndex(body))).toFixed(2)),
    renderWarm: Number((await time(() => md.render(body, { equations }))).toFixed(2))
  },
  correct: true
}
console.log(JSON.stringify(result, null, 2))
