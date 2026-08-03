/* Measure the DOM cost of renderReading's innerHTML in real Chromium: the
   3MB rendered string must be parsed by the HTML parser and laid out. */

import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { createMarkdown } from '../src/markdown.js'
import katex from 'katex'
import { findMath } from '../src/math.js'

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

const LINES = 1500
const EQ_POOL = [
  '\\frac{n(n+1)}{2}', '\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}',
  'e^{i\\pi} + 1 = 0', '\\int_0^\\infty e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}',
  '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1', '\\binom{n}{k} = \\frac{n!}{k!(n-k)!}'
]
const INLINE_EQ = ['x^2', '\\alpha + \\beta', '\\lambda_1', '\\sqrt{2}', '\\theta', 'a_n']
function note () {
  const parts = []
  let line = 0
  const block = (s) => { parts.push(s); line += s.split('\n').length }
  for (let i = 1; i <= LINES; i += 6) {
    block(`\n## Heading ${i} with a [[wikilink-${i}]] and #tag${i}\n`)
    block(`The **quick** brown fox jumps over the *lazy* dog, and the cost is $5 and $1,234.56. `
      + INLINE_EQ.map((e, k) => `$\\text{${k}}${e}$ `).join('') + `\n`)
    block(`- [ ] task ${i}\n- [x] done ${i}\n- item with \`inline code\` and [link](https://example.org/${i})\n`)
    if (i % 24 === 1) block(EQ_POOL.map((e, k) => `$$\n\\text{Eq ${i}-${k}} \\label{eq:${i}-${k}}\n${e}\n$$`).join('\n\n'))
    if (i % 30 === 1) {
      block(`\n| Word | Reading | Meaning |\n| --- | --- | --- |\n`
        + Array.from({ length: 12 }, (_, r) => `| word-${i}-${r} | こ${r} | meaning ${r} |`).join('\n') + `\n`)
    }
    if (i % 42 === 1) block(`\`\`\`python\nfor i in range(10):\n    print(f"value {i}")\n\`\`\`\n`)
    if (i % 60 === 1) block(`> [!tip] Callout ${i}\n> Some emphasised insight with $x^2$ inside.\n`)
    if (i % 90 === 1) block(`A footnote reference[^n${i}].\n\n[^n${i}]: The note itself, ${i}.\n`)
    if (i % 150 === 1) block(`![alt text|200](image-${i}.png)\n`)
  }
  return parts.join('\n')
}

const body = note()
const md = createMarkdown({ resolveEmbedSrc: (s) => s })
const equations = (() => {
  const labels = new Map()
  let number = 0
  for (const span of findMath(body)) {
    if (!span.display) continue
    const found = /\\label\s*\{([^{}]+)\}/.exec(span.tex)
    if (!found) continue
    number++
    labels.set(found[1].trim(), { label: found[1].trim(), tag: String(number) })
  }
  return labels
})()
const html = md.render(body, { equations })
writeFileSync('node_modules/.cache/reading.html', html)

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  win.loadURL('about:blank').then(() => {
    win.webContents.executeJavaScript(`
      (async () => {
        const html = ${JSON.stringify(html)}
        const out = {}
        const holder = document.createElement('div')
        document.body.append(holder)
        let t = performance.now()
        holder.innerHTML = html
        out.innerHTMLFirst = performance.now() - t
        holder.replaceChildren()
        for (let i = 0; i < 5; i++) {
          t = performance.now()
          holder.innerHTML = html
          out['innerHTML' + i] = performance.now() - t
          holder.replaceChildren()
        }
        // with the node kept alive and reattached (memoized-DOM variant)
        const cached = document.createElement('div')
        t = performance.now()
        cached.innerHTML = html
        out.innerHTMLOnce = performance.now() - t
        holder.append(cached)
        t = performance.now()
        cached.remove(); document.body.append(cached)
        out.reattach = performance.now() - t
        return out
      })()
    `).then((out) => {
      console.log(JSON.stringify(out, null, 2))
      app.exit(0)
    })
  })
})