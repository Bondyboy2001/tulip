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
const copilotContext = source ? read('src', 'copilot-context.js') : renderer
const settings = source ? read('src', 'settings.js') : renderer
const ask = source ? read('src', 'ask.js') : renderer
const runcode = source ? read('src', 'runcode.js') : renderer
const manim = source ? read('src', 'manim.js') : renderer
const infoPane = source ? read('src', 'info-pane.js') : renderer
const overlayCatalog = source ? read('src', 'overlay-catalog.js') : renderer
const editor = source ? read('src', 'editor.js') : renderer
const styles = read(source ? 'src' : 'dist', source ? 'styles-features.css' : 'renderer.css')
const flashcardStyles = read(source ? 'src' : 'dist', source ? 'styles.css' : 'renderer.css')
const html = read(source ? 'src' : 'dist', 'index.html')
const main = read('electron', 'main.js')
const ai = read('electron', 'ai.js')
const preload = read('electron', 'preload.js')
const buildApp = source ? read('scripts', 'build-app.sh') : ''

assert.match(main, /app\.on\('open-file'/,
  'Finder document opens are accepted by the main process')
assert.match(main, /await openVault\(path\.dirname\(real\)\)[\s\S]{0,120}createWindow\(\{ open:/,
  'a Finder document opens through Tulip vault and window boundaries')
if (source) {
  assert.match(renderer, /const session = role\.open[\s\S]{0,120}\? \{ tabs: \[role\.open\], tabIndex: 0 \}/,
    'a Finder document takes precedence over primary-window session restore')
  assert.match(buildApp, /public\.comma-separated-values-text/,
    'the macOS bundle declares CSV documents')
  assert.match(buildApp, /<string>public\.pdf<\/string>/,
    'the macOS bundle declares PDF documents')
}

assert.match(main,
  /const INLINE_ATTACHMENT_EXT = new Set\(\[\s*\.\.\.MD_EXT, TEX_EXT, SITE_EXT, \.\.\.CODE_EXT, \.\.\.DATA_EXT\s*\]\)/,
  'small text attachments follow the shared vault extension contract')
if (source) {
  assert.match(renderer, /const sourceFile = code \|\| viewingTex\(\)/,
    'TeX and source files share the bounded source-context path')
  assert.match(copilotContext, /if \(flashcards\) return 'flashcards'/,
    'flashcard banks report their own Copilot context kind')
  assert.match(copilot, /used: convo\.used \|\| 0/,
    'context budgeting accounts for the conversation already in the model window')
} else {
  assert.match(renderer, /sourceContext/, 'the installed renderer carries source-file context')
  assert.match(renderer, /contextBudget/, 'the installed renderer carries the shared turn budget')
}
assert.match(main, /inlineAttachments\(context, Number\(budget\.attachments\) \|\| undefined\)/,
  'small attachment inlining follows the shared per-turn context budget')
assert.match(main, /maxChars: Number\(budget\.pdf\) \|\| undefined/,
  'ranked PDF context follows the shared per-turn context budget')
assert.match(main, /delete context\.contextBudget/,
  'the internal budget is removed before context reaches the model prompt')
assert.match(main, /await stageZoom\(win, clamped \/ current\)[\s\S]{0,200}setZoomFactor\(clamped\)[\s\S]{0,100}sendTo\(win, 'zoom:unstage'\)[\s\S]{0,100}scheduleWindowRepaint\(win\)/,
  'window zoom swaps from a painted destination-scale frame before its settle repaint')
assert.match(preload, /ipcRenderer\.on\('zoom:stage'[\s\S]{0,1800}requestAnimationFrame\(\(\) => globalThis\.requestAnimationFrame\([\s\S]{0,300}ipcRenderer\.send\('zoom:staged', id\)/,
  'the zoom staging frame is laid out and painted before main changes the native scale')

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
assert.match(html, /id="reading"[^>]*role="document"[^>]*aria-label="Reading view"[^>]*tabindex="0"/)

/* The shell is one hand-written document, and an unbalanced tag in it does not
   fail anything: the parser closes what it must and carries on. A stray
   </div> once closed <main> early, which closed .app early, which left the
   copilot and the side pane as children of <body> — outside the grid that
   gives them their column, so opening the copilot showed an empty window with
   the panel laid out below the fold. Nothing threw and nothing looked wrong
   until the panel was opened. Count the tags instead. */
const tagBalance = (doc) => {
  /* Comments and <svg> subtrees are blanked rather than parsed: both are full
     of things that are not shell structure, and SVG is XML, where <path/> and
     <path></path> are both fine and neither is an HTML void element. */
  const body = doc
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
                        'input', 'link', 'meta', 'source', 'track', 'wbr'])
  const open = []
  for (const [, slash, name, attrs] of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    if (VOID.has(name.toLowerCase()) || attrs.trimEnd().endsWith('/')) continue
    if (!slash) { open.push(name); continue }
    const top = open.pop()
    if (top !== name) return `</${name}> closes <${top || 'nothing'}>`
  }
  return open.length ? `<${open.join('>, <')}> left open` : ''
}
assert.equal(tagBalance(html), '', 'every tag in the shell is closed by its own')
assert.doesNotMatch(html, /tex-preview-head|tex-preview-status|>PDF preview</)
assert.match(overlayCatalog, /Search notes, PDFs, and highlights/)
assert.match(renderer, /Saved searches|saved-searches/)
assert.match(panelState, /aria-hidden/)
assert.match(main, /searchPdfDocuments/)
assert.match(main, /ai:doctor/)
assert.match(preload, /doctor:\s*\(\)/)
assert.match(preload, /tex:compile/)
/* The compiler is made in electron/ipc-render.js, beside the other renderers. */
assert.match(read('electron', 'ipc-render.js'), /createTexCompiler/)
assert.match(source ? read('src', 'styles.css') : styles, /\.tex-preview/)
/* The file tree's own tints ride in the render-blocking core sheet. They once
   sat at the tail of the language keyboard's section, which the build slices
   out into `language.css` (see FEATURE_STYLE_SECTIONS), so a shift-click
   selected the right rows and painted none of them until a language table had
   been opened in that session. */
if (!source) {
  assert.match(styles, /\.row\.is-picked\s*\{/, 'the multi-select tint is in the core sheet')
  assert.match(styles, /\.row\.is-drop-target\s*\{/, 'the drop-target tint is in the core sheet')
}
/* KaTeX's stylesheet is emitted beside index.html, so it is resolved against
   the document. `import.meta.url` is wherever esbuild's splitting last put
   math.js — and when that was a shared chunk, the link asked for
   `chunks/katex.css`, 404ed, and every expression in the app rendered as its
   own source with nothing thrown. */
if (source) {
  const math = read('src', 'math.js')
  assert.match(math, /new URL\('katex\.css', document\.baseURI\)/)
  assert.doesNotMatch(math, /new URL\('katex\.css', import\.meta\.url\)/)
  /* The primary editing and overlay textboxes have explicit names; a
     placeholder is a visual hint, not an accessible label. */
  assert.match(editor, /EditorView\.contentAttributes\.of\(\{ 'aria-label': 'Document editor' \}\)/)
  assert.match(renderer, /panelInput\.setAttribute\('aria-label', OVERLAY_LABEL\[mode\]/)
  /* View state is readable without decoding three neighbouring glyphs. */
  for (const label of ['Read', 'Edit', 'Raw']) {
    assert.match(html, new RegExp(`class="view-option-label">${label}<`))
  }
  /* Search rows carry both useful local context and the folder breadcrumb
     that distinguishes identically named results. */
  assert.match(renderer, /contextualLine|className = 'search-path'/)
  /* The lower pane is sized from its separator and restores a separate height
     for each kind, without another button competing with its tabs. */
  assert.doesNotMatch(html, /id="pane-size-toggle"/)
  assert.match(renderer, /function fitPaneBelow \(\)/)
  assert.match(renderer, /paneBelowHeights/)
  /* The resting palette is grouped and consumes each command only once. */
  assert.match(renderer, /function paletteCommands \(\)/)
  assert.doesNotMatch(renderer, /Suggested for this file/)
  assert.match(renderer, /if \(contextCommand\(command\)\) take\(command\)/)
  assert.match(renderer, /for \(const group of \['File', 'Appearance', 'Tools', 'App & Help'\]\)/)
  assert.match(renderer, /className = 'panel-group'/)
  assert.match(renderer, /rememberPaletteCommand\(item\.id\)/)
  /* Zooming can push a desktop window through the drawer breakpoint while
     macOS's native traffic lights remain fixed. The narrow titlebar must keep
     the same left-side clearance instead of placing navigation beneath them. */
  assert.match(flashcardStyles, /@media \(max-width: 760px\)[\s\S]{0,1200}\.doc-head \{ padding-left: 92px; \}/)
  assert.doesNotMatch(flashcardStyles, /@media \(max-width: 760px\)[\s\S]{0,1200}\.doc-head \{ padding-left: 18px; \}/)
  /* Zooming through the side-document drawer breakpoint must leave Copilot in
     the grid. Its column then narrows the document instead of covering it. */
  const narrowRightPanelCss = flashcardStyles.slice(
    flashcardStyles.indexOf('@media (max-width: 1040px)'),
    flashcardStyles.indexOf('@media (max-width: 760px)'))
  assert.match(narrowRightPanelCss, /\.app \{\s*--col-side: 0px;\s*\}/)
  assert.match(narrowRightPanelCss, /\.sidepane \{[\s\S]{0,180}position: fixed;/)
  assert.doesNotMatch(narrowRightPanelCss, /--col-chat|\.sidepane,\s*\.ai|\[data-ai="open"\] \.ai/)
  assert.doesNotMatch(flashcardStyles, /body:has\(\.app\[data-(?:ai|side)="open"\]\) \.drawer-scrim/)
  assert.match(renderer, /function closeNarrowDrawer \(\)[\s\S]{0,360}dataset\.side === 'open'/)
  assert.doesNotMatch(renderer, /function closeNarrowDrawer \(\)[\s\S]{0,500}dataset\.ai/)
  assert.match(renderer, /drawerScrim\.addEventListener\('click', \(\) => \{[\s\S]{0,180}dataset\.sidebar === 'open'/)
  assert.match(flashcardStyles, /@media \(max-width: 820px\)[\s\S]{0,160}\.view-option \{ width: 28px; padding: 0; justify-content: center; \}/)
  /* Empty space in the tab row drags the window; real tabs remain interactive
     and retain their own tab-reordering drag. */
  assert.match(flashcardStyles, /\.tabs \{[\s\S]{0,420}-webkit-app-region: drag;/)
  assert.match(flashcardStyles, /\.tab \{[\s\S]{0,520}-webkit-app-region: no-drag;/)
  /* The default model picker is the deliberate shortlist; the complete
     catalogue remains one named browse surface. */
  assert.match(settings, /asOptions\(offeredModels\(modelCatalogue, values\(\)\.aiModels, chosen\)\)/)
  assert.match(settings, /name: 'Browse all models'/)
  assert.match(settings, /Run Copilot Doctor below to check/)
  /* The guide is discoverable without becoming a forced first-run tour.
     The empty state and the palette open the portable note directly; there is
     no checklist section in Settings. Backups run from the palette and the
     menu and still record their timestamp. */
  assert.match(html, /data-command="getting-started">Open Getting Started</)
  assert.doesNotMatch(html, /data-command="setup"/)
  assert.match(renderer, /id: 'getting-started', title: 'Open Getting Started'/)
  assert.doesNotMatch(renderer, /id: 'setup', title:/)
  assert.doesNotMatch(renderer, /settings\.open\('start'\)/)
  assert.doesNotMatch(settings, /id: 'start'/)
  assert.doesNotMatch(settings, /id: 'files'/)
  assert.match(renderer, /setSetting\('lastBackupAt', Date\.now\(\)\)/)
  /* An empty bank has one creation action and cannot start a zero-card study. */
  assert.match(renderer, /const studyable = viewingLanguageTable\(\) \|\| bankCards\.length > 0/)
  assert.match(renderer, /flashcardBankAdd\.hidden =[^\n]+!bankCards\.length/)
  assert.match(renderer, /flashcardBankTopics\.hidden = emptyBank/)
}

/* The window's own bundle is served over `tulip-app` for one reason: it is the
   only way Chromium will keep a V8 code cache for it, and `codeCache` is
   ignored unless `standard` is set beside it. Both are asserted because losing
   either has NO visible symptom — the app opens, everything works, and every
   launch quietly recompiles 570KB from source again. Measured with
   bench/boot-bench.mjs; the numbers are in the comment beside the handler. */
assert.match(main, /scheme:\s*'tulip-app'/)
assert.match(main, /codeCache:\s*true/)
assert.match(main, /standard:\s*true/)
assert.match(main, /loadURL\(`\$\{APP_ORIGIN\}\/index\.html`\)/)

if (source) {
  const whiteboard = read('src', 'whiteboard.js')
  const build = read('build.mjs')
  const csv = read('src', 'csv.js')
  assert.match(renderer, /el\.reading\.setAttribute\('aria-labelledby', title\.id\)/)
  assert.match(csv, /\[scrollBack, 'Scroll to earlier columns'\]/)
  assert.match(csv, /\[scrollForward, 'Scroll to later columns'\]/)
  assert.match(csv, /const paintColumnScroll = \(\) =>/)
  assert.match(renderer, /loadFeatureStyles\('copilot'\)/)
  assert.match(renderer, /loadFeatureStyles\('settings'\)/)
  assert.match(renderer, /loadFeatureStyles\('notebook'\)/)
  assert.match(renderer, /loadFeatureStyles\('csv'\)/)
  assert.match(build, /splitFeatureStyles/)
  assert.doesNotMatch(renderer, /import \{ mountSettings \} from ['"]\.\/settings\.js['"]/)
  assert.match(renderer, /import\(['"]\.\/settings\.js['"]\)/)
  /* The thinking level has no control of its own any more — ⌃T is the whole
     of it, so the chord and the readout it flashes are the contract. */
  assert.match(copilot, /event\.code !== 'KeyT'/)
  assert.match(copilot, /cycleEffort\(event\.shiftKey \? -1 : 1\)/)
  assert.doesNotMatch(copilot, /effortRange|effortStops/)
  assert.match(renderer, /code-ai-hint[^\n]*⌘ Enter to send/)
  assert.match(renderer, /codeAiInput\.rows = 3/)
  assert.match(flashcardStyles, /\.code-ai-input \{[^}]*min-height: 76px/s)
  assert.match(renderer, /host: el\.texPdf,\s*selectionMenu: false/)
  assert.match(renderer, /id: 'new-file', title: 'New file…'/)
  /* A tree click beside a real document opens a tab, but the empty tab already
     on screen is itself the place for the first file. Always passing true here
     stranded a permanent "New tab" at the left of the strip. */
  assert.match(renderer, /openNote\(path, \{ newTab: !!state\.tabs\[state\.tabIndex\]\?\.path \}\)/)
  for (const id of ['fold-all-headings', 'unfold-all-headings', 'lint-file', 'export-pdf', 'set-bookmark', 'go-to-bookmark']) {
    assert.match(renderer, new RegExp(`id: '${id}', title: [^\\n]+scope: 'markdown'`), `${id} is limited to Markdown files`)
  }
  assert.match(renderer, /id: 'note-history', title: [^\n]+scope: 'text'/)
  assert.match(renderer, /COMMANDS\.filter\(\(\{ scope \}\)/)
  /* A locked file is held in its reading view, and the hold is written in one
     place each: `setView` refuses to leave reading, and `applyPanes` puts a
     locked document back into it however it was opened. Both are one line to
     lose and neither shows up in a screenshot of an unlocked note.

     `readOnlyHere` is the same two doors serving a second reason to be in the
     reading view: a document another window is editing. Two buffers over a
     file Tulip cannot merge is what made conflict copies once a second — see
     the account beside the handlers in electron/main.js — and this is where
     the second window is stopped from having one. */
  assert.match(renderer, /if \(readOnlyHere\(\)\) \{[\s\S]{0,420}if \(view !== 'read'\)/)
  assert.match(renderer, /const show = readOnlyHere\(\) \? 'read' :/)
  assert.match(renderer, /const readOnlyHere = \(\) => lockedHere\(\) \|\| heldHere\(\)/)
  /* The claim is asked for wherever a document lands and given up wherever one
     is left. Both are one line, in the two functions every kind goes through. */
  assert.match(renderer, /function settleDoc \([\s\S]{0,400}claimDocument\(path\)/)
  assert.match(renderer, /async function leaveDoc \([\s\S]{0,600}releaseDocument\(state\.current\?\.path\)/)
  /* The four kinds with no merge, and only those: a note has one, and taking
     two windows away from a note would take away something that works. */
  assert.match(renderer,
    /const isUnmergeablePath = \(path\) => isDocxPath\(path\) \|\| isNotebookPath\(path\) \|\|\s*\n\s*isWhiteboardPath\(path\) \|\| isDataPath\(path\)/)
  /* Taking a document over is a palette row and nothing else — the answer to a
     situation rather than a thing to reach for — and it runs `takeDocument`. */
  assert.match(renderer, /id: 'edit-here', title: 'Edit here[^']*'/)
  assert.match(renderer, /case 'edit-here': takeDocument\(\)/)
  /* The palette offers whichever of the two the file is not, and both run the
     same command — a row that cannot act on what is open is not offered. */
  assert.match(renderer, /id: 'unlock-file'[\s\S]{0,80}id: 'lock-file'/)
  assert.match(renderer, /case 'lock-file':\s*\n\s*case 'unlock-file': toggleLock\(\)/)
  // Locking and unlocking are both asked about before they happen.
  assert.match(renderer, /await ask\(locking[\s\S]{0,400}go: 'Unlock'/)
  // The lock survives a rename, which is the one move nobody checks afterwards.
  assert.match(renderer, /state\.locked\]\.map\(moved\)/)
  // The `.csv` lattice is a fact about the shell — the grid is virtualized.
  assert.match(renderer, /dataset\.csvBorders = cfg\.csvBorders === true \? 'on' : 'off'/)
  assert.match(read('src', 'styles.css'), /\[data-csv-borders="on"\] \.csv-frame \.csv-cell/)
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
  assert.doesNotMatch(infoPane, /infoRow\('Reading time'/)
  assert.match(infoPane, /infoRow\('Folder',[\s\S]{0,180}deps\.copyPaths\(\[folder\]\)/)

  /* ---- where a tag lives ----

     A Markdown note keeps its tags in its own head. That is the whole promise
     of a vault of plain files: a tag set in Tulip has to be there when the
     vault is read by anything else, and filing it in `.tulip/file-tags.json`
     meant it was not. The sidecar stays for the kinds with no head to write —
     a PDF, a Word document, a whiteboard — and `hasOwnHead` is the one test
     that decides between them.

     Guarded here because the failure is silent in both directions: a note
     whose tags went back to the sidecar looks completely normal until the
     vault is opened somewhere else, and a PDF whose tags went to a "head" it
     does not have would simply lose them. */
  assert.match(infoPane, /hasOwnHead\(path\) \? headListSection\(path, TAG_PROP\) : fileTagSection\(path, tags\)/)
  assert.match(infoPane, /hasOwnHead = \(path\) =>[\s\S]{0,200}deps\.isNote\(path\)/)
  // The sidecar is not even asked about a file that keeps its own.
  assert.match(infoPane, /hasOwnHead\(path\) \? \[\] : deps\.api\.fileTags\.get\(path\)/)
  assert.match(infoPane, /deps\.api\.fileTags\.set\(path, next\)/)
  assert.match(preload, /get: \(p\) => ipcRenderer\.invoke\('file-tags:get', p\)/)
  assert.match(read('electron', 'ipc-metadata.js'), /ipcMain\.handle\('file-tags:set'/)

  /* The one-time move of what the sidecar was holding for notes, into the
     notes. It has to merge rather than replace — a note already declaring
     `tags:` keeps what it declared — and it must only clear the sidecar entry
     once the note has actually been written. */
  assert.match(main, /async function migrateNoteTags/)
  assert.match(main, /const union = \[\.\.\.new Set\(\[\.\.\.head, \.\.\.sidecar\]\)\]/)

  /* Tags are the only frontmatter control in Info. Generic properties and
     aliases remain in the file, available from Raw view, but add no controls
     to this compact pane. Tag edits still replace only the head. */
  assert.doesNotMatch(infoPane, /propertiesSection|ALIAS_PROP|OWN_EDITOR/)
  assert.match(infoPane, /changes: \{ from: 0, to: oldHead, insert: updated\.slice\(0, newHead\) \}/)
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
  /* The create handlers live in electron/ipc-create.js, beside the name rules
     they share; the seeded TeX document moved with them. */
  const createIpc = read('electron', 'ipc-create.js')
  assert.match(createIpc, /ipcMain\.handle\('tex:create'/)
  assert.match(createIpc, /EMPTY_TEX_DOCUMENT/)
  assert.match(renderer, /case 'new-file': openOverlay\('new-files', \{ dir \}\)/)
  /* The explorer names the plain file format explicitly, and source creation
     enters the existing language picker while preserving the clicked folder. */
  assert.match(renderer, /label: `New markdown file\$\{suffix\}`[^\n]+createNote\(dir\)/)
  assert.match(renderer,
    /label: `New source file\$\{suffix\}`[^\n]+openOverlay\('new-source', \{ dir \}\)/)
  /* Creating a source or data file is the difference between the vault opening
     these and merely tolerating them. Both routes in are asserted: the picker
     that chooses a language, and the import filter that lets one be dragged. */
  assert.match(renderer, /case 'new-source': openOverlay\('new-source', \{ dir \}\)/)
  assert.match(renderer, /case 'new-csv': createSource\(dir, '\.csv'\)/)
  assert.match(renderer, /case 'new-notebook': createSource\(dir, '\.ipynb'\)/)
  /* And a Word document, which the vault now writes as well as reads — one
     blank package, made in the create handlers because it is a zip rather
     than a string. */
  assert.match(renderer, /case 'new-docx': createSource\(dir, '\.docx'\)/)
  assert.match(read('electron', 'ipc-create.js'), /blankDocxBuffer/)
  /* A table, a notebook and a Word document are each read and edited in one
     pane, so the view switch is on the bar while any of them is open and the
     viewer is told which of the two views it is in. Without the lines that
     follow, the control would move and the document would not. */
  assert.match(renderer,
    /el\.viewSwitch\.hidden = flashcardOpen \|\| \(!text && !dataOpen && !notebookOpen && !docxOpen\) \|\| sourceOnly/)
  assert.match(renderer, /if \(dataOpen\) dataInstance\?\.setReadonly\(state\.view === 'read' \|\| readOnlyHere\(\)\)/)
  assert.match(renderer, /if \(notebookOpen\) notebookInstance\?\.setReadonly\(state\.view === 'read' \|\| readOnlyHere\(\)\)/)
  assert.match(renderer,
    /if \(docxOpen\) docxInstance\?\.setReadonly\(state\.view === 'read' \|\| readOnlyHere\(\)\)/)
  /* A whiteboard is one canvas in both views, so the reading view alone never
     made it read-only — and a board another window is editing has to be. */
  assert.match(renderer, /if \(whiteboardOpen\) whiteboardInstance\?\.setReadonly\(readOnlyHere\(\)\)/)
  /* A viewer holds the path it writes back to, and a rename or a move has to
     reach it. All three are asserted because all three were broken: the next
     autosave after a rename wrote to a file that no longer existed. The
     notebook's kernel is filed under the same path and moves with it. */
  for (const call of [
    /docxInstance\?\.retarget\(path\)/, /dataInstance\?\.retarget\(path\)/,
    /notebookInstance\?\.retarget\(path\)/, /docxInstance\?\.retarget\(followed\.to\)/,
    /dataInstance\?\.retarget\(followed\.to\)/, /notebookInstance\?\.retarget\(followed\.to\)/
  ]) assert.match(renderer, call)
  /* The kernel's handlers live beside the host, in electron/ipc-kernel.js. */
  assert.match(read('electron', 'ipc-kernel.js'), /ipcMain\.handle\('kernel:rename'/)
  /* ⌘Z arrives as a menu command, and `stepHistory` hands it to whichever
     history the reader is looking at. Without this branch it fell through to
     the editor, which holds nothing while a viewed kind is on screen — so a
     mistyped word in a Word document could not be taken back at all. */
  assert.match(renderer, /if \(viewingDocx\(\)\) \{\s*\n\s*const stepped = docxInstance\?\.history\(redo\)/)
  /* ---- the website's bar, and the page behind it ----

     Every control asserted against a handler, on the same argument the Word
     bar is asserted on below: a control with no listener is a button that does
     nothing and says nothing about it. */
  for (const id of ['site-mark', 'site-address', 'site-known', 'site-save', 'site-external']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is not in the website bar`)
  }
  assert.match(renderer, /el\.siteExternal\.addEventListener\('click'/)
  assert.match(renderer, /el\.siteAddress\.addEventListener\('focus'[\s\S]{0,120}paintKnownSites\(\)/)
  /* A website tab keeps its live page while the reader is elsewhere — the
     whole point of the guest pool in src/site.js. `leave` hides it; only a
     closed tab ends it, and the last tab holding a file is what says so. */
  assert.match(renderer, /else if \(viewingSite\(\)\) site\?\.leave\(\)/)
  assert.match(renderer, /!state\.tabs\.some\(\(other\) => other\.path === tab\.path\)[\s\S]{0,60}site\?\.forget\(tab\.path\)/)
  // ⌘F over a page is Chromium's own find, not a refusal.
  assert.match(renderer, /if \(viewingSite\(\)\) \{ ensureSite\(\)\.then\(\(\) => siteFind\?\.open\(\)\)/)
  assert.doesNotMatch(renderer, /Find does not reach inside a web page/)
  /* A file a page offers has somewhere to land, and the guests are where the
     reader's right-click is answered. Both are main's, and both were missing
     entirely — a download that goes nowhere and a menu that is not built are
     each invisible from the renderer. */
  assert.match(main, /session\.fromPartition\(partition\)\.on\('will-download'/)
  assert.match(main, /contents\.on\('context-menu'/)
  // A plain `target=_blank` link is not a sign-in popup and is not sized like one.
  assert.match(main, /const signIn = disposition === 'new-window'/)

  /* The bar a Word document is edited from, in the strip the PDF's toolbar and
     the website's address bar live in. Every button is asserted against a
     handler, because a control with no listener is a button that does nothing
     and says nothing about it. */
  assert.match(html, /<div class="docx-bar" id="docx-tools" hidden>/)
  for (const id of ['docx-body', 'docx-h1', 'docx-h2', 'docx-h3', 'docx-bold', 'docx-italic',
    'docx-underline', 'docx-strike', 'docx-bullets', 'docx-numbers', 'docx-table', 'docx-row',
    'docx-column', 'docx-delete-row', 'docx-delete-column', 'docx-open-word']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is not in the toolbar`)
  }
  /* Pressed with `mousedown`, prevented: a click moves the focus off the page
     and takes the selection these commands act on with it. And with `click`
     as well, because Enter and Space on a focused button arrive as a click
     with no mousedown before it — with mousedown alone the whole bar was
     reachable by Tab and did nothing. The listener pairs the two so a pointer
     press is not run twice. */
  assert.match(renderer, /function docxToolListener \(run\) \{[\s\S]*?mousedown: \(event\) => \{\s*\n\s*event\.preventDefault\(\)[\s\S]*?click: \(event\) => \{\s*\n\s*if \(pressed\)/)
  assert.match(renderer, /el\[key\]\?\.addEventListener\('mousedown', on\.mousedown\)\s*\n\s*el\[key\]\?\.addEventListener\('click', on\.click\)/)
  assert.match(renderer, /el\.docxOpenWord\?\.addEventListener\('mousedown', openInWord\.mousedown\)\s*\n\s*el\.docxOpenWord\?\.addEventListener\('click', openInWord\.click\)/)
  assert.match(renderer, /el\.docxTools\.hidden = !docxOpen \|\| state\.view === 'read' \|\| readOnlyHere\(\)/)

  /* The two structures a Word document can gain, and the four ways a table it
     has can be changed. All eight are palette rows and nothing else, so a
     missing case here is a row that silently does nothing. */
  for (const id of ['docx-bullets', 'docx-numbers', 'docx-no-list', 'docx-table',
    'docx-row', 'docx-column', 'docx-delete-row', 'docx-delete-column']) {
    assert.match(renderer, new RegExp(`case '${id}': docxInstance\\?\\.`))
    assert.match(renderer, new RegExp(`id: '${id}'`))
  }
  /* The placeholder the page writes and the save resolves. Written out in both
     files — there is no import between a renderer module and a main one — so
     this is the only place the two spellings can be compared. */
  const docxMain = read('electron', 'docx.js')
  // Bundled into the renderer when this runs against a built tree.
  const docxPage = source ? read('src', 'docx.js') : renderer
  for (const placeholder of ['TULIP_BULLET', 'TULIP_ORDERED']) {
    assert.ok(docxMain.includes(placeholder) && docxPage.includes(placeholder),
      `${placeholder} is not spelled the same in both halves of the Word document code`)
  }
  /* A notebook's run commands are the only things in the app that need a live
     kernel, and they were an API nothing called: `mountNotebook` returned a
     `run` object and no menu, palette or key ever reached it. All three legs
     are asserted — the menu item, the command the renderer answers it with,
     and the bridge the viewer runs it over — because any one of them missing
     is a menu entry that silently does nothing. */
  for (const [item, command] of [
    ['Run All Above', 'nb-run-above'],
    ['Run All Below', 'nb-run-below'],
    ['Restart and Run All…', 'nb-restart-all']
  ]) {
    assert.match(main, new RegExp(`label: '${item}'[^\\n]*'${command}'`), `${item} is in the menu`)
    /* Routed through `onNotebook` as a final guard too: the native menu is
       contextual, but a command already in flight must still verify the tab. */
    assert.match(renderer, new RegExp(`case '${command}': onNotebook\\(`),
      `${command} goes through the notebook guard`)
  }
  assert.match(renderer, /function onNotebook \([\s\S]{0,220}viewingNotebook\(\) && notebookInstance/,
    'the notebook guard tests for an open notebook')
  assert.match(renderer, /function onNotebook \([\s\S]{0,320}else toast\(/,
    'and says so when there is not one')
  assert.match(main, /const notebookActive = menuDocumentKind\(\) === 'notebook'/,
    'the native menu follows the focused window document')
  assert.match(main, /label: 'Notebook',\s*visible: notebookActive/,
    'the Notebook menu is visible only for a notebook')
  assert.match(preload, /menuContext: \(kind\) => ipcRenderer\.send\('menu:context'/,
    'the bridge reports active document menu context')
  assert.match(renderer, /api\.window\.menuContext\(notebookOpen \? 'notebook' : ''\)/,
    'tab changes report whether the active document is a notebook')
  assert.match(main, /ipcMain\.on\('menu:context'[\s\S]{0,300}buildMenu\(\)/,
    'main rebuilds the contextual menu when that state changes')
  /* The keyboard sheet, asserted leg by leg for the same reason the notebook
     menu is: the Help item, the command the renderer answers it with, and the
     markup it fills. A menu entry whose command nobody handles is silence, and
     this one cannot be driven from a probe — ⌘P and the Help menu are native
     accelerators, which CDP input events do not reach. */
  assert.match(main, /label: 'Keyboard Shortcuts'[^\n]*'shortcuts'/, 'Help offers the sheet')
  assert.match(main, /role: 'help'/, 'and there is a Help menu to offer it in')
  assert.match(renderer, /case 'shortcuts': openShortcuts\(\); break/, 'the renderer answers it')
  assert.match(renderer, /function openShortcuts \(\)[\s\S]{0,1200}el\.shortcuts\.hidden = false/,
    'and opening it shows the sheet')
  assert.match(html, /id="shortcuts-body"/, 'which has somewhere to be drawn')
  assert.match(html, /id="shortcuts"[\s\S]{0,200}aria-modal="true"/, 'and says it is modal')
  /* The chords are written out rather than derived, so they can drift from what
     actually answers them — and a sheet is read precisely by someone who does
     not already know the chord, so a row nothing handles sends them to press a
     key combination that does nothing at all.

     ⌃⌘S was that row for a while: the palette entry and the chord that studied
     the open language table were both deliberately removed when studying became
     the toolbar button's job, and the sheet went on advertising the chord. So
     this reads every row out of the sheet itself and insists each one is
     answered somewhere — no list here to keep in step, which is the failure the
     old hand-written half-list of ten claims allowed. */
  const sheetBlock = renderer.slice(renderer.indexOf('const SHORTCUTS = ['))
  const sheetRows = [...sheetBlock.slice(0, sheetBlock.indexOf('\n]\n'))
    .matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => [m[1], m[2]])
  assert.ok(sheetRows.length > 30, 'the sheet was found and read')

  /* A chord as the menu spells it. Both orders and both spellings of every
     modifier, because main writes `Alt+Cmd+Left` in one place and `Cmd+Alt+P`
     in another, and reaches for `CmdOrCtrl` on the chords Windows shares. */
  const MODS = { '⌘': ['Cmd', 'CmdOrCtrl'], '⇧': ['Shift'], '⌥': ['Alt'], '⌃': ['Ctrl', 'Control'] }
  const KEYS = { '←': ['Left'], '→': ['Right'], '↵': ['Enter'], '⏎': ['Enter'], '+': ['Plus', '='], '-': ['-'] }
  const orders = (list) => list.length < 2
    ? [list]
    : list.flatMap((item, i) => orders(list.filter((_, j) => j !== i)).map((rest) => [item, ...rest]))

  const accelerators = (chord) => {
    const marks = [...chord].filter((ch) => MODS[ch])
    const key = [...chord].filter((ch) => !MODS[ch]).join('')
    const keys = KEYS[key] || [key.toUpperCase()]
    const out = []
    for (const order of orders(marks)) {
      const spellings = order.map((mark) => MODS[mark])
      const combine = (at, prefix) => {
        if (at === spellings.length) {
          for (const k of keys) out.push([...prefix, k].join('+'))
          return
        }
        for (const spelling of spellings[at]) combine(at + 1, [...prefix, spelling])
      }
      combine(0, [])
    }
    return out
  }

  /* The chords no menu declares, each with the handler that answers it. A row
     may only sit here with proof, so deleting the handler fails the test rather
     than quietly widening the exemption. */
  const HANDLED_IN_APP = new Map([
    ['↵', ['the file tree', renderer, /e\.key === 'F2' \|\| \(e\.key === 'Enter' && !e\.metaKey/]],
    ['⌘↵', ['the file tree', renderer, /if \(e\.key === 'Enter'\) \{\s*\n\s*e\.preventDefault\(\)\s*\n\s*node\.type === 'folder'/]],
    ['⌥⌘F', ['the grid', csv, /event\.altKey && \(event\.code === 'KeyF'/]],
    ['⌘⏎', ['the grid', csv, /if \(mod\) insertRows\(/]],
    ['⌃T', ['the copilot', copilot, /if \(event\.code !== 'KeyT'\) return[\s\S]{0,200}cycleEffort\(/]]
  ])

  for (const [chord, what] of sheetRows) {
    const declared = accelerators(chord).some((accel) => main.includes(`accelerator: '${accel}'`))
    if (declared) continue
    const proof = HANDLED_IN_APP.get(chord)
    assert.ok(proof, `the sheet advertises ${chord} for "${what}" and nothing handles it`)
    assert.match(proof[1], proof[2],
      `${chord} ("${what}") is answered in ${proof[0]}, and that handler is gone`)
  }
  /* Completion, inspection and the answer to an `input()` all need the live
     kernel, so all three cross the bridge rather than being guessed at here.
     The handlers answer from electron/ipc-kernel.js, beside the host. */
  const kernelIpc = read('electron', 'ipc-kernel.js')
  for (const call of ['input', 'complete', 'inspect']) {
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('kernel:${call}'`))
    assert.match(kernelIpc, new RegExp(`ipcMain\\.handle\\('kernel:${call}'`))
  }
  /* The one thing a notebook has to stop and ask about — a restart throws away
     every variable in the session — asked in the app's own dialog. */
  assert.match(renderer, /\n\s*ask,\n/)
  assert.match(renderer, /\n\s*beforeRun: mayRunCode,\n/)
  assert.match(renderer, /\n\s*notify: toast,/)
  /* Auto-resize is offered for both grids and routed to whichever is open —
     the palette row and the thing it calls, which are easy to add one of. */
  assert.match(renderer,
    /if \(viewingLanguageTable\(\) \|\| viewingData\(\)\) \{\s*commands\.push\(\{ id: 'fit-columns'/)
  assert.match(renderer, /viewingData\(\) \? dataInstance\?\.fitColumns\(\) : editor\?\.fitAllColumns\(\)/)
  assert.match(preload, /create: \(dir, name, ext\) => ipcRenderer\.invoke\('source:create', dir, name, ext\)/)
  assert.match(read('electron', 'ipc-create.js'), /ipcMain\.handle\('source:create'/)
  /* The import door admits whatever the vault walk itself keeps — one test,
     stated once — so a newly supported kind cannot be listed in the tree and
     refused at the door, which is exactly what happened to `.docx`. The door
     itself lives in electron/ipc-vault-write.js. */
  assert.match(read('electron', 'ipc-vault-write.js'), /if \(!isSnapshotFile\(source\)\) \{ skipped\+\+; return \}/)
  assert.match(renderer, /mode === 'new-files'\) \{ runCommand\(item\.id, dir\)/)
  assert.doesNotMatch(renderer, /title = 'Press ⌘Enter to send'/)
  assert.match(renderer, /codeAiPop\.isConnected && codeAiSession\?\.anchor === anchor/)
  /* Slash commands borrow the command palette surface; applying that treatment
     to every CodeMirror completion would also bloat note, tag and language
     pickers. Keep the source marker and scoped class wired together. */
  assert.match(editor, /function completionTooltipClass[\s\S]{0,300}'tk-slash-completion'/)
  assert.match(editor, /tooltipClass: completionTooltipClass/)
  assert.match(editor, /\.tk-slash-completion[\s\S]{0,800}borderRadius: '10px'/)
  assert.match(editor, /\.tk-slash-completion[\s\S]{0,1200}background: 'var\(--accent-dim\)'/)
  assert.match(html, /id="flashcard-add-choice"[^>]*>Add answer choice<\/button>/)
  assert.match(html, /id="flashcard-image-add"[^>]*>Add image<\/button>/)
  assert.match(html, /id="flashcard-image-input"[^>]*accept="image\/\*"/)
  assert.match(html, /id="flashcard-tags"/)
  assert.match(html, /id="flashcard-bank-add"/)
  assert.match(html, /id="flashcard-bank"/)
  assert.match(html, /id="flashcard-bank-add-main"/)
  assert.match(html, /id="flashcard-bank-topic-list"/)
  assert.match(html, /id="flashcard-bank-list"/)
  assert.match(html, /id="fc-study"/)
  assert.match(html, /flashcard-choice is-correct[^>]*><span>Correct answer<\/span>/)
  assert.doesNotMatch(html, /name="flashcard-correct"/)
  assert.match(renderer, /function addFlashcardChoice[\s\S]{0,1200}el\.flashcardAddChoice\.before\(row\)/)
  assert.match(renderer, /function renumberFlashcardChoices[\s\S]{0,650}Remove other choice \$\{index\}/)
  assert.match(renderer, /options,[\s\S]{0,80}correct: 0/)
  assert.match(renderer, /tags: el\.flashcardTags\.value/)
  assert.match(renderer, /buildFlashcardQueue\(study\.cards, tag\)/)
  assert.match(renderer, /el\.reading\.hidden = !text \|\| flashcardOpen/)
  assert.match(renderer, /el\.editorHost\.hidden = !text \|\| flashcardOpen/)
  assert.match(renderer, /button\.addEventListener\('click', \(\) => openFlashcardStudy\(tag\)\)/)
  assert.match(renderer, /id: 'new-flashcards', title: 'Flashcard bank'/)
  assert.match(renderer, /function resetFlashcardChoices[\s\S]{0,180}\.flashcard-choice\.is-added/)
  assert.match(renderer, /el\.flashcardAddChoice\.addEventListener\('click', \(\) => addFlashcardChoice\(\)\)/)
  /* Quiz source stays behind a purpose-built card. Answering is handled inside
     the widget; only its Edit button opens the structured form. */
  assert.match(editor, /class FlashcardWidget extends WidgetType/)
  assert.match(editor, /CustomEvent\('tulip:flashcard-edit'/)
  assert.match(editor, /function buildFlashcardWidgets[\s\S]{0,700}new FlashcardWidget/)
  assert.match(editor, /head\?\.kind\.id === 'quiz'[\s\S]{0,180}if \(card\) return false/)
  assert.match(renderer, /document\.addEventListener\('tulip:flashcard-edit'/)
  assert.match(renderer, /editing \? 'Save changes' : 'Add flashcard'/)
  assert.match(flashcardStyles, /\.tk-flashcard-edit/)
  assert.match(flashcardStyles, /\.flashcard-field textarea \{ overflow-y: hidden; \}/)
  assert.match(flashcardStyles, /\.flashcard-bank \{[\s\S]{0,120}flex: 1;[\s\S]{0,80}min-width: 0;/)
  assert.match(renderer, /flashcardForm\.addEventListener\('paste'/)
  /* Flashcards are inserted from `/Flashcard`. Keeping the same action in the
     command palette made two search surfaces compete for one operation. */
  assert.doesNotMatch(renderer, /insert-flashcard/)
  assert.doesNotMatch(renderer, /document\.addEventListener\('pointerdown',[\s\S]{0,180}codeAiPop/)
  assert.doesNotMatch(renderer, /codeAiPop\.addEventListener\('keydown',[\s\S]{0,160}Escape/)
  /* Reject is the destructive half of the pair and is coloured as one — see
     `.ghost.is-danger`, which every theme defines through `--code-removed`. */
  assert.match(copilot, /element\('button', 'ghost is-compact is-danger', 'Reject'\)/)
  /* One Diff for the turn, beside Accept and Reject, rather than one per file:
     a turn is read the same way it is accepted or rejected — whole. */
  assert.match(copilot, /element\('button', 'ghost is-compact ai-review-diff', 'Diff'\)/)
  /* Which classes count as a scene has to be the same question in the renderer,
     which offers to render a .py file, and in main, which then picks the scene
     out of it. They were briefly `\bScene\b` here and `Scene\b` there, and the
     difference is every subclass anyone actually uses — `MovingCameraScene`,
     `ThreeDScene` — offered and then refused. */
  assert.match(manim, /\/Scene\\b\/\.test/)
  /* Main's half of the question moved into the render domain with the rest of
     the manim renderer. */
  assert.match(read('electron', 'ipc-render.js'), /\/Scene\\b\/\.test/)
  /* And a source file's language arrives as its extension, so the check for
     "is this python" goes through the alias list rather than one spelling. */
  assert.match(renderer, /isLanguage\(lang, 'python'\) && isManimSource\(code\)/)
  assert.match(copilot, /const name = entry\.name \|\| noteName\(entry\.path\)/)
  assert.match(copilot, /run: \(\) => selectMention\(from, entry\.path\)/)
  assert.match(copilot, /box\.value = box\.value\.slice\(0, from\) \+ box\.value\.slice\(to\)/)
  assert.match(copilot, /addAttachments\(\[path\], true\)/)
  assert.match(read('src', 'copilot-attachments.js'), /function attachmentKind \(path\)/)
  /* Fenced code in a reply is coloured by the reading view's own painter, from
     the class markdown-it's fence rule leaves the language in — and on every
     path that writes prose into the panel, including the settled half of a
     reply still streaming. A block dressed on one of them and not the others is
     a reply whose colours come and go as the log is rebuilt. */
  assert.match(copilot, /import \{ highlightInto \} from '\.\/highlight\.js'/)
  assert.match(copilot,
    /querySelectorAll\('pre > code\[class\*="language-"\]'\)[\s\S]{0,220}highlightInto\(code, code\.textContent, lang\)/)
  // The four call sites: repaint, first draw, a question's own copy, and the
  // settled head of a stream. (The definition writes `dressCode (root)`.)
  assert.equal(copilot.match(/\bdressCode\(/g)?.length, 4)
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
  assert.match(baseStyles, /\.ai-menu\s*\{[\s\S]{0,300}max-height:\s*260px/)
  /* Run output is a window over the stage, sized by the grip in its corner.
     Its position is the stylesheet's and its size is the script's, so each
     half is pinned where it lives: absolute against the stage here, and both
     dimensions written and stored there. */
  assert.match(baseStyles, /\.file-run-pop\s*\{[\s\S]{0,200}position:\s*absolute/)
  assert.match(baseStyles, /\.file-run-grip\s*\{[\s\S]{0,220}cursor:\s*nwse-resize/)
  assert.match(runcode, /host\.style\.width = `\$\{Math\.round\(w\)\}px`/)
  /* A picture's popup is the picture's shape, so nothing of the panel shows
     around the render — the one thing this whole panel is for. */
  assert.match(runcode, /h = w \/ aspect/)
  assert.match(runcode, /api\.config\.set\(\{ runWidth: size\.w, runHeight: size\.h \}\)/)
  assert.match(runcode, /grip\.setPointerCapture\(event\.pointerId\)/)
  assert.match(renderer, /tab\.scrollIntoView\(\{ inline: 'nearest', block: 'nearest' \}\)/)
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
  /* Return takes the filled action wherever focus is, destructive or not. The
     colour and not the focus ring is the dialog's statement of intent, and a
     "Move to Trash?" that answers Return with "no" surprises more than it
     saves — esc is the way back, and it is one key away. */
  assert.match(ask, /el\.askGo\.focus\(\)/)
  assert.doesNotMatch(ask, /danger/)
  assert.match(renderer, /if \(e\.key === 'Enter'\) \{\s*\n\s*e\.preventDefault\(\)\s*\n\s*answer\(true\)/)
  /* The dormant horizontal scroll is still reset when wrapping is turned off —
     but only on that transition. Writing `scrollLeft` forces layout on the
     element written to, so doing it for every code block on every applyConfig
     (which includes boot, with wrapping off by default) walked and laid out
     the whole page: on a note with 13,000 fenced blocks the window wedged and
     never came back. The `wasWrappingCode &&` is the whole fix, so it is what
     is pinned here. */
  assert.match(renderer, /if \(wasWrappingCode && !wrapsCode\)[\s\S]{0,150}pre\.scrollLeft = 0/)
  assert.match(renderer, /const wasWrappingCode = el\.app\.dataset\.codeWrap === 'on'/)
  /* And the same class of mistake in the reading view's place-keeping, which
     is what found it: `viewportLine` must bisect the raw NodeList, never a
     copy filtered by `offsetParent` — that filter cannot be answered without
     laying out every block it asks about. */
  assert.doesNotMatch(renderer, /querySelectorAll\('\[data-line\]'\)\)\s*\n?\s*\.filter/)
  /* And the collection itself is made once per render, not once per scroll
     frame. `querySelectorAll('[data-line]')` is an unindexed attribute match
     over the whole rendered note that materialises every block in it; both
     readers of that list go through the cache, and the one place that rebuilds
     the reading view is the one place that drops it. */
  assert.match(renderer, /function readingLineNodes \(\)/)
  assert.match(renderer, /el\.reading\.replaceChildren\(col\)\s*\n\s*invalidateReadingLines\(\)/)
  for (const site of ['function viewportLine', 'function readingNodeAt']) {
    const body = renderer.slice(renderer.indexOf(site))
    assert.match(body.slice(0, 900), /readingLineNodes\(\)/)
  }
  assert.match(renderer, /function laidOutNear \(nodes, mid, lo, hi\)/)
  assert.match(whiteboard, /whiteboardElementsText\(latest\.elements\)/)
  assert.match(whiteboard, /revision === writingRevision/)
  assert.match(whiteboard, /saveScene\(\{ flush: true \}\)/)
  assert.match(whiteboard, /aiEnabled: false/)
  assert.match(preload, /write: \(p, content, metadata\)/)
  assert.match(main, /lastSearch\.whiteboardKeys/)
  /* Carried in `lastSearch` so a narrowing query can reuse it. Pinned as a
     field of that object rather than as the last line of it — it was written
     as `whiteboardKeys\n}` when it happened to be last, and the PDF pass then
     took the same treatment and moved it. */
  assert.match(main, /lastSearch = \{[\s\S]{0,400}\n\s*whiteboardKeys,/)
  /* And PDFs narrow too. That pass was the one thing a shrinking query never
     got cheaper for: it re-statted and re-parsed the sidecar of every PDF in
     the vault on every keystroke. `pdfAt` is what makes reuse safe — a PDF
     that changed while the pass ran invalidates the list. */
  assert.match(main, /lastSearch = \{[\s\S]{0,400}\n\s*pdfKeys: pdfAnswer\.keys,/)
  assert.match(main, /lastSearch = \{[\s\S]{0,600}\n\s*pdfAt: pdfsAt/)
  assert.match(build, /name: 'lean-excalidraw'/)
  assert.match(build, /const pdfOcrCache = path\.join\(os\.homedir\(\), 'Library', 'Caches', 'Tulip', 'native'\)/)
  assert.doesNotMatch(build, /path\.join\('node_modules', '\.cache', 'tulip-native'\)/)
  const watchStart = build.indexOf('if (watch) {')
  const watchBuild = build.slice(watchStart, build.indexOf('} else {', watchStart))
  assert.ok(
    watchBuild.indexOf('await ctx.watch()') < watchBuild.indexOf('await buildPdfOcr()'),
    'source watchers must start before PDF OCR compilation'
  )
  /* A focused block fix is a self-contained request, and the whole point of it
     is that it does not drag the open conversation along behind it — a chat of
     its own, and no excerpt of the open document. What that mode *does* is
     tested behaviourally in test-ai.mjs, through `promptFor`; what is pinned
     here is only the thing a behavioural test cannot see, which is that all
     four files name the mode through the shared constant rather than spelling
     the string out. A literal that drifted would not fail a behavioural test —
     it would quietly stop matching, and the excerpt would come back with no
     symptom beyond a bigger bill. */
  for (const file of [renderer, copilot]) {
    assert.match(file, /CONTEXT_MODES/, 'the code-task mode is named, not spelled out')
    assert.doesNotMatch(file, /'code-task'/, 'no bare code-task literals outside models.js')
  }
  /* Both ways in. A fix asked while the panel was idle goes out from `submit`;
     one asked mid-turn is queued and goes out from `drain` minutes later, and
     it is the same self-contained request either way — the queued path used to
     be the one that silently kept paying for the history. Both must route
     through the one place that decides which conversation a turn belongs to. */
  assert.equal(copilot.match(/convoFor\(/g)?.length, 2,
               'submit and drain both choose their conversation through convoFor')
  assert.match(copilot, /function convoFor \(/, 'and convoFor is where that rule lives')
  /* Source is dense and tool reads are cheap; a note is neither. The contract
     is that the two stay apart, not what either number happens to be — pinning
     the values would make a deliberate re-tune a test failure. */
  if (source) {
    const budgets = copilotContext.match(/code: \{ whole: (\d+), window: (\d+) \}/)
    const notes = copilotContext.match(/note: \{ whole: (\d+), window: (\d+) \}/)
    assert.ok(budgets && notes, 'both excerpt budgets must be readable')
    assert.ok(Number(budgets[1]) < Number(notes[1]),
              'a source file must start being windowed long before a note does')
  }
  /* Compaction acts well below the red ring, because a thread that is resumed
     re-sends itself on every turn: waiting costs the whole context again. */
  const roomy = Number(copilot.match(/const ROOMY = ([\d.]+)/)?.[1])
  const full = Number(copilot.match(/const FULL = ([\d.]+)/)?.[1])
  assert.ok(roomy > 0 && full > 0, 'both context thresholds must be readable')
  assert.ok(roomy < full, 'compaction must act below the point the ring calls full')

  assert.deepEqual(
    normalizeSavedSearches([{ query: 'type:pdf climate' }, { query: 'TYPE:PDF CLIMATE' }, 'tag:book'])
      .map(({ name, query }) => ({ name, query })),
    [
      { name: 'type:pdf climate', query: 'type:pdf climate' },
      { name: 'tag:book', query: 'tag:book' }
    ]
  )
}

/* A note's merge base follows every successful save, not only the ones no
   keystroke interrupted. With the base one save behind, a watcher event that
   changed nothing merged the buffer against Tulip's own previous autosave and
   called the result a conflict. And a disk that still matches the base is not
   merged at all. */
assert.match(renderer, /holdNoteStamp\(wrote, wroteReply\?\.stamp\)[\s\S]{0,900}if \(tab && tab\.path === wrote\) tab\.base = text[\s\S]{0,1400}if \(editor\.state\.doc === doc && state\.current\?\.path === wrote\)/,
  'the tab base is updated after every successful write, before the dirty-flag identity test')
assert.match(renderer, /if \(disk === buffer\) \{ mergeOpen = false; return true \}[\s\S]{0,600}if \(disk === base\) \{[\s\S]{0,120}mergeOpen = false/,
  'a disk that still matches the base skips the merge')

/* A bookmark is one comment line in the note; a fresh open of the note lands on
   it, a return to its tab does not; the second bookmark replaces the first. */
assert.match(read('src', 'bookmark.js'), /export const BOOKMARK_LINE = '<!-- bookmark -->'/)
assert.match(renderer, /bookmark = place == null \} = \{\}\) \{/, 'a fresh open honours the bookmark, a tab return keeps its own place')
assert.match(renderer, /place: tabPlace\(state\.tabs\[state\.tabIndex\]\),[\s\S]{0,200}bookmark: true/, 'launch reopens the last note at its bookmark')
assert.match(renderer, /const had = bookmarkLineOf\(doc\.toString\(\)\)[\s\S]{0,700}changes\.push\(\{ from: at\.from, insert: BOOKMARK_LINE \+ '\\n' \}\)/, 'setting a bookmark removes the old one in the same edit')

assert.match(read('src', 'markdown.js'), /md\.block\.ruler\.before\('html_block', 'bookmark'/, 'the reading view claims the bookmark ahead of raw HTML')
/* `/bookmark` in the slash menu is the palette's "Bookmark this place": the
   slash text is cleared first, then the renderer's own setBookmark runs. */
assert.match(read('src', 'slash.js'), /action\('Bookmark', \[[^\]]*\], BLOCKS,\s*\(view\) => view\.dom\.dispatchEvent\(new CustomEvent\('tulip:bookmark'/, 'the slash menu offers Bookmark as an action')
assert.match(renderer, /document\.addEventListener\('tulip:bookmark', \(\) => setBookmark\(\)\)/, 'the renderer answers /bookmark with setBookmark')
assert.match(read('src', 'editor.js'), /const RENDERED = \[bookmarkPreview,/, 'the editing view draws the bookmark widget')
assert.match(renderer, /editor\.scrollToLine\(marker, \{ center: true \}\)[\s\S]{0,80}restoreReadingPlace\(marker, \{ center: true \}\)/, 'the bookmark is centred in both views')
assert.match(renderer, /if \(place && !marked\) \{/, 'the bookmark takes the remembered place\'s turn rather than racing it')
assert.match(read('src', 'styles.css'), /\.bookmark-mark, \.tk-bookmark \{/, 'both views share the ribbon styles')

console.log(`ui contracts: ${source ? 'source' : target}`)
