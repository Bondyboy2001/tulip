import electron from 'electron'

const { app, BrowserWindow } = electron
globalThis.document = {
  /* src/math.js resolves the lazy KaTeX stylesheet from the document rather
     than from whichever shared chunk esbuild put the module in. Match the real
     page here so the DOM benchmark exercises maths instead of failing while
     constructing its URL. */
  baseURI: 'file:///tulip-dom-benchmark/',
  compatMode: 'CSS1Compat',
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
  head: { append () {} }
}
globalThis.navigator ||= { userAgent: 'Tulip benchmark', platform: 'MacIntel' }

app.whenReady().then(async () => {
  const { createMarkdown } = await import('../src/markdown.js')
  const { equationIndex, prepareMath } = await import('../src/math.js')
  const body = Array.from({ length: 250 }, (_, index) => `
## Heading ${index}

Paragraph ${index} with **bold text**, $x_${index % 10}^2$, and [[Note ${index}]].

| Word | Meaning |
| --- | --- |
| word-${index} | meaning-${index} |
`).join('\n')

  await prepareMath(body)
  const md = createMarkdown({ resolveEmbedSrc: (source) => source })
  const html = md.render(body, { equations: equationIndex(body) })
  if (!html.includes('katex') || html.length < body.length) {
    throw new Error('benchmark workload was not fully rendered')
  }

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,%3C!doctype%20html%3E%3Cmeta%20charset%3Dutf-8%3E')
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const html = ${JSON.stringify(html)}
      const holder = document.createElement('div')
      document.body.append(holder)
      const parses = []
      for (let index = 0; index < 6; index++) {
        const started = performance.now()
        holder.innerHTML = html
        void holder.offsetHeight
        parses.push(performance.now() - started)
        holder.replaceChildren()
      }
      const cached = document.createElement('div')
      cached.innerHTML = html
      holder.append(cached)
      const started = performance.now()
      cached.remove()
      holder.append(cached)
      void holder.offsetHeight
      return {
        htmlBytes: html.length,
        parseAndLayoutMs: parses,
        retainedReattachMs: performance.now() - started,
        correct: holder.contains(cached) && cached.childElementCount > 0
      }
    })()
  `)
  if (!result.correct) throw new Error('retained DOM did not survive reattachment')
  console.log(JSON.stringify(result, null, 2))
  app.exit(0)
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
