/* Tulip render-pipeline benchmark: runs the real modules (markdown.js, math.js,
   money.js, katex) in Node with a minimal DOM stub, measures where the reading
   view's cost goes, and evaluates candidate optimizations head-to-head. */

globalThis.document = {
  createElement: () => ({
    classList: { add () {} }, dataset: {}, style: {}, append () {},
    addEventListener: (_ev, cb) => cb && cb()
  }),
  createElementNS: () => ({
    attrs: {}, setAttribute (k, v) { this.attrs[k] = v }, getAttribute (k) { return this.attrs[k] },
    innerHTML: '', classList: { add () {} }, style: {}, dataset: {}, append () {}, remove () {}
  }),
  documentElement: { style: {} },
  head: { append () {} }
}
globalThis.navigator ||= { userAgent: 'bench', platform: 'MacIntel' }
globalThis.performance ||= (() => {
  const start = process.hrtime.bigint()
  return { now: () => Number(process.hrtime.bigint() - start) / 1e6 }
})()

const { createMarkdown } = await import('../src/markdown.js')
const { findMath, equationIndex, mathPlugin, prepareMath } = await import('../src/math.js')
const katex = (await import('katex')).default

/* ------------------------------------------------------------- workload */

const LINES = 1500
const OUTER = (s, i) => `${s} ${i}`
const EQ_POOL = [
  '\\frac{n(n+1)}{2}',
  '\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}',
  'e^{i\\pi} + 1 = 0',
  '\\int_0^\\infty e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}',
  '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
  '\\binom{n}{k} = \\frac{n!}{k!(n-k)!}'
]
const INLINE_EQ = [
  'x^2', '\\alpha + \\beta', '\\lambda_1', '\\sqrt{2}', '\\theta', 'a_n'
]

function note () {
  const parts = []
  let line = 0
  const block = (s) => { parts.push(s); line += s.split('\n').length }
  for (let i = 1; i <= LINES; i += 6) {
    block(`\n## Heading ${i} with a [[wikilink-${i}]] and #tag${i}\n`)
    block(OUTER('The **quick** brown fox jumps over the *lazy* dog, and the'
      + ` cost is $5 and $1,234.56. `, i)
      + INLINE_EQ.map((e, k) => `$\\text{${k}}${e}$ `).join('') + `\n`)
    block(`- [ ] task ${i}\n- [x] done ${i}\n- item with \`inline code\` and [link](https://example.org/${i})\n`)
    if (i % 24 === 1) {
      block(EQ_POOL.map((e, k) => `$$\n\\text{Eq ${i}-${k}} \\label{eq:${i}-${k}}\n${e}\n$$`).join('\n\n'))
    }
    if (i % 30 === 1) {
      block(`\n| Word | Reading | Meaning |\n| --- | --- | --- |\n`
        + Array.from({ length: 12 }, (_, r) => `| word-${i}-${r} | こ${r} | meaning ${r} |`).join('\n')
        + `\n`)
    }
    if (i % 42 === 1) {
      block(`\`\`\`python\nfor i in range(10):\n    print(f"value {i}")\n\`\`\`\n`)
    }
    if (i % 60 === 1) {
      block(`> [!tip] Callout ${i}\n> Some emphasised insight with $x^2$ inside.\n`)
    }
    if (i % 90 === 1) block(`A footnote reference[^n${i}].\n\n[^n${i}]: The note itself, ${i}.\n`)
    if (i % 150 === 1) block(`![alt text|200](image-${i}.png)\n`)
  }
  return parts.join('\n')
}

/* --------------------------------------------------------------- harness */

const LABEL = /\\label\s*\{([^{}]+)\}/
const TAG = /\\tag\*?\s*\{([^{}]+)\}/

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const stats = (xs) => ({ median: med(xs).toFixed(1), min: Math.min(...xs).toFixed(1), max: Math.max(...xs).toFixed(1) })

async function timeIt (fn, { warmup = 3, runs = 9 } = {}) {
  for (let i = 0; i < warmup; i++) await fn()
  const out = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    out.push(performance.now() - t0)
  }
  return out
}

const pc = (fast, slow) => ((1 - fast / slow) * 100).toFixed(1)

/* ------------------------------------------------------------- baseline */

const body = note()
console.log(`note: ${LINES} lines, ${body.length.toLocaleString()} chars`)

const md = createMarkdown({ resolveEmbedSrc: (s) => s })
const equations = equationIndex(body)

/* KaTeX is loaded on demand, and until it is, `renderMath` emits a
   `math-pending` placeholder and never calls the typesetter. The app loads it
   before a note is shown; a bench that does not measures markdown-it alone and
   misses the majority of a real render — which is what this one did, and why
   its own call counter below printed zero. */
await prepareMath(body)

/* The first render of the note, before anything is cached: what opening a note
   costs. Taken before `timeIt`, whose warmup runs would fill the cache. */
let coldHtml = ''
const coldOpen = (() => {
  const t0 = performance.now()
  coldHtml = md.render(body, { equations })
  return performance.now() - t0
})()

/* The cache is only worth having if it is invisible. Every expression in the
   note was typeset for the first time above and comes from the cache below, so
   a difference here is the cache answering for an expression that was not the
   one asked about. */
const warmHtml = md.render(body, { equations })
console.log(`\ncached render identical:  ${warmHtml === coldHtml}` +
  ` (${coldHtml.length.toLocaleString()} chars)`)

const scans = await timeIt(() => findMath(body))
const eqIdx = await timeIt(() => equationIndex(body))
const render = await timeIt(() => md.render(body, { equations }))

console.log('\n-- baseline (median ms) --')
console.log(`findMath(body)            ${stats(scans).median}`)
console.log(`equationIndex(body)       ${stats(eqIdx).median}`)
console.log(`md.render (first open)    ${coldOpen.toFixed(1)}`)
console.log(`md.render (re-render)     ${stats(render).median}`)
console.log(`  -> parse+typeset+render string, incl. ${findMath(body).length} math spans, ${equations.size} labels`)

/* Where does md.render's time go: markdown-it parse, or the renderer pass
   (which is where every katex.renderToString call happens)? */
const tokens = md.parse(body, { equations })
const parsed = await timeIt(() => md.parse(body, { equations }))
const renderedTokens = await timeIt(() => md.renderer.render(tokens, md.options, { equations }))
const katexShare = await timeIt(() => {
  md.renderer.render(md.parse(body.replace(/\$/g, ''), {}), md.options, {})
})
console.log(`md.parse                  ${stats(parsed).median}`)
console.log(`renderer.render(tokens)   ${stats(renderedTokens).median}`)
console.log(`render without any '$'    ${stats(katexShare).median}`)
/* Both of the above are steady-state, where every expression is already
   typeset — so the difference between them says nothing about maths. What
   typesetting costs is what the first render paid and the rest did not. */
console.log(`typesetting (first open)  ${(coldOpen - med(render)).toFixed(1)}  (${pc(med(render), coldOpen)}% of the first render)`)

/* -------------------------------------------------------- candidate S1.
   The reading view re-renders the whole note on every view toggle / save /
   external change. Memoizing the rendered HTML on the exact body string turns
   every toggle after the first into a cache hit. */
const htmlCache = new Map()
const memoRender = (text) => {
  let html = htmlCache.get(text)
  if (html === undefined) {
    html = md.render(text, { equations: equationIndex(text) })
    htmlCache.set(text, html)
    if (htmlCache.size > 2) htmlCache.delete(htmlCache.keys().next().value)
  }
  return html
}
await memoRender(body) // warm the cache
const memoHit = await timeIt(() => memoRender(body))
let miss = 0
const memoMiss = await timeIt(() => memoRender(body + `\n\nEdited: the note changed #${miss++}.`))
console.log(`\n-- candidate S1: memoize render on body string --`)
console.log(`cache hit (toggle back)   ${stats(memoHit).median}`)
console.log(`cache miss (edited note)  ${stats(memoMiss).median}`)
console.log(`vs baseline md.render:    ${pc(med(memoHit), med(render))}% faster on hit`)

/* How many of the note's 1903 spans still reach the typesetter once the note
   has been rendered before. Zero is the answer the cache in src/math.js exists
   to produce, and the check that it is still keyed on everything it should be:
   a call here means an expression the cache did not recognise as one it had
   already seen. */
{
  const original = katex.renderToString
  let calls = 0
  let chars = 0
  katex.renderToString = function (tex, opts) { calls++; chars += tex.length; return original(tex, opts) }
  md.render(body, { equations })
  katex.renderToString = original
  console.log(`\n-- katex calls on re-render: ${calls} of ${findMath(body).length} spans (${chars} chars of tex) --`)
}
/* ------------------------------------------------------ katex isolation.
   The renderer pass is ~2.5ms; verify the per-call cost of renderToString to
   size the cache candidate's ceiling. */
{
  const spans = findMath(body)
  const sources = spans.map((s) => {
    const found = LABEL.exec(s.tex)
    const label = found?.[1]?.trim() || ''
    return String(s.tex || '').replace(/\\label\s*\{[^{}]+\}/g, '').trim()
  })
  const plain = await timeIt(() => {
    for (const tex of sources) katex.renderToString(tex, { displayMode: false, throwOnError: false, output: 'htmlAndMathml' })
  })
  const display = await timeIt(() => {
    for (const tex of sources) katex.renderToString(tex, { displayMode: true, throwOnError: false, output: 'htmlAndMathml' })
  })
  console.log(`\n-- katex isolation (${sources.length} unique tex) --`)
  console.log(`all renderToString         ${stats(plain).median} ms  (${(med(plain) / sources.length * 1000).toFixed(0)} us/expr)`)
  console.log(`all renderToString display ${stats(display).median} ms`)
}

/* How much of the render is KaTeX? Rerun the same render: katex's internal
   font-metric caches are warm the second time; the difference is a lower bound
   on the repeat-visit cost. */
const r2 = await timeIt(() => md.render(body, { equations }))
console.log(`md.render second time     ${stats(r2).median}  (katex internals warm)`)
console.log(`repeat-visit cost:        ${pc(med(r2), med(render))}% faster on rerender`)

/* ----------------------------------------------------------------- A.
   Candidate: cache renderToString output keyed on final source+display mode.
   katex.parse is the dominant share of renderToString; a Map turns a rerender
   of the same note into a hash lookup per expression. */
const mkMd = (cache) => {
  const m = createMarkdown({ resolveEmbedSrc: (s) => s })
  const renderer = m.renderer
  const renderMath = (tex, displayMode = false) => {
    const key = (displayMode ? 'd\0' : 'i\0') + tex
    let html = cache.get(key)
    if (html === undefined) {
      html = katex.renderToString(tex, {
        displayMode,
        throwOnError: false,
        errorColor: 'var(--accent)',
        strict: false,
        trust: false,
        output: 'htmlAndMathml'
      })
      cache.set(key, html)
    }
    return html
  }
  renderer.rules.math_inline = (tokens, i) => renderMath(equationSource0(tokens[i].content).source, false)
  renderer.rules.math_inline_display = (tokens, i) =>
    `<span class="tk-math tk-math-display">${renderMath(equationSource0(tokens[i].content).source, true)}</span>`
  renderer.rules.math_block = (tokens, i, _o, env) => {
    const equation = equationSource0(tokens[i].content)
    const identity = equation.label
      ? ` id="eq-${encodeURIComponent(equation.label).replaceAll('%', '_')}" data-equation="${m.utils.escapeHtml(equation.label)}"`
      : ''
    return `<div class="math-block"${identity}>${renderMath(equation.source, true)}</div>`
  }
  return m
}
/* the app's own equationSource logic, replicated verbatim from math.js (it is
   not exported) so the cached renderer is the same pipeline with one swap */
const equationSource0 = (tex) => {
  const found = LABEL.exec(tex)
  const label = found?.[1]?.trim() || ''
  let source = String(tex || '').replace(/\\label\s*\{[^{}]+\}/g, '').trim()
  const tag = label ? equations?.get(label)?.tag || TAG.exec(source)?.[1]?.trim() || '' : ''
  if (label && tag && !TAG.test(source)) source += ` \\tag{${tag}}`
  TAG.lastIndex = 0
  return { source, label, tag }
}

/* correctness: a fresh-cache render must match the baseline byte for byte */
const mdCached = mkMd(new Map())
const a = md.render(body, { equations })
const b = mdCached.render(body, { equations })
console.log(`\n-- candidate A: katex renderToString cache --`)
console.log(`identical output:         ${a === b} (${a.length} bytes)`)

/* true cold: every run renders from an empty cache (the realistic first open) */
const cold = await timeIt(() => {
  const fresh = mkMd(new Map())
  return fresh.render(body, { equations })
})
/* warm: one render fills the cache, then every rerender is a lookup */
const mdWarm = mkMd(new Map())
mdWarm.render(body, { equations })
const warm = await timeIt(() => mdWarm.render(body, { equations }))
console.log(`true-cold render           ${stats(cold).median}  (fresh Map per run)`)
console.log(`warm render                ${stats(warm).median}  (spans already in Map)`)
console.log(`vs baseline first render:  ${pc(med(cold), med(render))}% faster`)
console.log(`vs baseline rerender:      ${pc(med(warm), med(r2))}% faster`)
console.log(`distinct tex (cache keys): ${new Set(findMath(body).map((s) => s.tex)).size}`)

/* ------------------------------------------------------------ micro B.
   The hashtag rule copies the rest of the line's remainder with src.slice(pos)
   on every '#' boundary. Candidate: a sticky regex over the original string. */
{
  const TAG = /^#[\p{L}\p{N}][\p{L}\p{N}/_-]*/u
  const sticky = (src, pos) => {
    if (src.charCodeAt(pos) !== 0x23) return null
    if (pos > 0 && !/\s/.test(src[pos - 1])) return null
    const m = TAG.exec(src.slice(pos))
    return m ? m[0].length : 0
  }
  const stickyZero = (src, pos) => {
    if (src.charCodeAt(pos) !== 0x23) return null
    if (pos > 0 && !/\s/.test(src[pos - 1])) return null
    const m = TAG.exec(src.slice(pos, pos + 64))
    return m ? m[0].length : 0
  }
  const stickyReg = /^#[\p{L}\p{N}][\p{L}\p{N}/_-]*/uy
  const stickyY = (src, pos) => {
    if (src.charCodeAt(pos) !== 0x23) return null
    if (pos > 0 && !/\s/.test(src[pos - 1])) return null
    stickyReg.lastIndex = pos
    const m = stickyReg.exec(src)
    return m ? m[0].length : 0
  }
  const manual = (src, pos) => {
    if (src.charCodeAt(pos) !== 0x23) return null
    if (pos > 0 && !/\s/.test(src[pos - 1])) return null
    let i = pos + 1
    if (!/[\p{L}\p{N}]/u.test(src[i])) return null
    while (i < src.length && /[\p{L}\p{N}/_-]/u.test(src[i])) i++
    return i - pos
  }
  const tags = []
  for (let i = 0; i < body.length; i++) if (body[i] === '#') tags.push(i)
  console.log(`\n-- micro B: hashtag rule at ${tags.length} '#' positions --`)
  const eq = (f, g) => JSON.stringify(tags.map((t) => f(body, t))) === JSON.stringify(tags.map((t) => g(body, t)))
  console.log(`variants agree:           ${eq(sticky, manual) && eq(stickyZero, manual) && eq(stickyY, manual)}`)
  for (const [name, fn] of [['current slice()', sticky], ['slice(0,64) cap', stickyZero], ['sticky /y regex', stickyY], ['manual scan', manual]]) {
    const t = await timeIt(() => { for (const p of tags) fn(body, p) })
    console.log(`${name.padEnd(24)} ${stats(t).median} ms  (${Math.round(med(t) / tags.length * 1000)} ns/tag)`)
  }
}

/* -------------------------------------------------------------- micro C.
   moneyPlugin: mathsIn(src) re-scans the paragraph per inline run; measure the
   findMoney whole-note scan that find.js/table.js style passes do. */
console.log(`\n-- micro C: (skipped, findMoney is module-private) --`)

/* ---------------------------------------------------------- candidate D.
   renderReading rebuilds the DOM on every switch. Nothing DOM here, but the
   two scans it runs over the rendered HTML (querySelectorAll('table') wrap +
   dressEmbeds + dressCodeBlocks) are unmeasurable in Node without a real DOM;
   note the reading-view renderer already replaced innerHTML-based assembly. */

console.log(`\ndone.`)
process.exit(0)
