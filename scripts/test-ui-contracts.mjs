import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { normalizeSavedSearches } from '../src/saved-searches.js'

const repo = process.cwd()
const target = path.resolve(process.argv[2] || repo)
const source = fs.existsSync(path.join(target, 'src', 'renderer.js'))

const read = (...parts) => fs.readFileSync(path.join(target, ...parts), 'utf8')
const renderer = read(source ? 'src' : 'dist', 'renderer.js')
const panelState = source ? read('src', 'panel-state.js') : renderer
const copilot = source ? read('src', 'copilot.js') : renderer
const settings = source ? read('src', 'settings.js') : renderer
const ask = source ? read('src', 'ask.js') : renderer
const styles = read(source ? 'src' : 'dist', source ? 'styles-features.css' : 'renderer.css')
const html = read(source ? 'src' : 'dist', 'index.html')
const main = read('electron', 'main.js')
const ai = read('electron', 'ai.js')
const preload = read('electron', 'preload.js')

for (const id of ['saved-searches', 'panel-save-search', 'ai-write']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `${id} is part of the installed shell`)
}
for (const id of ['tex-divider', 'tex-preview', 'tex-pdf']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `${id} is part of the installed shell`)
}
/* Every viewed kind needs a pane of its own in the shell, and one that is
   shipped rather than merely written: a pane missing from the built HTML is a
   tab that opens onto the last document. */
for (const id of ['data', 'notebook', 'fileview']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `${id} is part of the installed shell`)
}
assert.doesNotMatch(html, /tex-preview-head|tex-preview-status|>PDF preview</)
assert.match(renderer, /Search notes, PDFs, and highlights/)
assert.match(renderer, /Saved searches|saved-searches/)
assert.match(panelState, /aria-hidden/)
assert.match(main, /searchPdfDocuments/)
assert.match(main, /ai:doctor/)
assert.match(preload, /doctor:\s*\(\)/)
assert.match(preload, /tex:compile/)
assert.match(main, /createTexCompiler/)
assert.match(source ? read('src', 'styles.css') : styles, /\.tex-preview/)
/* KaTeX's stylesheet is emitted beside index.html, so it is resolved against
   the document. `import.meta.url` is wherever esbuild's splitting last put
   math.js — and when that was a shared chunk, the link asked for
   `chunks/katex.css`, 404ed, and every expression in the app rendered as its
   own source with nothing thrown. */
if (source) {
  const math = read('src', 'math.js')
  assert.match(math, /new URL\('katex\.css', document\.baseURI\)/)
  assert.doesNotMatch(math, /new URL\('katex\.css', import\.meta\.url\)/)
}
assert.match(styles, /width:\s*min\(320px/)

if (source) {
  const whiteboard = read('src', 'whiteboard.js')
  const build = read('build.mjs')
  assert.doesNotMatch(renderer, /import \{ mountSettings \} from ['"]\.\/settings\.js['"]/)
  assert.match(renderer, /import\(['"]\.\/settings\.js['"]\)/)
  assert.match(copilot, /effortRange\.addEventListener\('change'/)
  assert.match(renderer, /code-ai-hint[^\n]*⌘ Enter to send/)
  assert.match(renderer, /host: el\.texPdf,\s*selectionMenu: false/)
  assert.match(renderer, /id: 'new-file', title: 'New file…'/)
  for (const id of ['fold-all-headings', 'unfold-all-headings', 'lint-file', 'export-pdf']) {
    assert.match(renderer, new RegExp(`id: '${id}', title: [^\\n]+scope: 'markdown'`), `${id} is limited to Markdown files`)
  }
  assert.match(renderer, /id: 'note-history', title: [^\n]+scope: 'text'/)
  assert.match(renderer, /COMMANDS\.filter\(\(\{ scope \}\)/)
  /* A command that cannot act on what is open is not offered: the study record
     belongs to the language tables, and there is no file to move with nothing
     open. Both are scopes rather than checks inside the handler, so the row
     itself disappears. */
  assert.match(renderer, /id: 'review-stats', title: [^\n]+scope: 'language'/)
  assert.match(renderer, /id: 'move-file', title: [^\n]+scope: 'file'/)
  assert.match(renderer, /id: 'toggle-spellcheck', title: [^\n]+scope: 'markdown'/)
  /* The overlay's selection: the ends are ends, and a row arriving under a
     still mouse is not a hover. Both regressions are one line each to
     reintroduce and neither is visible in a screenshot. */
  assert.match(renderer, /Math\.max\(0, Math\.min\(count - 1, state\.overlay\.index \+ by\)\)/)
  assert.doesNotMatch(renderer, /state\.overlay\.index [+-] 1( \+ count)?\) % count/)
  assert.match(renderer, /mouseenter[\s\S]{0,60}if \(overlayHoverMuted\) return/)
  assert.match(renderer, /el\.panelList\.addEventListener\('mousemove'/)
  assert.ok(
    html.indexOf('id="zoom"') > html.indexOf('class="doc-tools"') &&
    html.indexOf('id="zoom"') < html.indexOf('<!-- A PDF'),
    'the zoom badge lives in the document header'
  )
  assert.doesNotMatch(html, /class="status-end"/)
  const newFileCommands = /const NEW_FILE_COMMANDS = \[([\s\S]*?)\n\]/.exec(renderer)?.[1] || ''
  for (const id of ['new-note', 'new-tex', 'new-whiteboard', 'new-website', 'new-table',
    'new-notebook']) {
    assert.match(renderer, new RegExp(`id: '${id}', title:`), `${id} is offered by the nested new-file palette`)
  }
  assert.doesNotMatch(newFileCommands, /id: 'new-folder'/)
  assert.doesNotMatch(newFileCommands, /id: 'new-language'/)
  assert.match(newFileCommands, /id: 'new-tex'[^\n]*kind: 'tex'/)
  assert.match(renderer, /mode === 'new-files'[\s\S]{0,320}noteRef\(item\.path\)\.kind/)
  assert.match(renderer, /isSitePath\(relPath\) \|\| isWhiteboardPath\(relPath\)/)
  assert.doesNotMatch(renderer, /infoRow\('Reading time'/)
  assert.match(renderer, /infoRow\('Folder',[\s\S]{0,180}\(\) => copyPaths\(\[folder\]\)/)
  assert.match(renderer, /api\.fileTags\.get\(path\)/)
  assert.match(renderer, /api\.fileTags\.set\(path, next\)/)
  assert.match(preload, /get: \(p\) => ipcRenderer\.invoke\('file-tags:get', p\)/)
  assert.match(main, /ipcMain\.handle\('file-tags:set'/)
  assert.match(renderer, /if \(viewingWhiteboard\(\)\) \{[\s\S]{0,180}whiteboardInstance\?\.open\(relPath/)
  assert.doesNotMatch(ai, /turn-end', processed:/)
  assert.doesNotMatch(copilot, /tokens processed this turn/)
  /* The copilots Tulip no longer runs. Their threads cannot be resumed and
     their context readings are about conversations nothing here can reopen, so
     a restored chat of theirs must come back with its gauge cleared. */
  assert.match(copilot, /const gone = new Set\(\['codex', 'claude', 'devin'\]\)/)
  assert.match(copilot, /const stale = gone\.has\(convo\.threadOf\)/)
  /* Through `docIcon`, not `fileIcon` directly: the tint a source file's row
     is drawn with comes from its path, and a call site that skipped the helper
     would show every language in the same grey. */
  assert.match(renderer, /li\.append\(docIcon\(fileKind, item\.path\)\)/)
  assert.match(renderer, /row\.append\(docIcon\(node\.kind, node\.path\)\)/)
  assert.match(preload, /create: \(dir\) => ipcRenderer\.invoke\('tex:create', dir\)/)
  assert.match(main, /ipcMain\.handle\('tex:create'/)
  assert.match(main, /EMPTY_TEX_DOCUMENT/)
  assert.match(renderer, /case 'new-file': openOverlay\('new-files', \{ dir \}\)/)
  /* Creating a source or data file is the difference between the vault opening
     these and merely tolerating them. Both routes in are asserted: the picker
     that chooses a language, and the import filter that lets one be dragged. */
  assert.match(renderer, /case 'new-source': openOverlay\('new-source', \{ dir \}\)/)
  assert.match(renderer, /case 'new-csv': createSource\(dir, '\.csv'\)/)
  assert.match(renderer, /case 'new-notebook': createSource\(dir, '\.ipynb'\)/)
  /* A table and a notebook are each read and edited in one pane, so the view
     switch is on the bar while either is open and the viewer is told which of
     the two it is in. Without the second and third lines the control would
     move and the document would not. */
  assert.match(renderer,
    /el\.viewSwitch\.hidden = \(!text && !dataOpen && !notebookOpen\) \|\| sourceOnly/)
  assert.match(renderer, /if \(dataOpen\) dataInstance\?\.setReadonly\(state\.view === 'read'\)/)
  assert.match(renderer, /if \(notebookOpen\) notebookInstance\?\.setReadonly\(state\.view === 'read'\)/)
  /* Auto-resize is offered for both grids and routed to whichever is open —
     the palette row and the thing it calls, which are easy to add one of. */
  assert.match(renderer,
    /if \(viewingLanguageTable\(\) \|\| viewingData\(\)\) \{\s*commands\.push\(\{ id: 'fit-columns'/)
  assert.match(renderer, /viewingData\(\) \? dataInstance\?\.fitColumns\(\) : editor\?\.fitAllColumns\(\)/)
  assert.match(preload, /create: \(dir, name, ext\) => ipcRenderer\.invoke\('source:create', dir, name, ext\)/)
  assert.match(main, /ipcMain\.handle\('source:create'/)
  assert.match(main, /!isCode\(source\) && !isData\(source\)\) \{ skipped\+\+; return \}/)
  assert.match(renderer, /mode === 'new-files'\) \{ runCommand\(item\.id, dir\)/)
  assert.doesNotMatch(renderer, /title = 'Press ⌘Enter to send'/)
  assert.match(renderer, /codeAiPop\.isConnected && codeAiSession\?\.anchor === anchor/)
  assert.doesNotMatch(renderer, /document\.addEventListener\('pointerdown',[\s\S]{0,180}codeAiPop/)
  assert.doesNotMatch(renderer, /codeAiPop\.addEventListener\('keydown',[\s\S]{0,160}Escape/)
  assert.match(copilot, /element\('button', 'ghost is-compact', 'Reject'\)/)
  assert.match(copilot, /const name = entry\.name \|\| noteName\(entry\.path\)/)
  assert.match(copilot, /run: \(\) => selectMention\(from, entry\.path\)/)
  assert.match(copilot, /box\.value = box\.value\.slice\(0, from\) \+ box\.value\.slice\(to\)/)
  assert.match(copilot, /addAttachments\(\[path\], true\)/)
  assert.match(copilot, /function attachmentKind \(path\)/)
  assert.match(copilot, /preview\.append\(fileIcon\(kind\)\)/)
  assert.match(copilot, /element\('button', 'icon-btn ai-attachment-remove'\)/)
  assert.match(read('src', 'file-icons.js'), /export function fileIcon \(kind, \{ color = null \} = \{\}\)/)
  assert.doesNotMatch(copilot, /isPdfPath\(entry\.path\) \|\| isSitePath\(entry\.path\)/)
  assert.doesNotMatch(copilot, /element\('button', 'ghost is-compact is-accent', 'Restore'\)/)
  assert.doesNotMatch(copilot, /'Undo turn'/)
  assert.doesNotMatch(settings, /of \$\{all\.length\} offered/)
  assert.match(settings, /const open = opened\.has\(group\.name\)[\s\S]*?: !!query/)
  assert.doesNotMatch(read('src', 'styles.css'), /\.model-picker-count\s*\{/)
  const baseStyles = read('src', 'styles.css')
  const texSplit = read('src', 'tex-split.js')
  assert.match(baseStyles, /body\s*\{\s*cursor:\s*default/)
  /* A selected rectangle is filled cell by cell. The browser's own text
     highlight over the same cells hugs the letters instead, and two selections
     drawn at once read as a ragged mess — so the grid's is the one that
     paints. Hidden rather than switched off: `user-select: none` would take
     the menu's Edit ▸ Copy with it. */
  assert.match(baseStyles, /\.csv-frame ::selection \{ background: transparent; \}/)
  assert.doesNotMatch(baseStyles, /\.csv-(row|cell)[^\n]*user-select: none/)
  assert.match(baseStyles, /a\[href\][\s\S]{0,220}\[role="button"\][\s\S]{0,220}cursor:\s*default\s*!important/)
  assert.match(baseStyles, /\.reading, \.reading \*[\s\S]{0,190}cursor:\s*default\s*!important/)
  assert.match(baseStyles, /\.grip\s*\{[\s\S]{0,190}cursor:\s*col-resize/)
  assert.match(baseStyles, /\.tex-divider\s*\{[\s\S]{0,220}cursor:\s*col-resize/)
  assert.match(baseStyles, /\.tex-pdf\s*\{[\s\S]{0,100}cursor:\s*text/)
  assert.match(baseStyles, /\.file-tags-editor \.tag-input\s*\{[\s\S]{0,80}flex:\s*none/)
  assert.match(baseStyles, /\.file-tags-editor\s*\{[\s\S]{0,100}padding:\s*2px 8px 4px/)
  assert.match(baseStyles, /\.pane-tabs\s*\{[\s\S]{0,300}overflow-x:\s*auto/)
  assert.match(baseStyles, /\.pane-tab\s*\{[\s\S]{0,100}flex:\s*none/)
  assert.match(baseStyles, /\.ai\s*\{[\s\S]{0,360}overflow:\s*visible;/)
  assert.match(baseStyles, /\.app\[data-ai="closed"\] \.ai\s*\{\s*overflow:\s*hidden;/)
  assert.match(baseStyles, /\.ai-pop\s*\{[\s\S]{0,500}max-height:\s*min\(/)
  assert.match(baseStyles, /\.ai-effort-range::-webkit-slider-thumb\s*\{[\s\S]{0,260}border:\s*2px solid var\(--surface\)/)
  assert.match(renderer, /spec\.tab\(\)\.scrollIntoView\(\{ inline: 'nearest', block: 'nearest' \}\)/)
  assert.match(baseStyles, /--tex-source/)
  assert.match(texSplit, /setPointerCapture/)
  assert.match(texSplit, /ArrowLeft[\s\S]*ArrowRight/)
  assert.match(texSplit, /dblclick[\s\S]*DEFAULT_RATIO/)
  assert.match(texSplit, /texSourceRatio/)
  assert.match(baseStyles, /\.app\[data-resizing\] \*\s*\{\s*cursor:\s*col-resize\s*!important/)
  assert.match(baseStyles, /button:disabled[\s\S]{0,140}cursor:\s*default\s*!important/)
  assert.match(baseStyles, /\.ToolIcon:not\(:disabled\)/)
  assert.match(baseStyles, /\.reading \.code-nums\s*\{[\s\S]{0,100}padding:\s*18px 18px 20px 20px/)
  assert.match(baseStyles, /pre\.code-text\s*\{[\s\S]{0,100}padding:\s*18px 20px 20px 4px/)
  assert.match(html, /<aside class="sidebar"[^>]*>[\s\S]{0,180}id="app-version"/)
  assert.match(html, /<div class="titlebar"><\/div>/)
  assert.match(ask, /el\.askGo\.focus\(\)/)
  assert.match(renderer, /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); answer\(true\) \}/)
  assert.doesNotMatch(renderer, /e\.key === 'Enter' && document\.activeElement === el\.askGo/)
  assert.match(renderer, /if \(!wrapsCode\)[\s\S]{0,150}pre\.scrollLeft = 0/)
  assert.match(whiteboard, /whiteboardElementsText\(latest\.elements\)/)
  assert.match(whiteboard, /revision === writingRevision/)
  assert.match(whiteboard, /saveScene\(\{ flush: true \}\)/)
  assert.match(whiteboard, /aiEnabled: false/)
  assert.match(preload, /write: \(p, content, metadata\)/)
  assert.match(main, /lastSearch\.whiteboardKeys/)
  assert.match(main, /whiteboardKeys\n\s*\}/)
  assert.match(build, /name: 'lean-excalidraw'/)
  assert.match(build, /const pdfOcrCache = path\.join\(os\.homedir\(\), 'Library', 'Caches', 'Tulip', 'native'\)/)
  assert.doesNotMatch(build, /path\.join\('node_modules', '\.cache', 'tulip-native'\)/)
  const watchStart = build.indexOf('if (watch) {')
  const watchBuild = build.slice(watchStart, build.indexOf('} else {', watchStart))
  assert.ok(
    watchBuild.indexOf('await ctx.watch()') < watchBuild.indexOf('await buildPdfOcr()'),
    'source watchers must start before PDF OCR compilation'
  )
  assert.deepEqual(
    normalizeSavedSearches([{ query: 'type:pdf climate' }, { query: 'TYPE:PDF CLIMATE' }, 'tag:book'])
      .map(({ name, query }) => ({ name, query })),
    [
      { name: 'type:pdf climate', query: 'type:pdf climate' },
      { name: 'tag:book', query: 'tag:book' }
    ]
  )
}

console.log(`ui contracts: ${source ? 'source' : target}`)
