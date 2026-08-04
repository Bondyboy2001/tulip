import electron from 'electron'

const { app, BrowserWindow } = electron
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
  await win.loadURL('about:blank')
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
