'use strict'

/* The print stylesheet is the export's contract: it is what makes the printed
   page the note and only the note. These assertions are the facts the export
   was verified against — chrome hidden, article un-clipped, paper palette,
   pagination rules — so that a later restyle cannot quietly unmake them. */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

let failures = 0
function check (label, ok) {
  if (ok) { console.log(`ok - ${label}`); return }
  failures++
  console.error(`not ok - ${label}`)
}

const styles = read('src/styles.css')
const printBlock = styles.slice(styles.indexOf('@media print'))
check('a @media print section exists', printBlock.length > 0)

for (const sel of ['.titlebar', '#sidebar', '.doc-head', 'footer.status', '#sidepane', '#ai']) {
  check(`${sel} is hidden in print`, printBlock.includes(sel))
}
check('the export curtain is hidden from its own print', printBlock.includes('.export-curtain'))
check('overlays are hidden in print', printBlock.includes('#overlay'))

/* Floating chrome lives on `document.body`, not inside the app shell, so
   hiding the shell leaves it on the page — a docked audio player used to print
   on top of the note. Each selector is checked twice: that the print block
   names it, and that it is a class the source really assigns. The rule this
   replaced named `.dd-root`, which nothing creates, so it hid nothing while
   reading exactly as though it did. Only the second check catches that. */
const bodyChrome = [
  ['.dd-menu', 'src/dropdown.js'],
  ['.media-dock', 'src/renderer.js'],
  ['.code-ai-popover', 'src/renderer.js']
]
for (const [sel, source] of bodyChrome) {
  check(`${sel} is hidden in print`, printBlock.includes(sel))
  check(`${sel} is a class the app really assigns`, read(source).includes(`'${sel.slice(1)}`))
}

const readingRule = printBlock.match(/\.reading\s*{[^}]*}/s)
check('the reading rule exists in print', !!readingRule)
check('the article un-scrolls for pagination', !!readingRule && /overflow:\s*visible/.test(readingRule[0]))
const shellRule = printBlock.match(/html, body\s*{[^}]*}/s)
check('the app shell releases its clip for print',
  !!shellRule && /overflow:\s*visible/.test(shellRule[0]) && /height:\s*auto/.test(shellRule[0]))
check('page size and margins are declared', /@page\s*{[^}]*size:\s*Letter/.test(printBlock))
check('the paper palette overrides the theme', printBlock.includes('--paper:     #FBFAF8'))
check('headings keep with what follows them', /break-after:\s*avoid/.test(printBlock))
check('figures and code are not cut in half', /break-inside:\s*avoid/.test(printBlock))

const curtainRule = styles.match(/\.export-curtain\s*{[^}]*}/s)
check('the curtain is opaque (palette churn is masked)', !!curtainRule && /background:\s*var\(--paper\)/.test(curtainRule[0]))
check('the curtain has a z rung', styles.includes('--z-curtain:'))

const renderer = read('src/renderer.js')
check("the 'export-pdf' command is registered", renderer.includes("case 'export-pdf'"))
check('the command palette offers it', renderer.includes("id: 'export-pdf'"))
check('a dirty note is saved before printing', /exportPdf[\s\S]*state\.dirty\) await saveNow/.test(renderer.replace(/\n/g, ' ')))

const preload = read('electron/preload.js')
check('the bridge exposes exportPdf', preload.includes('exportPdf'))

const main = read('electron/main.js')
check("main answers 'pdf:export'", main.includes("ipcMain.handle('pdf:export'"))
check('the File menu offers Export as PDF', main.includes("'Export as PDF…'"))
check('the print keeps backgrounds (callouts, marks)', main.includes('printBackground: true'))

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('export print contract intact')
