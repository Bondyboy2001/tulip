import './styles.css'
import './styles-features.css'
import { createMarkdown } from './markdown.js'
import { mountPanels } from './panels.js'
import { mountTexSplit } from './tex-split.js'
import { mountAsk } from './ask.js'
import { languageChip, languageColor, languageLabel, SOURCE_CHOICES } from './languages.js'
import {
  NOTE_EXT, TEX_EXT, PDF_EXT, SITE_EXT, WHITEBOARD_EXT, NOTEBOOK_EXT,
  isChatAttachment, isTexPath, isPdfPath, isSitePath, isWhiteboardPath,
  isCodePath, isDataPath, isNotebookPath, codeToken, isViewedFilePath
} from './vault-paths.js'
import { DEFAULT_ZOOM } from './zoom.js'
import { highlightInto } from './highlight.js'
/* `el` is this module's own name for the DOM registry, so blocks.js's element
   builder comes in under another — the same aliasing settings.js and copilot.js
   do. */
import { codeCopilotButton, copyButton } from './blocks.js'
import { svgIcon, el as node, trapModalFocus } from './dom.js'
import { fileIcon } from './file-icons.js'
import { wordsIn, groupWords } from './spelling.js'
import { prepareMath, equationIndex, equationsFor, docText } from './math.js'
import { dressCitations } from './citations.js'
import { THEMES, resolveTheme, isTheme, isDarkTheme } from './themes.js'
import { FONTS, FONT_ROLES, fontStack, fontLabel, isFont } from './fonts.js'
import {
  assetIndex, embedSpec, specForEmbed, renderEmbed, isAsset,
  isImageAsset, findEmbeds, destroyEmbeds, fileChip, assetUrl, assetKind,
  markImageCells
} from './assets.js'
import {
  initTransclusion, refreshTransclusions, installNotePreview
} from './transclude.js'
import {
  initSidePane, openToSide, closeSidePane, sideDoc, refreshSidePane
} from './sidepane.js'
import { routeFragmentClick, activateFocusedWikilink } from './links.js'
import { settled, repin, othersOf, rightOf } from './tabstrip.js'
import { safeCut } from './reading-split.js'
import {
  attachRunControl, clearBlockOutputs, isRunnable, onAskToFix, retirePainters, runBlocksInOrder
} from './runcode.js'
import { htmlFence, isHtmlRun } from './htmlrun.js'
import { isThree, threeFence } from './threejs.js'
import { attachManim, isManim } from './manim.js'
import { attachTikz, isTikz } from './tikz.js'
import { attachMermaid, isMermaid } from './mermaid.js'
import { attachSvg, isSvg } from './svg.js'
import {
  headings, headingsFor, splitAnchor, findHeading, findBlock, installHeadingFolds
} from './headings.js'
import { lintEdits } from './lint.js'
import { diffTrees, compareTreeNodes } from './tree-diff.js'
import { mountHistory } from './history.js'
import { parseFrontmatter, frontmatterRange, writeListProp } from '../electron/frontmatter.cjs'
import { when } from './time.js'
import { mountMergePanel } from './mergepanel.js'
import { merge3 } from './merge.js'
import { fileDiff } from './linediff.js'
import { mountPdf, MARK_COLORS } from './pdf.js'
import { mountPdfFind } from './pdf-find.js'
import { mountSite } from './site.js'
import {
  isLanguageTablePath, mountLanguageStudy, normalizeLanguageTable, importCards
} from './language-table.js'
/* The system's own voices. A vocabulary table is silent and a language is not —
   see src/speech.js for why nothing is downloaded and why a language the
   machine cannot speak simply gets no audio. */
import { makeSpeech } from './speech.js'
import { mountKeyboard } from './keyboard.js'
import { mountPanelAccessibility } from './panel-state.js'
import { mountSavedSearches } from './saved-searches.js'
import ALPHABETS from '../electron/alphabets.json'
import { COUNTRIES, countryCode, languageIdentity } from './countries.js'

const api = window.tulip
const $ = (id) => document.getElementById(id)

/* ------------------------------------------------------- failures, out loud

   Installed first, before anything below it can be the thing that goes wrong.

   Main has kept a crash log since it had crashes to log. The window had no
   equivalent: an exception thrown here reached a DevTools console nobody had
   open, and stopped there. What that cost was measurable — three unhandled
   TypeErrors were being thrown on every launch, each one silently skipping
   something the reader was owed (the first note's spellcheck pass; the
   disk-conflict check that runs on window focus), and finding them meant
   attaching a debugger rather than using the app.

   Every failure goes to the log. The reader is told once per session and no
   more: the second failure is nearly always the first one repeating, and a
   toast per repeat would bury the app under its own bad news. The log is the
   complete record; the toast only says that there is one worth reading. */
let toldOfFailure = false

function reportFailure (kind, error) {
  const detail = error instanceof Error
    ? `${error.stack || error.message}`
    : String(error?.message || error)
  try { api.reportError(kind, detail) } catch { /* the bridge is what failed */ }
  if (toldOfFailure) return
  toldOfFailure = true
  /* `toast` is defined further down and this can fire before then — a boot
     failure is exactly when it might — so the call is deferred rather than
     made from inside a handler that would then throw its own error. */
  setTimeout(() => {
    /* Names the command rather than the file. "The details are in the crash
       log" was true and unactionable: the log lives in the app's data
       directory, which a reader has no reason to know about and no way to
       reach from in here. The palette is where they already look. */
    try { toast('Something went wrong — see “Reveal crash log” in the palette.') } catch {}
  }, 0)
}

window.addEventListener('error', (event) => {
  reportFailure('error', event.error || event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  reportFailure('unhandledRejection', event.reason)
})

/* Read from Electron's packaged metadata rather than duplicated in HTML, so a
   release changes this label simply by changing the app's real version. */
api.version().then((version) => {
  const label = $('app-version')
  if (label) label.textContent = `v${version}`
}).catch(() => {})

/* ----------------------------------------------------------------- state */

const state = {
  vault: null,
  tree: [],
  files: [],          // flattened, for the switcher and wikilinks
  /* Frontmatter `aliases`, as lowercased alias -> the paths that claim it. The
     tree does not carry them — they live inside notes, and the sidebar is a
     walk of names — so they are asked for separately; see refreshAliases. */
  aliases: {},
  /* The tree's one tab stop, as a path. The arrows move it; renderTree puts it
     back on the same row, or on the open note if that row has gone. */
  treeFocus: null,
  assetsKey: '',      // the attachment list as last seen, to skip no-op rebuilds
  /* Main's signature for the vault as it is currently drawn — { tree, assets }.
     Sent back with the next snapshot request so an unchanged vault answers
     without shipping the tree; see loadTree. */
  revision: null,
  assets: [],
  resolveAsset: () => null,
  current: null,      // { path, name, dir } — the active tab's note
  /* One entry per open tab. A tab is a note *and* the trail that led to it:
     back and forward belong to the tab you are in, the way they do in a
     browser, so following links in one leaves the other where you left it. */
  tabs: [],           // { path, history: [{ path, at, top }], historyAt }
  tabIndex: -1,
  cfg: {},            // the stored settings, as last read or written
  dirty: false,
  patching: false,    // the copilot is writing into the buffer, not the user
  // 'read' (rendered) | 'edit' (live preview) | 'raw' (source). A note is
  // something to read until you say otherwise, so reading is where a fresh
  // install opens; the view you leave it in is remembered from then on.
  view: 'read',
  expanded: new Set(),
  /* The documents locked to their reading view, as vault-relative paths. Read
     from the config at boot and written back on every change — see
     `toggleLock`. */
  locked: new Set(),
  picked: new Set(),   // multi-selected file paths in the tree
  pickAnchor: null,    // where a shift-range measures from
  dragging: null,      // paths currently being dragged in the tree
  theme: 'light',
  // The typeface in each role — see FONT_ROLES in fonts.js.
  fonts: { body: 'charter', ui: 'system-sans' },
  /* The file tree is the sidebar's upper panel and is not optional. This is
     the panel underneath it, or null for none. See setPaneBelow. */
  paneBelow: null,
  saveTimer: null,
  /* Whether this is the session's own window — the first one opened. A second
     window on the same vault is a full window in every way but two: it does not
     restore or remember the tab strip, and it does not hold the copilot. See
     `sessionOnly` and the account beside `createWindow` in main. */
  primary: true,
  overlay: null       // { mode, items, index }
}

const el = {
  app: $('app'),
  sidebar: $('sidebar'),
  tree: $('tree'),
  vaultLabel: $('vault-label'),
  tabs: $('tabs'),
  navBack: $('nav-back'),
  navForward: $('nav-forward'),
  stage: $('stage'),
  main: document.querySelector('.main'),
  editorHost: $('editor-host'),
  reading: $('reading'),
  texDivider: $('tex-divider'),
  texPreview: $('tex-preview'),
  texPdf: $('tex-pdf'),
  data: $('data'),
  notebook: $('notebook'),
  fileview: $('fileview'),
  empty: $('empty'),
  emptyActions: $('empty-actions'),
  landing: $('landing'),
  connectVault: $('btn-connect-vault'),
  bootScreen: $('boot-screen'),
  bootTitle: $('boot-title'),
  bootMessage: $('boot-message'),
  bootDetail: $('boot-detail'),
  bootRetry: $('boot-retry'),
  bootConnect: $('boot-connect'),
  statusLeft: $('status-left'),
  statusRight: $('status-right'),
  overlay: $('overlay'),
  panel: $('panel'),
  panelInput: $('panel-input'),
  panelList: $('panel-list'),
  panelFoot: $('panel-foot'),
  fontSample: $('font-sample'),
  toast: $('toast'),
  ask: $('ask'),
  askTitle: $('ask-title'),
  askGo: $('ask-go'),
  askCancel: $('ask-cancel'),
  orphans: $('orphans'),
  orphansList: $('orphans-list'),
  orphansCount: $('orphans-count'),
  orphansAll: $('orphans-all'),
  orphansClose: $('orphans-close'),
  ctx: $('ctx'),
  viewSwitch: $('view-switch'),
  lockMark: $('lock-mark'),
  studyStart: $('study-start'),
  langKeys: $('lang-keys'),
  langKeysRow: $('lang-keys-row'),
  langKeysShift: $('lang-keys-shift'),
  langMode: $('lang-mode'),
  zoom: $('zoom'),
  outlineList: $('outline-list'),
  linksList: $('links-list'),
  spellingList: $('spelling-list'),
  infoPane: $('info-pane'),
  paneOutlineTab: $('pane-outline-tab'),
  paneSplit: $('pane-split'),
  paneSplitGrip: $('pane-split-grip'),
  paneSplitToggle: $('pane-split-toggle'),
  paneTabsBelow: $('pane-tabs-below'),
  panelChips: $('panel-chips'),
  panelReplace: $('panel-replace'),
  panelReplaceInput: $('panel-replace-input'),
  panelReplaceGo: $('panel-replace-go'),
  panelSaveSearch: $('panel-save-search'),
  savedSearches: $('saved-searches'),
  askDetail: $('ask-detail'),
  settings: $('settings'),
  settingsRail: $('settings-rail'),
  settingsBody: $('settings-body'),
  settingsTitle: $('settings-title'),
  settingsClose: $('settings-close'),
  aiPanel: $('ai'),
  aiLog: $('ai-log'),
  aiAttachments: $('ai-attachments'),
  aiInput: $('ai-input'),
  aiSend: $('ai-send'),
  aiClose: $('ai-close'),
  aiToggle: $('ai-toggle'),
  aiModel: $('ai-model'),
  aiAttach: $('ai-attach'),
  aiWrite: $('ai-write'),
  aiWriteLabel: $('ai-write-label'),
  aiEffort: $('ai-effort'),
  aiEffortRow: $('ai-effort-row'),
  aiEffortRange: $('ai-effort-range'),
  aiEffortStops: $('ai-effort-stops'),
  aiConfigSep: $('ai-config-sep'),
  aiContext: $('ai-context'),
  aiContextWrap: $('ai-context-wrap'),
  aiContextPop: $('ai-context-pop'),
  aiPop: $('ai-pop'),
  aiMenu: $('ai-menu'),
  aiConfig: $('ai-config'),
  aiConfigModel: $('ai-config-model'),
  aiConfigEffort: $('ai-config-effort'),
  gripSidebar: $('grip-sidebar'),
  gripAi: $('grip-ai'),
  sidepane: $('sidepane'),
  sidepaneBody: $('sidepane-body'),
  sidepaneClose: $('sidepane-close'),
  gripSide: $('grip-side'),
  pdf: $('pdf'),
  pdfTools: $('pdf-tools'),
  pdfPrev: $('pdf-prev'),
  pdfNext: $('pdf-next'),
  pdfPage: $('pdf-page'),
  pdfPages: $('pdf-pages'),
  pdfFit: $('pdf-fit'),
  pdfToolSelect: $('pdf-tool-select'),
  pdfToolMark: $('pdf-tool-mark'),
  pdfPens: $('pdf-pens'),
  foldAll: $('btn-fold-all'),
  site: $('site'),
  siteTools: $('site-tools'),
  siteBack: $('site-back'),
  siteForward: $('site-forward'),
  siteReload: $('site-reload'),
  siteAddress: $('site-address'),
  siteSave: $('site-save'),
  siteOpen: $('site-open'),
  whiteboard: $('whiteboard'),
  drawerScrim: $('drawer-scrim')
}

/* A collapsed grid column is also absent to the keyboard and accessibility
   tree. Watching the shell keeps sidepane.js and copilot.js independent: they
   continue to own opening, and this owns what "closed" means. */
mountPanelAccessibility(el.app, {
  sidebar: el.sidebar,
  sidepane: el.sidepane,
  aiPanel: el.aiPanel,
  returnFocus: {
    sidebar: () => el.tabs.querySelector('[aria-current="true"]')?.focus(),
    sidepane: () => el.tabs.querySelector('[aria-current="true"]')?.focus(),
    aiPanel: () => el.aiToggle.focus()
  }
})

/* The kinds with no reading view: source of one sort or another, shown as
   itself. `state.view` is a preference held across documents, so the question
   is not what the user last chose but whether what is open has three views to
   choose between — a `.py` opened while the preference says "read" must not
   put a Python script through the Markdown renderer. */
const SOURCE_KINDS = new Set(['tex', 'code', 'data'])
const reading = () => state.view === 'read' && !SOURCE_KINDS.has(state.current?.kind)

/** Resolve an attachment the way the open note would read it. Both views go
 *  through this, so neither can end up resolving against a different folder. */
const resolveHere = (src) => state.resolveAsset(src, state.current?.dir || '')

/* The vault holds three kinds of document, and almost everything below has to
   know which one is on screen: a PDF has no text to save, no views to cycle
   between, and no headings — it has pages, and highlights. A website has less
   still. It is a live page, so there is nothing of it here to save, to search,
   to outline or to render; the file only says which page.

   What each extension is comes from vault-paths.js, which builds it from the
   contract electron/main.js reads — so the process that lists a file and the
   process that opens it cannot disagree about what kind it was. */

/* What the side pane can render: the two kinds that are a document on disk. A
   website is a live guest and has to have a tab and a process of its own. */
const canShowBeside = (path) =>
  !!path && !isTexPath(path) && !isSitePath(path) && !isWhiteboardPath(path) &&
  !isDataPath(path) && !isNotebookPath(path)
const viewingPdf = () => state.current?.kind === 'pdf'
const viewingTex = () => state.current?.kind === 'tex'
const viewingSite = () => state.current?.kind === 'site'
const viewingWhiteboard = () => state.current?.kind === 'whiteboard'
const viewingLanguageTable = () => state.current?.kind === 'language'
/* A source file is edited exactly as a note is — same editor, same autosave,
   same history — and differs only in the grammar it is coloured with and in
   having no prose views to switch between. A data file is not edited here at
   all; it has a grid. */
const viewingCode = () => state.current?.kind === 'code'
const viewingData = () => state.current?.kind === 'data'
/* A notebook is neither. It is text on disk, but the text is nbformat's JSON
   and the document is the cells inside it — so it gets a viewer, like the
   table does, and nothing here reads it as prose or as source. */
const viewingNotebook = () => state.current?.kind === 'notebook'
/* A file with no view of its own — a picture, a recording, a `.docx`. Not
   text: anything that reads as text was handed to the editor at the door, so
   whatever is in this pane is something there is nothing to type into. */
const viewingFile = () => state.current?.kind === 'file'

/* Whether what is on screen is a document made of lines — the reading view or
   the editor. Every other kind brings a pane of its own, and the two facts
   that follow from that are the same fact: the note's own chrome does not
   apply to it, and neither does anything that acts on a column of text. */
const viewingText = () =>
  !viewingPdf() && !viewingSite() && !viewingWhiteboard() && !viewingData() &&
  !viewingNotebook() && !viewingFile()

/* ------------------------------------------------------------------ locks

   A locked document is one the reader has said they are done editing: it opens
   in its reading view and stays there until they unlock it, so a stray
   keystroke over a finished note cannot change it.

   The lock is enforced at the two doors into editing rather than by making the
   buffer read-only — `setView` refuses to leave the reading view, and
   `applyPanes` puts a locked document back into it however it was opened. A
   read-only editor would still have to be got into, and every other way of
   reaching the text (the find panel, a template, the copilot) walks through
   one of those two.

   Only the kinds with a reading view can be locked. A `.py` or a `.tex` is
   shown as source and has nowhere else to be held. */
const canLock = () => Boolean(state.current) &&
  ((viewingText() && !SOURCE_KINDS.has(state.current.kind)) ||
   viewingData() || viewingNotebook())
const lockedHere = () => Boolean(state.current && state.locked.has(state.current.path))
/* Files of no known kind that turned out to be text when they were opened.
   The probe is a read, so its answer is kept: `noteRef` is asked what kind of
   thing a path is on every repaint, and it cannot go to disk to find out. A
   file only reaches this set by having been opened, which is also when the
   answer stopped being a guess. */
const probedText = new Set()

const isEditableTextPath = (path) =>
  NOTE_EXT.test(path || '') || isTexPath(path) || isCodePath(path) ||
  probedText.has(path)

/** The name a document is shown under, wherever its own kind is already said
 *  by an icon or a toolbar: the file name with the extension taken off.
 *
 *  Source and data files keep theirs. Their kind is what the icon says, not
 *  which language they are in, and `solve.py` next to `solve.jl` has to stay
 *  two distinguishable rows — see the note beside the tree's own branch. */
const docLabel = (path) =>
  isCodePath(path) || isDataPath(path)
    ? String(path || '').split('/').pop()
    : String(path || '').split('/').pop()
      .replace(isTexPath(path)
        ? TEX_EXT
        : isPdfPath(path)
            ? PDF_EXT
            : isWhiteboardPath(path)
                ? WHITEBOARD_EXT
                : isNotebookPath(path) ? NOTEBOOK_EXT : SITE_EXT, '')
      .replace(NOTE_EXT, '')

/** The name a TAB is shown under: `docLabel`, with the extension taken off the
 *  two kinds that keep theirs elsewhere.
 *
 *  The tree's reason for keeping them does not reach the strip. A row in the
 *  tree sits next to its neighbours, so `solve.py` and `solve.jl` have to stay
 *  told apart there; a tab is the document you are looking at, and the view
 *  under it — a grid, a source editor — has already said which. The full path
 *  stays in the tooltip for the case where two tabs do end up alike. */
const tabLabel = (path) =>
  isCodePath(path) || isDataPath(path)
    ? docLabel(path).replace(/\.[^./]+$/, '')
    : docLabel(path)

/** The tile a row is drawn with: the kind's own mark, tinted with the
 *  language's colour where the kind is a source file and languages.js carries
 *  one for it. Every other kind ignores the tint — see file-icons.js. */
/** The word behind an extension the source list does not carry — `log`, `env`
 *  — for a file that turned out to be text anyway. `text` for a name with no
 *  extension at all, which is the editor's own plain mode. */
const plainToken = (path) => {
  const name = String(path || '').split('/').pop()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : 'text'
}

const docIcon = (kind, path) =>
  fileIcon(kind, kind === 'code' ? { color: languageColor(codeToken(path)) } : {})

/** The `{ path, name, dir, kind }` a document is identified by, from its path. */
function noteRef (path) {
  const rawName = docLabel(path)
  const language = isLanguageTablePath(path)
  const fileIdentity = languageIdentity(rawName)
  const folderIdentity = languageIdentity(path.split('/').slice(-2, -1)[0] || '')
  const identity = language
    ? {
        name: /^vocabulary$/i.test(fileIdentity.name) ? 'Words' : fileIdentity.name,
        flag: fileIdentity.flag || folderIdentity.flag
      }
    : { name: rawName, flag: '' }
  return {
    path,
    name: identity.name,
    flag: identity.flag,
    dir: path.split('/').slice(0, -1).join('/'),
    kind: isPdfPath(path)
      ? 'pdf'
      : isTexPath(path)
          ? 'tex'
      : isSitePath(path)
          ? 'site'
          : isWhiteboardPath(path)
              ? 'whiteboard'
              : isNotebookPath(path)
                  ? 'notebook'
                  : isDataPath(path)
                  ? 'data'
                  /* A file that read as text is a source file for every
                     purpose the app has: the editor holds it, the ordinary
                     save writes it, and none of the note's prose views apply
                     to it. */
                  : (isCodePath(path) || probedText.has(path))
                      ? 'code'
                      : isViewedFilePath(path)
                          ? 'file'
                          : (language ? 'language' : 'note')
  }
}

/* --------------------------------------------------------------- asking */

/* The dialog itself is src/ask.js — a primitive the tree, the context menu,
   the overlays, the attachment sweep and the note history all reach for, and
   mounted here, next to the registry it needs, for that reason: it used to be
   built five thousand lines below its first user, and `mountHistory` capturing
   `confirm: ask` at its own mount time therefore captured nothing at all —
   bundling turns these into `var`, so instead of failing loudly every Restore
   button in the app quietly rejected when pressed. */
const { ask, answer } = mountAsk(el)

/* -------------------------------------------------------------- markdown */

/* The dialect itself is src/markdown.js. All it needs from the app is where a
   relative `<img src>` in raw HTML points, which depends on the note being
   rendered — the same index and folder the note's own embeds resolve against. */
const md = createMarkdown({
  resolveEmbedSrc: (src) => embedSpec(src, {
    resolve: state.resolveAsset,
    dir: state.current?.dir || '',
    // An `<img>` tag says what its target is as plainly as `![](…)` does.
    writtenAsImage: true
  }).url
})

/* ---------------------------------------------------------------- editor */

const editorDeps = {
  parent: el.editorHost,
  onChange: () => {
    // An edit the copilot made is already on disk — the buffer is catching
    // up to the file, not running ahead of it, so there is nothing to save and
    // no reason to show the note as modified.
    if (!state.patching) {
      /* The strip is redrawn on the edge, not on every keystroke: the only
         thing in it an edit can change is the unsaved dot, and that can only
         appear once — after which redrawing it is a rebuild of the whole strip
         per character, ending in a forced layout to measure the overflow. */
      const wasClean = !state.dirty
      state.dirty = true
      if (wasClean) renderTabs()
      queueSave()
      queueDraft()
      if (viewingTex()) scheduleTexCompile()
    }
    queueOutline()
    queueSpelling()
    queueInfo()
  },
  onOpenLink: (link) => {
    if (link.type === 'url') api.openExternal(link.target)
    // An embedded PDF opens in a tab, because the app can now read one. Every
    // other attachment is something another program owns, so it is revealed.
    else if (link.type === 'asset') openAsset(link.target)
    else openWikilink(link.target, { newTab: link.newTab, side: link.side })
  },
  noteNames: () => [
    ...state.files.map((f) => ({ name: f.name, dir: f.dir })),
    ...state.assets
      .filter((path) => ['audio', 'video'].includes(assetKind(path)))
      .map((path) => ({
        name: path.split('/').pop(),
        dir: path.split('/').slice(0, -1).join('/'),
        detail: 'media'
      }))
  ],
  noteTitle: () => state.current?.name || '',
  noteFlag: () => state.current?.flag || '',
  // The title is the filename in every Markdown-backed document, including
  // tables. Keeping it editable here lets a newly created table be named in
  // the document instead of sending the reader back to the file explorer.
  titleEditable: () => true,
  languageTable: viewingLanguageTable,
  // Typing over the title renames the file. Same path the sidebar's row takes,
  // so the links pointing at the old name are chased either way.
  onRename: (name) => { if (state.current) renameNote(state.current, name) },
  // Read at decoration time, so opening a different note re-resolves relative
  // embeds against the folder that note is actually in.
  resolveEmbed: resolveHere,
  resolveNoteEmbed: noteFromName,
  // What the embed picker offers and the inline ghost completes against:
  // every attachment by its vault path, every note by its name. Read at pick
  // and keystroke time, so a file added a moment ago is offered at once.
  embedChoices: () => [
    ...state.assets.map((path) => ({ label: path, name: path })),
    ...state.files
      .filter((f) => NOTE_EXT.test(f.path))
      .map((f) => ({ label: f.name, name: f.name }))
  ],
  /* What `#` completes against. The list lives in the main process, so it is
     fetched rather than held — but held for a moment once fetched, because a
     completion source runs on every keystroke and the answer does not change
     between two letters of the same tag. */
  tagChoices: () => {
    if (Date.now() - tagChoiceCache.at > 15_000) {
      tagChoiceCache = { at: Date.now(), list: api.tags().then((tags) => tags || [], () => []) }
    }
    return tagChoiceCache.list
  }
}

let tagChoiceCache = { at: 0, list: Promise.resolve([]) }

/* ------------------------------------------------------ editor, on demand

   CodeMirror and its grammars are half of everything the renderer compiles
   before it can draw — around 570KB of real code, which is parsed and compiled
   on every launch because Chromium keeps no code cache for a file:// page. A
   note is *read* far more often than it is edited, and reading needs
   markdown-it, not an editor. So the editing stack is fetched the first time
   something needs to edit, and the app opens into the reading view.

   Everything that used to say `editor` still does. What changed is that it
   starts as null, so the rule is:

   - code that only runs with the editing view up may use `editor` directly;
     the view cannot be up without it.
   - anything reachable from the reading view either awaits `ensureEditor()`
     (a deliberate action — switching view, opening find, editing a table) or
     reads the note through `noteText()`, which answers from the buffer below
     until there is an editor to ask.

   The buffer is the second half of that. A note is opened by `openNote`
   whether or not an editor exists, so the text has to live somewhere the
   reading view can reach — and when the editor does arrive it is handed the
   note, the source mode and the raw flag it missed. */
let editor = null
let editorArriving = null
let openSearchPanel = null

/* What the editor would be showing, for as long as there is no editor. Kept in
   step by `openNote` and the patch paths, and handed over on arrival. */
const buffer = { text: '', source: 'markdown', raw: false }

/** The note as text, from the editor when there is one and the buffer when not. */
function noteText () {
  return editor ? docText(editor.state.doc) : buffer.text
}

/**
 * Replace the note's text with a version that arrived from outside — a sync
 * client rewriting the file, or the copilot editing it — and say whether it
 * actually changed anything.
 *
 * A note can be read while it is being rewritten, and reading does not build an
 * editor, so there is not always one to patch. The buffer takes the text
 * instead and hands it over when the editor arrives.
 */
function setDocEmpty () {
  buffer.text = ''
  editor?.setDoc('')
}

function patchDoc (text) {
  if (editor) return editor.patch(text)
  if (buffer.text === text) return false
  buffer.text = text
  return true
}

/** The equations of the note on screen, by the cheapest route available. */
function noteEquations () {
  return editor ? equationsFor(editor.state.doc) : equationIndex(buffer.text)
}

/**
 * Build the editor, once.
 *
 * Awaited by every deliberate act that needs one. Boot also starts it as soon
 * as the first note is on screen, so by the time anybody reaches for it the
 * work is usually already done and this resolves on the spot.
 */
function ensureEditor () {
  if (editor) return Promise.resolve(editor)
  if (editorArriving) return editorArriving
  editorArriving = import('./editor.js').then((mod) => {
    openSearchPanel = mod.openSearchPanel
    const built = mod.createEditor(editorDeps)
    editor = built
    /* Everything it missed while it did not exist. The order matches
       `openNote`: the source mode decides how the text is parsed, so it is
       set before the text. */
    built.setSourceMode(buffer.source)
    built.setDoc(buffer.text)
    built.setRaw(buffer.raw)
    watchLanguageHistoryFocus()
    watchEditorScroll()
    /* Every setting the editor is normally told about at boot — spellcheck,
       line numbers, readable width — was told to nobody. Re-applied here, so a
       lazily built editor is dressed exactly like an eager one. */
    applySettings(state.cfg)
    /* The note may be a language table whose dates were asked for while there
       was no widget to put them on. */
    if (state.current?.path && isLanguageTablePath(state.current.path)) {
      refreshLanguageHistory(state.current.path).catch(() => {})
    }
    /* And the spelling pass the open note was given on the way in, which had
       no parsed document to read and said so. This is the moment it does. */
    if (state.current?.path) renderSpelling()
    return built
  })
  /* A failure here leaves `editor` null for the rest of the session, and every
     caller that merely wanted to know what the note says would go on failing
     one at a time and silently. Said once, plainly, and the promise is dropped
     so a later deliberate act can try the import again. */
  editorArriving.catch((error) => {
    editorArriving = null
    console.error('The editing stack could not be loaded', error)
    toast('The editor could not be loaded. Reading still works; reopen Tulip to try again.')
  })
  return editorArriving
}


/* ----------------------------------------------------- language timestamps

   Dates stay out of the Markdown table. Every completed row receives the same
   small tooltip on each of its cells, and focusing the row repeats it in the
   status bar so keyboard-only editing has the same information as hovering. */
const languageStamp = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'short'
})

function languageHistoryLabel ({ addedAt, editedAt }) {
  if (!addedAt && !editedAt) return ''
  if (!addedAt) return `Edited ${languageStamp.format(new Date(editedAt))}`
  const added = languageStamp.format(new Date(addedAt))
  if (!editedAt || editedAt === addedAt) return `Added ${added}`
  return `Added ${added} · Edited ${languageStamp.format(new Date(editedAt))}`
}

function paintLanguageHistory (rows) {
  /* The dates are painted onto the editing view's table widget. Reading a
     language note builds no editor and no widget, so there is nothing to
     decorate — and the rows are re-asked for when one is built. */
  if (!editor) return
  for (const cell of editor.dom.querySelectorAll('[data-language-history]')) {
    delete cell.dataset.languageHistory
    cell.removeAttribute('title')
  }

  for (const entry of rows || []) {
    const tr = editor.dom.querySelector(
      `.tk-table-wrap[data-language="true"] tbody tr[data-row="${entry.row + 1}"]`
    )
    if (!tr) continue
    const label = languageHistoryLabel(entry)
    if (!label) continue
    for (const cell of tr.querySelectorAll('td')) {
      cell.dataset.languageHistory = label
      cell.title = label
    }
    if (tr.contains(document.activeElement)) setStatusRight(label)
  }
}

async function refreshLanguageHistory (path = state.current?.path) {
  if (!path || !isLanguageTablePath(path)) return paintLanguageHistory([])
  let rows = []
  try { rows = await api.languageHistory.rows(path) } catch { /* dates are supplementary */ }
  if (state.current?.path !== path) return
  paintLanguageHistory(rows)
}

/* Attached when the editor is built rather than at load — see ensureEditor.
   There is no `editor.dom` to listen to until then. */
function watchLanguageHistoryFocus () {
  editor.dom.addEventListener('focusin', (event) => {
    const cell = event.target.closest?.('[data-language-history]')
    if (cell?.dataset.languageHistory) setStatusRight(cell.dataset.languageHistory)
  })
}

/* ------------------------------------------------------------------- pdf */

/**
 * The PDF viewer, mounted once and handed a document at a time.
 *
 * It knows about pages and highlights; everything that makes a document part of
 * the app — which tab holds it, what the status bar says, what the copilot is
 * told — is decided here, the same way it is for a note.
 */
/* The open PDF's own table of contents, as the document declares it. Held here
   rather than asked for on each redraw: resolving every bookmark to a page
   number is work the document only has to do once. */
let pdfContents = []

const pdf = mountPdf({
  host: el.pdf,
  api,
  onDoc: (info) => {
    pdfContents = info.outline
    el.pdfPages.textContent = String(info.pages)
    el.pdfPage.value = String(info.page)
    paintZoom()
    updateStatus()
    renderOutline()
    // A different paper: the tally and the place in it belonged to the last one.
    pdfFind.reset()
  },
  // The tool and the pen also change from inside the viewer — a colour picked
  // in the popup over a selection is the same choice as one picked here.
  onTool: () => paintTools(),
  onPage: (page) => {
    el.pdfPage.value = String(page)
    updateStatus()
    markOutlinePlace()
  },
  onMarks: () => { updateStatus(); renderOutline() },
  // The viewer zooms itself when a pinch or a ⌘-scroll asks it to; the toolbar
  // has to agree with what the pages are actually doing.
  onZoom: () => paintZoom(),
  /* pdf.js has gone quiet twice over and the viewer has stopped trying. Said
     out loud, because a page that simply stays blank looks like a slow one. */
  onStuck: () => toast('This PDF stopped responding. Reopen the tab to try again.'),
  // A failed highlight save is data loss; it must not stay in the console.
  onError: (message) => toast(message),
  // The reader has a passage in hand and wants to talk about it. Opening the
  // panel is part of the gesture — asking for the copilot is asking to see it.
  onAsk: (quote) => {
    copilot.open()
    copilot.quote(quoteFor(quote))
  }
})

/* The compiled half of a TeX workspace. It deliberately has no highlight
   store: this PDF is a disposable build artifact, while the `.tex` source is
   the document the user and Copilot edit. */
let texPdfUrl = ''
const texPdf = mountPdf({
  host: el.texPdf,
  selectionMenu: false,
  api: {
    pdf: {
      source: async () => texPdfUrl,
      marks: { load: async () => [], save: async () => true }
    }
  },
  onStuck: () => toast('Preview stopped responding'),
  onError: (message) => toast(message)
})

const { restoreTexSplit } = mountTexSplit({
  stage: el.stage,
  divider: el.texDivider,
  app: el.app,
  api
})

let texCompileTimer = null
let texCompileGeneration = 0
const TEX_COMPILE_DELAY_MS = 300

function scheduleTexCompile (delay = TEX_COMPILE_DELAY_MS) {
  clearTimeout(texCompileTimer)
  const generation = ++texCompileGeneration
  texCompileTimer = setTimeout(() => compileTex(generation), delay)
}

async function compileTex (generation = ++texCompileGeneration) {
  clearTimeout(texCompileTimer)
  const path = state.current?.path
  if (!path || !viewingTex()) return
  if (state.dirty) await saveNow()
  if (generation !== texCompileGeneration || state.current?.path !== path || !viewingTex()) return

  const result = await api.tex.compile(path).catch((err) => ({ ok: false, error: err.message }))
  if (generation !== texCompileGeneration || state.current?.path !== path || !viewingTex()) return
  if (!result.ok) {
    toast(result.error || 'LaTeX could not compile this document.')
    return
  }

  texPdfUrl = result.url
  try {
    await texPdf.open(path)
  } catch (err) {
    if (generation !== texCompileGeneration) return
    toast(err.message || 'The compiled PDF could not be opened.')
  }
}

/* ⌘F over a PDF. Mounted here beside the viewer it searches, and given the
   stage to dock itself to — the same division the viewer keeps: the module owns
   the bar, this file owns where in the window it goes. */
const pdfFind = mountPdfFind({
  host: el.stage,
  pdf,
  // Closing hands the document back the keys it was answering before the bar
  // took them — the arrows and space scroll the pages again.
  onClose: () => { if (viewingPdf()) el.pdf.focus() }
})

/**
 * The website viewer, mounted once and handed a file at a time.
 *
 * Same division as the PDF's: the module owns the page and the guest it lives
 * in, and everything that makes it a document of this app — the tab, the
 * toolbar, the status bar — is decided here.
 */
const site = mountSite({
  host: el.site,
  api,
  // One callback rather than several, because every one of these changes at
  // once as often as not: a navigation moves the address, the title, both
  // arrows and the loading state in the same breath.
  onState: (view) => {
    paintSiteBar(view)
    updateStatus()
  }
})

/* Loaded only when the first board opens. Excalidraw and React are far larger
   than the document chrome, and a Markdown/PDF session should not parse a
   drawing engine it never uses. */
let whiteboardInstance = null
let whiteboardLoading = null

function ensureWhiteboard () {
  if (whiteboardInstance) return whiteboardInstance
  if (!whiteboardLoading) {
    whiteboardLoading = import('./whiteboard.js').then(async (module) => {
      const { mountWhiteboard, loadWhiteboardStyles } = module
      /* Excalidraw's stylesheet arrives as its own file now rather than inside
         renderer.css — see build.mjs. The module started fetching it as it was
         evaluated, so this is usually already settled; awaiting it here is what
         keeps a board from painting for a frame against a cascade that has not
         arrived. A rejection reaches openViewed, which hands the tab back with
         "That whiteboard could not be opened." — the same outcome as a chunk
         that would not load, and for the same reason. */
      await loadWhiteboardStyles()
      whiteboardInstance = mountWhiteboard({
        host: el.whiteboard,
        file: api.file,
        exportFile: (name, ext, bytes, to) => api.whiteboard.export(name, ext, bytes, to),
        notes: () => state.files.filter((item) => NOTE_EXT.test(item.path)),
        resolveNote: (wanted) => {
          const exact = state.files.find((item) => item.path === wanted && NOTE_EXT.test(item.path))
          if (exact) return exact
          const path = noteFromName(wanted)
          return path ? state.files.find((item) => item.path === path) || { path, name: docLabel(path) } : null
        },
        openNote: (path) => openNote(path, { newTab: true }),
        onDirty: (dirty) => {
          const changed = state.dirty !== dirty
          state.dirty = dirty
          if (changed) renderTabs()
          if (dirty) queueSave()
        },
        /* Says a write landed; it does not say the buffer is clean. The viewer
           owns that and reports it through `onDirty` — a stroke that arrives
           while the atomic write is in flight leaves the board dirty on
           purpose, and clearing the flag here would hide it from the flush
           that quitting depends on. */
        onSaved: () => {
          renderTabs()
          setStatusRight('Saved')
        },
        onStatus: (message) => toast(message),
        theme: () => isDarkTheme(document.documentElement.dataset.theme) ? 'dark' : 'light'
      })
      return whiteboardInstance
    }).finally(() => { whiteboardLoading = null })
  }
  return whiteboardLoading
}

/* Loaded when the first table opens, on the same reasoning as the whiteboard:
   a session of notes and PDFs should not compile a grid it never shows. */
let dataInstance = null
let dataLoading = null

function ensureData () {
  if (dataInstance) return dataInstance
  if (!dataLoading) {
    dataLoading = import('./csv.js').then(({ mountCsv }) => {
      dataInstance = mountCsv({
        host: el.data,
        file: api.file,
        // A `.csv` cannot hold its own column widths, so they are kept beside
        // it and put back when it opens.
        layout: api.tableWidths,
        /* The same bargain the whiteboard makes: the viewer owns the document
           and reports what it is doing with it, and the tab strip, the save
           queue and the status line are the renderer's answer to that. */
        onDirty: (isDirty) => {
          const changed = state.dirty !== isDirty
          state.dirty = isDirty
          if (changed) renderTabs()
          if (isDirty) queueSave()
        },
        /* A write landed, not "the grid is clean" — see the whiteboard's own
           note above. `onDirty` is the only thing that speaks for the buffer. */
        onSaved: () => {
          renderTabs()
          setStatusRight('Saved')
          updateStatus()
        },
        /* A grid says things a table cannot show for itself — what a sort
           wrote, how many rows a delete took — and the status line is where
           the rest of the app says them. */
        onStatus: (message) => setStatusRight(message),
        /* What the selection adds up to belongs beside the table's shape
           rather than in the transient line, because it is true for as long
           as the selection is. The grid works it out; this only asks the
           status line to read it again. */
        onSelection: () => updateStatus()
      })
      return dataInstance
    }).finally(() => { dataLoading = null })
  }
  return dataLoading
}

/* Loaded when the first notebook opens, on the same terms as the grid. An
   `.ipynb` brings a markdown renderer and a highlighter with it, and a session
   of notes and PDFs should build neither for a file it never opens. */
let notebookInstance = null
let notebookLoading = null

function ensureNotebook () {
  if (notebookInstance) return notebookInstance
  if (!notebookLoading) {
    notebookLoading = import('./notebook.js').then(({ mountNotebook }) => {
      notebookInstance = mountNotebook({
        host: el.notebook,
        file: api.file,
        /* The app's own dialect, handed in rather than rebuilt: a formula in a
           notebook's prose is set exactly as one in a note is, and `prepare`
           is what gets KaTeX here before the first cell is drawn. */
        markdown: {
          prepare: (text) => prepareMath(text),
          render: (text) => md.render(text),
          /* And the second half of rendering, which the notebook had no way to
             ask for. `md.render` leaves every picture as a stub for
             `dressEmbeds` to swap — that is how the reading view draws one —
             so a notebook that only called `render` drew markdown cells with
             holes where their images should be, whether the image was a file
             beside the notebook or one pasted into the cell. */
          dress: (node) => dressEmbeds(node)
        },
        /* Running cells. The bridge is handed in the same way the file access
           is, so the viewer names what it needs and the renderer decides what
           that is — and a window built without it simply has no Run button. */
        kernel: {
          start: (path, wanted) => api.kernel.start(path, wanted),
          execute: (path, code) => api.kernel.execute(path, code),
          interrupt: (path) => api.kernel.interrupt(path),
          restart: (path) => api.kernel.restart(path),
          shutdown: (path) => api.kernel.shutdown(path),
          specs: () => api.kernel.specs(),
          /* The answer to an `input()`, and the two questions Tab and ⇧Tab ask
             about the code under the caret. Only the live kernel can answer
             those: `df.` completes to that DataFrame's columns, and nothing
             readable from the file would say so. */
          input: (path, value) => api.kernel.input(path, value),
          complete: (path, code, at) => api.kernel.complete(path, code, at),
          inspect: (path, code, at) => api.kernel.inspect(path, code, at),
          on: (fn) => api.on('kernel:event', fn)
        },
        /* The one question a notebook has to stop and ask — a restart throws
           away every variable in the session — asked in the app's own dialog
           rather than not at all. */
        ask,
        notify: (text) => toast(text),
        /* The same bargain the grid makes: the viewer owns the document and
           reports what it is doing with it, and the tab strip, the save queue
           and the status line are the renderer's answer to that. */
        onDirty: (isDirty) => {
          const changed = state.dirty !== isDirty
          state.dirty = isDirty
          if (changed) renderTabs()
          if (isDirty) queueSave()
        },
        /* A write landed. Whether the notebook is clean afterwards is the
           notebook's to say — a kernel putting output into a cell during the
           write leaves it dirty — and it says so through `onDirty`. */
        onSaved: () => {
          renderTabs()
          setStatusRight('Saved')
        },
        // The shape of the notebook is what the status bar says about it, and
        // adding or deleting a cell changes it.
        onStatus: () => updateStatus()
      })
      return notebookInstance
    }).finally(() => { notebookLoading = null })
  }
  return notebookLoading
}

/* The viewer of last resort — a picture, a recording, or a card describing
   what Tulip cannot show. Loaded on the same terms as the two above: a session
   that opens no such file never builds it. */
let fileViewInstance = null
let fileViewLoading = null

function ensureFileView () {
  if (fileViewInstance) return fileViewInstance
  if (!fileViewLoading) {
    fileViewLoading = import('./fileview.js').then(({ mountFileView }) => {
      fileViewInstance = mountFileView({
        host: el.fileview,
        file: api.file,
        onStatus: (message) => setStatusRight(message),
        onWarn: (message) => toast(message)
      })
      return fileViewInstance
    }).finally(() => { fileViewLoading = null })
  }
  return fileViewLoading
}

/**
 * The website toolbar, from the viewer's own account of where it is.
 *
 * The address field is left alone while it has the caret: it is a text field
 * someone may be halfway through typing into, and a page that finishes loading
 * underneath them must not reach in and rewrite what they have written.
 */
function paintSiteBar (view) {
  if (!viewingSite()) return

  if (document.activeElement !== el.siteAddress) el.siteAddress.value = view.url || ''

  el.siteBack.disabled = !view.canBack
  el.siteForward.disabled = !view.canForward
  el.siteReload.classList.toggle('is-loading', view.loading)
  el.siteReload.title = view.loading ? 'Stop loading' : 'Reload (⌘R)'
  el.siteReload.setAttribute('aria-label', view.loading ? 'Stop loading' : 'Reload')
  el.siteSave.hidden = !view.drifted
  el.siteOpen.disabled = !view.url
}

/** A highlighted passage as the message it becomes: where it is, then what it
 *  says, so the question that follows has both. */
function quoteFor (quote) {
  const where = `page ${quote.page} of ${state.current?.name || 'this PDF'}`
  return `On ${where}:\n\n> ${quote.text.replace(/\n+/g, ' ')}\n\n`
}

/** The zoom control's own label: the percentage, or that it is following the
 *  window. */
function paintZoom () {
  const zoom = pdf.zoom()
  el.pdfFit.textContent = zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`
  // Marked only when the reader has set a size themselves; fitting the window
  // is the resting state and does not need pointing at.
  el.pdfFit.classList.toggle('is-set', zoom !== 'fit')
  el.pdfFit.title = zoom === 'fit'
    ? 'Fitting the window'
    : 'Back to fitting the window (0)'
}

/**
 * Resize the document on screen, and say so on its toolbar.
 *
 * Every way of asking comes through here — the toolbar, the bare +/− keys, and
 * the window's own zoom keys once a PDF has claimed them — because the size and
 * the readout of the size must never be set apart from each other.
 *
 * @param {1|-1|'fit'} step  in one stop, out one stop, or back to fitting
 */
function zoomDoc (step) {
  /* A website answers the same keys, and for the same reason: the guest carries
     a zoom of its own that the window's cannot reach, so ⌘+ over a page has to
     be handed to the page or it does nothing a reader can see. It has no
     readout to repaint — the size of a web page is a thing you look at, not a
     number to check. */
  if (viewingSite()) { site.setZoom(step); return }
  if (viewingWhiteboard()) { whiteboardInstance?.zoom(step); return }
  if (!viewingPdf()) return
  pdf.setZoom(step)
  paintZoom()
}

/**
 * The palette on the toolbar, built from the viewer's own list of pens.
 *
 * A button per colour rather than a menu: five colours is a thing to point at,
 * and the one in hand should be legible from across the toolbar without being
 * opened. `mousedown` is swallowed so reaching for a pen does not throw away
 * the selection the reader may be about to draw over.
 */
const pdfPens = new Map()
for (const colour of MARK_COLORS) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'pdf-pen'
  b.dataset.color = colour.id
  b.title = `${colour.label} highlighter`
  b.setAttribute('aria-label', `${colour.label} highlighter`)
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', () => pdf.setPen(colour.id))
  el.pdfPens.append(b)
  pdfPens.set(colour.id, b)
}

/** The toolbar saying which tool is in hand and which colour is in it. */
function paintTools () {
  const marking = pdf.tool() === 'mark'
  el.pdfToolSelect.classList.toggle('is-on', !marking)
  el.pdfToolMark.classList.toggle('is-on', marking)
  el.pdfToolSelect.setAttribute('aria-pressed', String(!marking))
  el.pdfToolMark.setAttribute('aria-pressed', String(marking))
  // Dimmed rather than hidden with the arrow in hand: the pens still say what
  // the popup will offer first, and a control that comes and goes is a control
  // to hunt for.
  el.pdfPens.classList.toggle('is-idle', !marking)
  const pen = pdf.pen()
  for (const [id, b] of pdfPens) b.classList.toggle('is-on', id === pen)
}

el.pdfToolSelect.addEventListener('click', () => pdf.setTool('select'))
el.pdfToolMark.addEventListener('click', () => pdf.setTool('mark'))
paintTools()

el.pdfPrev.addEventListener('click', () => pdf.goToPage(pdf.page() - 1))
el.pdfNext.addEventListener('click', () => pdf.goToPage(pdf.page() + 1))
/* One direction only: the button goes back to fitting, whatever size the page
   is at. It reads as the size — "Fit", or the per cent a pinch or a keystroke
   left it at — and clicking it puts that reading back to Fit. Actual size is
   what the keyboard is for. */
el.pdfFit.addEventListener('click', () => zoomDoc('fit'))

/* The PDF's contents and the reader's highlights share the sidebar's outline
   pane — see renderPdfOutline. It has no button of its own on this toolbar:
   ⌘⇧E opens it, the same shortcut a note's outline answers to. */

/* Typing a page number goes there; anything else puts the real page back, so
   the box is never left showing a page nobody is on. */
el.pdfPage.addEventListener('change', () => {
  const wanted = Number(el.pdfPage.value.trim())
  if (Number.isFinite(wanted) && wanted >= 1) pdf.goToPage(wanted)
  el.pdfPage.value = String(pdf.page())
})
el.pdfPage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.pdfPage.blur() }
  if (e.key === 'Escape') { el.pdfPage.value = String(pdf.page()); el.pdfPage.blur() }
})

/* ------------------------------------------------- the website's toolbar */

el.siteBack.addEventListener('click', () => site.back())
el.siteForward.addEventListener('click', () => site.forward())
// The one button a browser gives two jobs: while the page is on its way in,
// pressing it is how you stop waiting for it.
el.siteReload.addEventListener('click', () => {
  if (el.siteReload.classList.contains('is-loading')) site.stop()
  else site.reload()
})
el.siteSave.addEventListener('click', () => {
  site.saveHome()
  setStatusRight('This file now points here')
})
el.siteOpen.addEventListener('click', () => {
  if (site.url()) api.openExternal(site.url())
})

/* Typing an address is how a website file is pointed somewhere else, so this
   field commits to disk — see goTo in site.js, which is where that decision
   lives. Escape puts back where the page actually is, so the bar is never left
   showing an address nobody is at. */
el.siteAddress.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    el.siteAddress.value = site.url()
    el.siteAddress.blur()
    return
  }
  if (e.key !== 'Enter') return
  e.preventDefault()
  const typed = el.siteAddress.value
  if (await site.goTo(typed)) el.siteAddress.blur()
  // Said rather than silently refused: a typo in an address bar looks exactly
  // like a page that is taking its time.
  else if (typed.trim()) setStatusRight('That is not a web address')
})

// The whole address at once, the way every browser answers a click here: what
// you do with an address you have clicked into is replace it.
el.siteAddress.addEventListener('focus', () => el.siteAddress.select())
el.siteAddress.addEventListener('blur', () => paintSiteBar(site.state()))

function queueSave () {
  clearTimeout(state.saveTimer)
  /* A keystroke while a merge is being settled does not arm an autosave that
     would then dismiss the panel underneath the reader — the merge owns the
     save until it is resolved. */
  if (mergeOpen) return
  state.saveTimer = setTimeout(saveNow, Number(state.cfg.autosave) || 600)
}

/* ---------------------------------------------------------------- drafts

   A copy of the unsaved buffer, kept outside the vault so that a crash, a kill
   or a power cut cannot take the last few seconds of typing with it. The store
   itself is main's (see the drafts section there); this is only about when to
   write one and when to throw it away.

   On a timer of its own rather than on the autosave's: the two exist for
   opposite reasons. The autosave waits, because writing the note on every
   keystroke would make the vault's history and every watcher downstream
   unusable. A draft has no such cost — nothing watches it and nothing syncs it
   — so it runs short and steadily, and the ordinary case is that the real save
   lands first and deletes it before it is ever needed. */
const DRAFT_MS = 1200
let draftTimer = null
let draftPath = null

function queueDraft () {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(writeDraft, DRAFT_MS)
}

async function writeDraft () {
  clearTimeout(draftTimer)
  const path = state.current?.path
  if (!path || !state.dirty || viewingPdf() || viewingSite() || !isEditableTextPath(path)) return
  draftPath = path
  await api.draft.save(path, editor.state.doc.toString()).catch(() => {})
}

/**
 * Forget the draft for a note whose text is now safely on disk.
 *
 * Takes the path explicitly because the note on screen may already have moved
 * on by the time a save resolves — the draft to drop is the one belonging to
 * the file that was written, not to whatever is being looked at now.
 */
function clearDraft (path) {
  clearTimeout(draftTimer)
  if (!path) return
  if (draftPath === path) draftPath = null
  api.draft.clear(path).catch(() => {})
}

/* Rebuilding the outline means re-scanning the note, which is not something to
   do on every keystroke — a heading only ever appears between them. */
let outlineTimer = null
function queueOutline () {
  if (!outlineOpen()) return
  clearTimeout(outlineTimer)
  outlineTimer = setTimeout(renderOutline, 250)
}

/**
 * The house style, applied to the buffer on the way to disk — the rules and the
 * reasoning behind them are in src/lint.js.
 *
 * On save rather than on every keystroke, and as an ordinary edit rather than a
 * replacement of the document: the caret, the selection, the scroll position and
 * the undo history all come through it, and ⌘Z steps back over the lint the way
 * it steps back over anything else.
 *
 * An edit that touches the selection is left for the next save. Pressing Enter
 * twice makes exactly the run of blank lines rule 1 collapses, and closing it up
 * from under the caret of someone who is still typing into it is the one way
 * this could be more annoying than the mess it fixes. *Lint current file* in the
 * palette is the way to have it anyway.
 */
function lintBuffer () {
  // A PDF has no text to lint and a website file holds an address, not markdown.
  if (viewingTex() || viewingPdf() || viewingSite() || viewingWhiteboard()) return

  /* Nothing to tidy without one: this runs on the way to a save, and a note
     nobody has typed into is a note nobody can have made untidy. */
  if (!editor) return

  const { selection } = editor.state
  const changes = lintEdits(editor.state.doc.toString()).filter(
    (edit) => !selection.ranges.some((range) => edit.from <= range.to && edit.to >= range.from))
  if (!changes.length) return

  editor.dispatch({ changes, userEvent: 'input.lint' })
}

async function saveNow () {
  clearTimeout(state.saveTimer)
  if (!state.current || !state.dirty) return
  if (viewingWhiteboard()) {
    try { await whiteboardInstance?.save() } catch (err) {
      toast(err.message || 'Could not save this whiteboard.')
    }
    return
  }
  if (viewingData()) {
    try { await dataInstance?.save({ flush: true }) } catch (err) {
      toast(err.message || 'Could not save this table.')
    }
    return
  }
  if (viewingNotebook()) {
    try { await notebookInstance?.save({ flush: true }) } catch (err) {
      toast(err.message || 'Could not save this notebook.')
    }
    return
  }
  /* An explicit save while a merge is on screen settles it as "keep mine" and
     then writes the buffer — the autosave is what the panel owns, and the
     autosave is already refused in queueSave. A tab switch, a note switch or
     the window closing has to get the buffer to disk, whatever is open. The
     panel's own buttons take their own path; this one just stands it down. */
  if (mergeOpen) {
    mergePanel.close()
    mergeOpen = false
  }
  const wrote = state.current.path
  /* Before the document is read, not after: what goes to disk and what is in the
     buffer have to be the same text, or the identity test below never holds and
     the note is written twice for every save. */
  lintBuffer()
  const doc = editor.state.doc
  try {
    await api.file.write(wrote, doc.toString())
    /* A keystroke can land while the write is in flight. It sets dirty again
       and queues its own save — and clearing the flag unconditionally here
       would make that queued save find a "clean" note and return without
       writing, losing the edit for good. The flag is only cleared while the
       buffer is still exactly what went to disk, in the note it went to;
       CodeMirror's documents are immutable, so identity is the whole test. */
    if (editor.state.doc === doc && state.current?.path === wrote) {
      state.dirty = false
      const tab = activeTab()
      if (tab && tab.path === wrote) tab.base = doc.toString()
      renderTabs()
      setStatusRight('Saved')
      /* The note is on disk, so the copy kept against a crash has nothing left
         to protect. Only on this branch: if a keystroke landed mid-write the
         buffer has run ahead of the file again, and the draft is once more the
         only record of the difference. */
      clearDraft(wrote)
    }
    /* The pane beside the editor may be showing the very note that was
       written — the watcher never hears about the app's own saves, so it is
       told here. */
    refreshSidePane(wrote)
    if (isLanguageTablePath(wrote)) {
      await refreshLanguageHistory(wrote)
    }
  } catch (err) {
    toast(err.message || 'Could not save this note.')
  }
}

/**
 * The whole file linted now, caret and all, and saved.
 *
 * What `lintBuffer` holds back, deliberately: the blank line the caret is sitting
 * in, and — for a file nobody has edited — everything, since a file that is never
 * saved is never linted either. This is asked for rather than incidental, so it
 * has no reason to hold anything back.
 */
/**
 * Whether there is a newer Tulip, said once and acted on by hand.
 *
 * There is no updater, and the answer to a new version is still to download it
 * and replace the app — see the README. What this removes is the part that was
 * genuinely missing: a way to find out at all, short of visiting the repository
 * and reading tags.
 *
 * Everything about the request is in main; this is the sentence it becomes.
 */
async function checkForUpdate () {
  setStatusRight('Checking for updates…')
  const answer = await api.checkForUpdate().catch(() => null)
  setStatusRight('')

  if (!answer?.ok) {
    toast(`Could not check for updates — ${answer?.reason || 'the request failed'}.`)
    return
  }
  if (!answer.newer) {
    toast(`Tulip ${answer.current} is the latest version.`)
    return
  }

  const go = await ask({
    title: `Tulip ${answer.latest} is available.`,
    detail: `This copy is ${answer.current}. Updating means downloading the new ` +
      'version and replacing the app — Tulip does not update itself.',
    go: 'Open the download page'
  })
  if (go && answer.url) api.openExternal(answer.url)
}

async function lintFile () {
  if (!state.current || viewingTex() || viewingPdf() || viewingSite() || viewingWhiteboard()) return
  /* Asked for from the palette, which is open in the reading view as often as
     anywhere else — and tidying a note is an edit, so it needs the editor that
     holds the undo history the tidy should be undoable from. */
  const view = await ensureEditor()
  const changes = lintEdits(view.state.doc.toString())
  if (!changes.length) { setStatusRight('Already tidy'); return }
  view.dispatch({ changes, userEvent: 'input.lint' })
  saveNow()
}

/* ------------------------------------------------------------------ tree */

function flatten (nodes, dir = '') {
  const out = []
  for (const node of nodes) {
    if (node.type === 'folder') out.push(...flatten(node.children, node.path))
    else out.push({ ...node, dir })
  }
  return out
}

/* Unit separator rather than NUL, for the signatures built in this file. Both
   are impossible in a filename and so either would do the job, but a single NUL
   anywhere in a file makes grep call the whole thing binary and go quiet —
   which, in the largest file here, means a search for a function silently finds
   nothing. Main signs the vault with the same character, for the same reason;
   see snapshotRevision in electron/main.js. */
const SHAPE_SEP = '\x1f'

/**
 * Re-read the vault and redraw whatever actually moved.
 *
 * The sidebar is rebuilt only when the tree changed: an outside edit to one
 * note — a sync client, or the copilot working through a run of them — leaves
 * every row exactly as it was, and redrawing regardless meant every node in
 * the vault, two SVGs and four listeners apiece, for nothing.
 *
 * That test used to be made here, over a tree this had just received in full.
 * It is made in the main process now (see snapshotRevision), against the walk
 * it has to do anyway, and the revision it hands back stands for the tree and
 * the attachment list together — so an unchanged vault costs one small string
 * instead of a structured clone of the whole of it. `unchanged` is the answer
 * to the revision we sent, so there is nothing to apply and nothing to redraw.
 */
async function loadTree () {
  const answer = await api.vault.snapshot(state.revision)
  if (answer.unchanged) return

  /* A vault that is closed, or gone, answers without one. Held as an empty
     object rather than left undefined so the comparisons below stay total —
     and so the next call sends nothing to match, which is right: there is no
     drawn state to keep. */
  const revision = answer.revision || {}
  const before = state.revision || {}
  const { tree, assets } = answer
  /* The tree as it is drawn right now. `patchTree` diffs the old against the
     new, so it has to be captured before state.tree is overwritten. */
  const oldTree = state.tree
  state.revision = answer.revision || null
  state.tree = tree
  state.files = flatten(tree)

  /* The two halves are guarded apart, because they move apart: pasting an
     image adds an attachment and not a row, and rebuilding the sidebar for it
     would be the very redraw this exists to avoid.

     They can also move together — a rename carries a note and the `.images/`
     folder named after it — and each half used to redraw the open document as
     it finished. Two full renders for one snapshot, and a reading render is
     46ms of which 29 is the HTML parse. `redraw` collects the answer from both
     and pays for it once, below. */
  let redraw = false

  if (revision.tree !== before.tree) {
    /* Before the redraw, not after: a note that arrived with `aliases` in its
       head changes what every `[[…]]` in the vault resolves to, and refreshing
       afterwards would draw the links once with the old answer. */
    await refreshAliases()
    patchTree(oldTree, tree)
    /* A note created or renamed may have turned a missing `![[Note]]` into a
       transclusion, or the reverse — the note resolver just changed its
       answer. The same move applyAssets makes when an attachment lands. */
    redraw = true
  }

  if (applyAssets(assets, revision.assets, { defer: true })) redraw = true

  if (redraw) refreshDocument()
}

/**
 * Draw the open document again, in whichever view is showing it.
 *
 * Both reasons to do this — the notes a `[[link]]` can resolve to, and the
 * attachments an `![[embed]]` can resolve to — are answered by the same
 * snapshot, so they are one redraw and not two.
 *
 * `rerenderReading` rather than `renderReading`: it keeps the line the reader
 * was on. The asset half used to call the latter and lose the scroll position,
 * which was never a decision so much as the shorter name.
 */
function refreshDocument () {
  editor?.refresh()
  if (reading()) rerenderReading()
}

/**
 * The vault's attachments. Kept apart from the note tree because they are not
 * navigable things — nothing lists them — they exist so an embed can be
 * resolved by whatever name the note happened to use.
 *
 * Answers whether the list actually moved, so a caller holding a second
 * reason to redraw can fold this one into it. `defer` leaves the redraw to
 * that caller; without it the attachments are applied and drawn here, which is
 * what a standalone refresh after writing one wants.
 */
function applyAssets (next, revision, { defer = false } = {}) {
  /* The common case is that nothing about the attachments moved, and rebuilding
     the index and redrawing both views regardless would re-run every decoration
     in the open note for no change at all.
   *
   * `revision` is main's signature for this same list, which loadTree already
   * has; only the callers that hold a bare array — the refresh after writing an
   * attachment — pay to derive a key from it. */
  const key = revision || next.join('\n')
  if (key === state.assetsKey) return false
  state.assetsKey = key
  state.assets = next
  state.resolveAsset = assetIndex(next)

  // A new attachment may have made an embed resolvable that was not before.
  if (!defer) refreshDocument()
  return true
}

/** Re-read the attachment list — after writing one, where waiting for the
 *  watcher would show the embed as missing for a frame. Off the snapshot, the
 *  one listing the main process serves: the separate assets-only endpoint this
 *  once called was consolidated away, and the stale name made every paste
 *  throw *after* writing the file — the picture landed in the vault and the
 *  `![[…]]` that names it never reached the note. */
const loadAssets = async () => applyAssets((await api.vault.snapshot()).assets)

/* Ids for the groups a folder owns. A counter rather than the folder's path:
   a path is not a legal id fragment, and nothing outside this file looks these
   up by name. */
let treeGroupSerial = 0

function renderTree () {
  el.tree.replaceChildren(buildLevel(state.tree, 0))
  /* The row the arrow keys left off at may have gone — a rename, a delete, a
     folder shut over it. Falling back to the open note, then to the first row,
     keeps exactly one row tabbable, which is what makes the tree one stop. */
  if (!el.tree.querySelector('.row[tabindex="0"]')) {
    const fallback =
      el.tree.querySelector('.row.is-active') || el.tree.querySelector('.row[data-path]')
    if (fallback) {
      fallback.tabIndex = 0
      state.treeFocus = fallback.dataset.path
    }
  }
  paintFoldToggle()
}

/**
 * Redraw only the rows a snapshot change actually moved.
 *
 * `renderTree` rebuilds every visible row — two SVG clones, a file icon and
 * half a dozen listeners apiece — so a vault of a thousand open rows paid for
 * a thousand fresh rows to draw one new note. `diffTrees` (src/tree-diff.js)
 * says which levels moved and which rows within them changed; this applies
 * that answer to the live DOM, row by row, and leaves everything else exactly
 * as it was — listeners, focus, drag state and all. The wholesale rebuild
 * stays for the callers with no old tree to diff against, which is every
 * caller but a snapshot refresh: a folder toggle, the fold-all command and a
 * rename all end in renderTree().
 *
 * The first draw is a diff too: `before` starts as the empty tree, so every
 * row is an insertion, which is exactly what a first draw is.
 */
function patchTree (before, after) {
  const levels = diffTrees(before, after)
  const replacedFolders = new Set()

  for (const { parent, children, replace } of levels) {
    /* A replaced folder row was rebuilt together with its children container
       (buildLevel draws them as a pair), so the level that container owns is
       already new — reconciling it would be diffing the new children against
       themselves. */
    if (replacedFolders.has(parent)) continue
    const container = parent === ''
      ? el.tree
      : el.tree.querySelector(`.children[data-for="${cssEscape(parent)}"]`)
    /* A closed folder's container is empty by design — buildLevel does not
       draw what it would be told to hide — so a change inside one is drawn
       the next time it opens, by the renderTree() that opening triggers. */
    if (!container || (parent !== '' && !container.classList.contains('is-open'))) continue
    const depth = parent === '' ? 0 : parent.split('/').length
    patchLevel(container, children, replace, depth, replacedFolders)
  }

  /* The two invariants renderTree leaves behind, so a patched tree ends the
     same way a rebuilt one would: exactly one row tabbable, and the fold-all
     button reading the tree it is drawn over. */
  if (!el.tree.querySelector('.row[tabindex="0"]')) {
    const fallback =
      el.tree.querySelector('.row.is-active') || el.tree.querySelector('.row[data-path]')
    if (fallback) {
      fallback.tabIndex = 0
      state.treeFocus = fallback.dataset.path
    }
  }
  paintFoldToggle()
}

/**
 * Bring one level of the tree in line with its new snapshot: drop the rows
 * that are gone, rebuild the rows whose record moved, build the new ones in
 * place. Rows that were already right are not touched.
 */
function patchLevel (container, children, replace, depth, replacedFolders) {
  const byPath = new Map()
  for (const row of container.querySelectorAll('.row[data-path]')) {
    byPath.set(row.dataset.path, row)
  }
  const keep = new Set()
  for (const node of children) keep.add(node.path)

  /* Removals first, so the rows the pass below walks are the ones that stay. */
  for (const row of byPath.values()) {
    if (keep.has(row.dataset.path)) continue
    const kids = row.nextElementSibling
    if (kids && kids.classList.contains('children')) kids.remove()
    row.remove()
  }

  /* Then the new order, one pass: keep, replace or insert as each row needs.
     Both lists are sorted the same way, so a single cursor over the drawn
     rows places every insertion where the sort puts it. */
  const drawn = [...container.querySelectorAll('.row[data-path]')]
  let cursor = 0
  for (const node of children) {
    const row = byPath.get(node.path)
    if (row) {
      if (replace.has(node.path)) {
        if (node.type === 'folder') {
          replacedFolders.add(node.path)
          const kids = row.nextElementSibling
          if (kids && kids.classList.contains('children')) kids.remove()
        }
        row.replaceWith(buildLevel([node], depth))
      }
      cursor++
      continue
    }

    /* A new row: placed where the sort puts it, before the first drawn row
       that sorts after it, or at the end of the level. */
    while (cursor < drawn.length && compareTreeNodes(node, rowIdentity(drawn[cursor])) > 0) {
      cursor++
    }
    const frag = buildLevel([node], depth)
    if (cursor < drawn.length) drawn[cursor].before(frag)
    else container.append(frag)
  }
}

/** The sort key of a drawn row: its type, and the label that shows its name. */
function rowIdentity (row) {
  const label = row.querySelector('.label')
  return { type: row.dataset.type, name: label ? label.textContent : row.dataset.path }
}

/* ------------------------------------------------------ tree keyboard

   The arrow keys, as every file tree on the desktop has them: ↑↓ move, → opens
   a folder and then steps into it, ← shuts one and then steps out to the parent.
   The rest of what a row answers to — ↵ to rename, ⌘↵ to open, the context menu
   key — is wired per row in buildLevel, next to the row it belongs to.
   ================================================================== */

/** The rows the arrows can reach: what is drawn, which is what is visible. */
function treeRows () {
  return [...el.tree.querySelectorAll('.row[data-path]')]
}

/** Move the tree's single tab stop, and the focus with it. */
function focusTreeRow (row) {
  if (!row) return
  for (const other of el.tree.querySelectorAll('.row[tabindex="0"]')) other.tabIndex = -1
  row.tabIndex = 0
  state.treeFocus = row.dataset.path
  row.focus()
}

/** The same, by path — for after a renderTree has replaced every row. */
function focusTreePath (path) {
  focusTreeRow(el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`))
}

/** The folder row a row sits inside, or null at the top level. */
function parentRowOf (path) {
  const at = path.lastIndexOf('/')
  if (at === -1) return null
  return el.tree.querySelector(`.row.is-folder[data-path="${cssEscape(path.slice(0, at))}"]`)
}

function wireTreeKeys () {
  el.tree.addEventListener('keydown', (event) => {
    // A row being renamed holds an input, and the arrows belong to the text.
    if (event.target.closest('input, textarea')) return
    const row = event.target.closest('.row[data-path]')
    if (!row) return
    const path = row.dataset.path
    const isFolder = row.dataset.type === 'folder'
    const open = isFolder && state.expanded.has(path)

    const step = (by) => {
      const rows = treeRows()
      const at = rows.indexOf(row)
      if (at === -1) return
      focusTreeRow(rows[Math.min(rows.length - 1, Math.max(0, at + by))])
    }

    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); step(1); return
      case 'ArrowUp': event.preventDefault(); step(-1); return
      case 'Home': {
        event.preventDefault()
        focusTreeRow(treeRows()[0])
        return
      }
      case 'End': {
        event.preventDefault()
        const rows = treeRows()
        focusTreeRow(rows[rows.length - 1])
        return
      }
      case 'ArrowRight': {
        event.preventDefault()
        /* Open, then — on a second press — step inside. A folder that is
           already open has nothing left to do but move, and a file has no
           inside at all. */
        if (isFolder && !open) { toggleFolder(path); focusTreePath(path); return }
        step(1)
        return
      }
      case 'ArrowLeft': {
        event.preventDefault()
        if (isFolder && open) { toggleFolder(path); focusTreePath(path); return }
        focusTreeRow(parentRowOf(path))
      }
    }
  })
}

/* ------------------------------------------------------ fold everything

   One button for both directions. Two would mean one of them was always the
   wrong thing to press — from a tree that is already shut there is nothing to
   collapse — and a pair of near-identical chevron icons side by side is a pair
   to squint at. Which direction this one means is read from the tree every time
   it is drawn, so it can never offer what has just happened.
   ================================================================== */

/** Every folder in the vault, at any depth. */
function allFolders (nodes, out = []) {
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    out.push(node.path)
    allFolders(node.children, out)
  }
  return out
}

/**
 * Which way the button points, and whether there is anything for it to do.
 *
 * Any folder open at all counts as open, rather than all of them: a tree with
 * one folder still showing is a tree the reader can see something to shut, and
 * a button offering to open what is already open would be reading the vault
 * differently from the way they are.
 */
function paintFoldToggle () {
  if (!el.foldAll) return
  const folders = allFolders(state.tree)
  const anyOpen = folders.some((path) => state.expanded.has(path))
  // A vault of loose notes has no folders on screen to fold.
  el.foldAll.hidden = !folders.length
  el.foldAll.classList.toggle('is-shut', !anyOpen)
  const label = anyOpen ? 'Collapse all folders' : 'Expand all folders'
  el.foldAll.title = label
  el.foldAll.setAttribute('aria-label', label)
}

/** Every folder open, or every folder shut — whichever the tree is not. */
function toggleAllFolders () {
  const folders = allFolders(state.tree)
  if (!folders.length) return
  const shutting = folders.some((path) => state.expanded.has(path))
  /* Replaced rather than added to or pruned. The set can hold paths from a
     folder that has since been renamed or deleted, and either answer here is
     the whole truth about the tree that is actually on screen. */
  state.expanded = shutting ? new Set() : new Set(folders)
  api.config.set({ expanded: [...state.expanded] })
  renderTree()
  // Shutting the tree can take the open note's row off screen with it; the row
  // is still the active one, and scrolling back to it is not wanted here.
  markActiveRow()
}


function buildLevel (nodes, depth) {
  const frag = document.createDocumentFragment()

  for (const node of nodes) {
    const row = document.createElement('div')
    row.className = `row ${node.type === 'folder' ? 'is-folder' : 'is-file'}`
    // A PDF sits among the notes and is opened the same way, so what marks it
    // out is a badge on the row rather than a section of its own.
    if (node.kind === 'pdf') row.classList.add('is-pdf')
    if (node.kind === 'language') row.classList.add('is-language')
    row.style.paddingLeft = `${7 + depth * 13}px`
    row.dataset.path = node.path
    row.dataset.type = node.type
    row.setAttribute('role', 'treeitem')
    row.setAttribute('aria-level', String(depth + 1))
    /* One stop for the whole tree, not one per row. A vault of four hundred
       notes was four hundred presses of Tab to get past the sidebar; the arrow
       keys move within it instead — see wireTreeKeys — which is how every other
       tree on the desktop behaves. */
    row.tabIndex = node.path === state.treeFocus ? 0 : -1
    row.draggable = true
    wireDrag(row, node)

    /* `svgIcon` parses each shape once and hands back a clone, so a vault of a
       thousand rows costs one parse for the twist and one per file kind. */
    row.append(svgIcon('<path d="M4.5 3 8 6l-3.5 3"/>',
      { viewBox: '0 0 12 12', className: 'twist', stroke: 1.4 }))

    if (node.type !== 'folder') row.append(docIcon(node.kind, node.path))

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = node.name
    row.append(label)

    if (node.type === 'folder') {
      const open = state.expanded.has(node.path)
      if (open) row.classList.add('is-open')
      if (state.picked.has(node.path)) row.classList.add('is-picked')
      row.setAttribute('aria-expanded', String(open))
      row.setAttribute('aria-selected', String(state.picked.has(node.path)))
      row.addEventListener('click', (e) => clickRow(node, e))
      frag.append(row)

      const kids = document.createElement('div')
      kids.className = `children${open ? ' is-open' : ''}`
      kids.dataset.for = node.path
      /* The rows a folder contains are its siblings in the DOM — the twist and
         the indent do the nesting visually — so the relationship a screen
         reader needs is stated rather than implied. */
      kids.setAttribute('role', 'group')
      kids.id = `tree-group-${treeGroupSerial++}`
      row.setAttribute('aria-owns', kids.id)
      /* A closed folder's rows are `display: none` and are built again the
         moment it opens — every path that changes what is expanded ends in
         another renderTree() — so building them now is work that is thrown
         away. On a vault whose folders are mostly closed, which is how one
         looks when it is first opened, this was almost all of the rebuild. */
      if (open) kids.append(buildLevel(node.children, depth + 1))
      frag.append(kids)
    } else {
      if (state.current?.path === node.path) row.classList.add('is-active')
      if (state.picked.has(node.path)) row.classList.add('is-picked')
      row.setAttribute('aria-selected', String(state.picked.has(node.path)))
      row.addEventListener('click', (e) => clickRow(node, e))
      /* Middle-click opens in a new tab. ⌘-click is already spoken for here —
         it extends the selection, the way it does in a file manager — so the
         other button people already use for this is the one left. */
      row.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return
        e.preventDefault()
        openNote(node.path, { newTab: true }).then(() => revealInTree(node.path))
      })
      frag.append(row)
    }

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showContextMenu(e, node)
    })
    row.addEventListener('keydown', (e) => {
      /* ↵ renames, the way it does in the Finder — and the way the row's own
         context menu has always claimed it does. Opening is what clicking the
         row is for, so the key is free to mean the other thing; ⌘↵ keeps the
         old meaning for anyone who reached for it. F2 is the same command
         under the name the rest of the desktop gives it. */
      if (e.key === 'F2' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault()
        beginRename(node, row)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        node.type === 'folder' ? toggleFolder(node.path) : openNote(node.path)
        return
      }
      /* The menu key, and ⇧F10 for the keyboards without one. Everything the
         row's context menu offers — reveal, move, duplicate, trash — was
         reachable only by right-clicking it. Positioned over the row itself,
         since there is no pointer to put it under. */
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault()
        const box = row.getBoundingClientRect()
        showContextMenu({
          clientX: box.left + 12,
          clientY: box.bottom,
          keyboard: true,
          preventDefault: () => {}
        }, node)
      }
    })
  }

  return frag
}

/* --------------------------------------------------------- multi-select */

/**
 * File paths in the order they are currently on screen. Read from the DOM
 * rather than the tree model because a shift-range should span what the user
 * can actually see — rows inside a collapsed folder are not in between.
 */
/**
 * Every row on screen, in the order they are read.
 *
 * Folders included. A shift-range is drawn between two things the user can
 * see, and a tree is mostly folders — a range that silently skipped them
 * selected the wrong set, or, in a folder-only stretch, nothing at all.
 *
 * The rows of a closed folder are not built at all (see buildLevel), so what
 * the DOM holds is exactly what is visible, already in order.
 */
function visibleRows () {
  return [...el.tree.querySelectorAll('.row[data-path]')].map((r) => r.dataset.path)
}

/**
 * A selection with anything already carried by a selected folder taken out.
 *
 * Trashing or moving a folder takes its contents with it, so naming both the
 * folder and a file inside it asks for that file twice — and the second ask
 * fails, on a file that in fact went exactly where it was told.
 */
function topLevelOnly (paths) {
  const all = [...paths]
  return all.filter((p) => !all.some((other) => other !== p && p.startsWith(other + '/')))
}

function markPicked () {
  for (const row of el.tree.querySelectorAll('.row[data-path]')) {
    row.classList.toggle('is-picked', state.picked.has(row.dataset.path))
  }
  const count = state.picked.size
  setStatusRight(count > 1 ? `${count} selected` : '')
}

function clearPicked () {
  if (!state.picked.size) return
  state.picked.clear()
  state.pickAnchor = null
  markPicked()
}

/**
 * Shift extends from the anchor, Cmd/Ctrl toggles one, a plain click selects
 * one and opens it — the conventions from Finder and every file tree people
 * already use.
 */
/**
 * A click on any row in the tree, with whatever was held down.
 *
 * One function for files and folders, because a selection spans both: shift
 * draws a range between two rows whatever they happen to be, and ⌘ adds or
 * removes one. Only a plain click carries the row's own action with it —
 * opening a note, or opening a folder — since a click that is building a
 * selection is not a click that means "take me there", and a folder that
 * expanded every time it was added to a range would move the very rows the
 * range was measured against. A plain folder click only expands or collapses:
 * the filled resting highlight belongs to the file actually open in the app,
 * not to a container that was used to reach it.
 */
function clickRow (node, event) {
  const path = node.path
  const rows = visibleRows()

  if (event.shiftKey && state.pickAnchor) {
    const from = rows.indexOf(state.pickAnchor)
    const to = rows.indexOf(path)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from]
      state.picked = new Set(rows.slice(lo, hi + 1))
      /* The range's far end becomes current without disturbing the anchor, so
         a second shift-click re-extends from the same place rather than from
         where the last one landed. markPicked runs after the open as well as
         before it, because opening a note clears the status line the count is
         written into. */
      if (node.type === 'file') openNote(path).then(markPicked)
      markPicked()
      return
    }
  }

  if (event.metaKey || event.ctrlKey) {
    state.picked.has(path) ? state.picked.delete(path) : state.picked.add(path)
    state.pickAnchor = path
    markPicked()
    return
  }

  if (node.type === 'folder') {
    state.picked.clear()
    state.pickAnchor = null
    markPicked()
    toggleFolder(path)
    return
  }

  state.picked = new Set([path])
  state.pickAnchor = path
  markPicked()
  openNote(path)
}

el.tree.addEventListener('mousedown', (e) => {
  if (e.target === el.tree) clearPicked()
})

/* Double-clicking a name edits it: the gesture every file manager answers to,
   and the one people try first. One listener for the whole tree rather than one
   per row — the rows are rebuilt often enough that a closure each is a cost
   with nothing to show for it, and the row already carries what it is. */
el.tree.addEventListener('dblclick', (e) => {
  const label = e.target.closest?.('.label')
  const row = label?.closest('.row')
  if (!row) return
  e.preventDefault()
  beginRename({ type: row.dataset.type, path: row.dataset.path, name: label.textContent }, row)
})

const carriesFiles = (e) => !!e.dataTransfer?.types?.includes('Files')

/** A drag carrying files from outside the app rather than rows from inside it. */
const fromOutside = (e) => !state.dragging && carriesFiles(e)

el.tree.addEventListener('dragover', (e) => {
  if (fromOutside(e)) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    el.tree.classList.add('is-drop-target')
    return
  }
  if (!state.dragging) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
})

el.tree.addEventListener('dragleave', (e) => {
  if (e.target === el.tree) el.tree.classList.remove('is-drop-target')
})

el.tree.addEventListener('drop', (e) => {
  el.tree.classList.remove('is-drop-target')
  if (fromOutside(e)) {
    e.preventDefault()
    // A drop that missed every row means the vault root.
    importFrom(e, e.target.closest?.('.row.is-folder')?.dataset.path || '')
    return
  }
  if (e.target !== el.tree) return
  e.preventDefault()
  moveInto('')
})

/* ------------------------------------------------------------- dragging */

/**
 * Dragging a row that is part of the multi-selection moves the whole
 * selection; dragging anything else moves just that row. Folders accept drops,
 * and so does the tree's empty space, which means the vault root.
 */
function wireDrag (row, node) {
  row.addEventListener('dragstart', (event) => {
    const paths = state.picked.has(node.path) && state.picked.size > 1
      ? topLevelOnly(state.picked)
      : [node.path]
    state.dragging = paths
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', paths.join('\n'))
    if (node.type === 'file' && NOTE_EXT.test(node.path)) {
      event.dataTransfer.setData('application/x-tulip-note', node.path)
    }
    row.classList.add('is-dragging')
  })

  row.addEventListener('dragend', () => {
    state.dragging = null
    row.classList.remove('is-dragging')
    for (const el of document.querySelectorAll('.is-drop-target')) {
      el.classList.remove('is-drop-target')
    }
  })

  if (node.type !== 'folder') return

  row.addEventListener('dragover', (event) => {
    if (fromOutside(event)) {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      row.classList.add('is-drop-target')
      return
    }
    if (!state.dragging || !canDropInto(node.path)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    row.classList.add('is-drop-target')
  })
  row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'))
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    event.stopPropagation()
    row.classList.remove('is-drop-target')
    if (fromOutside(event)) { importFrom(event, node.path); return }
    moveInto(node.path)
  })
}

/**
 * Notes dragged in from Finder. The drop target decides where they land, the
 * same as dragging a row already in the tree — a folder takes them, empty
 * space means the vault root.
 */
async function importFrom (event, destDir) {
  if (!state.vault) { connectVault(); return }

  const sources = [...(event.dataTransfer?.files || [])]
    .map((file) => api.pathForFile(file))
    .filter(Boolean)
  if (!sources.length) return

  let result
  try {
    result = await api.file.import(destDir, sources)
  } catch (err) {
    toast(err.message || 'Those files could not be brought in.')
    return
  }

  const { imported, skipped, first } = result
  if (destDir) state.expanded.add(destDir)
  await loadTree()

  if (first) {
    await openNote(first)
    revealInTree(first)
    state.picked = new Set([first])
    markPicked()
  }

  const where = destDir || 'the vault'
  if (!imported) {
    toast(skipped ? 'Only markdown files can be brought in this way.' : 'Nothing to bring in.')
  } else {
    const what = imported === 1 ? 'Added 1 note to' : `Added ${imported} notes to`
    toast(skipped ? `${what} ${where} · ${skipped} skipped` : `${what} ${where}`)
  }
}

/**
 * The folders `paths` could be moved into, as picker items.
 *
 * Moving was a drag and nothing else, which is a gesture some people cannot
 * make and nobody can make between two folders that are not on screen at the
 * same time. The same rules the drop obeys are applied here — a folder cannot
 * receive itself or anything it already holds — so the list offers only moves
 * that would actually happen.
 */
/** The folder picker, over whatever was named — a row, a selection, the open note. */
function openMovePicker (paths) {
  const wanted = (paths || []).filter(Boolean)
  if (!wanted.length) { toast('Nothing to move.'); return }
  if (!moveDestinations(wanted).length) {
    toast('There is nowhere else to move that.')
    return
  }
  openOverlay('move-to', { paths: wanted })
}

function moveDestinations (paths) {
  const wanted = paths.filter(Boolean)
  const holds = (dir) => wanted.every((p) => {
    if (p === dir || dir.startsWith(p + '/')) return false
    return p.split('/').slice(0, -1).join('/') !== dir
  })

  const items = []
  if (holds('')) items.push({ path: '', label: state.vault?.name || 'Vault root' })
  for (const dir of allFolders(state.tree)) {
    if (holds(dir)) items.push({ path: dir, label: dir })
  }
  return items
}

/** A folder cannot receive itself, nor anything already sitting in it. */
function canDropInto (destDir) {
  return (state.dragging || []).some((p) => {
    if (p === destDir || destDir.startsWith(p + '/')) return false
    return p.split('/').slice(0, -1).join('/') !== destDir
  })
}

/**
 * Move documents into a folder.
 *
 * `paths` is explicit for the callers that are not a drag — the row menu and
 * the palette both name what they are moving — and defaults to what is being
 * dragged, which is how a drop still calls this with nothing but its target.
 */
async function moveInto (destDir, paths = state.dragging || []) {
  state.dragging = null
  if (!paths.length) return

  // Unsaved edits go to disk before the move rewrites linking notes from
  // their files — a stale buffer would win the race back. See renameNote.
  if (state.dirty) await saveNow()

  const moved = []
  const rewritten = []
  let relinked = 0
  for (const path of paths) {
    if (path === destDir || destDir.startsWith(path + '/')) continue
    try {
      const { path: next, links, rewritten: edited = [] } = await api.file.move(path, destDir)
      moved.push({ from: path, to: next })
      rewritten.push(...edited)
      retraceHistory(path, next)
      relinked += links
    } catch (err) {
      toast(err.message || `“${path}” could not be moved.`)
    }
  }
  if (!moved.length) return

  // The open note may have been one of them; follow it to its new home.
  const followed = moved.find((m) => m.from === state.current?.path)
  if (followed) {
    state.current = noteRef(followed.to)
    renderTabs()
    sessionOnly({ lastNote: followed.to })
  }
  /* The open note may be one of the rewritten: its own writes no longer come
     back through the watcher, so the buffer is told to catch up here. */
  if (rewritten.includes(state.current?.path)) await reloadCurrent()

  state.picked = new Set(moved.map((m) => m.to))
  state.pickAnchor = null
  if (destDir) state.expanded.add(destDir)
  await loadTree()
  markPicked()
  const where = destDir || 'the vault root'
  const what = moved.length === 1 ? `Moved to ${where}` : `Moved ${moved.length} items to ${where}`
  toast(relinked ? `${what} · ${linkNote(relinked)}` : what)
}

/** Wording for however many notes had to be edited to keep their links valid. */
function linkNote (count) {
  return count === 1 ? 'Updated links in 1 note' : `Updated links in ${count} notes`
}

function toggleFolder (path) {
  state.expanded.has(path) ? state.expanded.delete(path) : state.expanded.add(path)
  api.config.set({ expanded: [...state.expanded] })
  renderTree()
}

/**
 * Move the tree's is-active mark to the open document's row, touching nothing
 * else. Opening a note changes exactly one fact about the tree — which row is
 * lit — and rebuilding every row in the vault to state it was the single most
 * expensive thing a click on a note did. The full rebuild stays for the cases
 * that change the tree's shape; this is for the ones that do not.
 */
function markActiveRow () {
  for (const row of el.tree.querySelectorAll('.row.is-active')) row.classList.remove('is-active')
  if (!state.current) return
  el.tree.querySelector(`.row.is-file[data-path="${cssEscape(state.current.path)}"]`)
    ?.classList.add('is-active')
}

function revealInTree (path) {
  const parts = path.split('/')
  parts.pop()
  let acc = ''
  let opened = false
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    if (!state.expanded.has(acc)) { state.expanded.add(acc); opened = true }
  }
  /* A folder that was closed has to be drawn open, which is a rebuild. When
     the way there is already open — the common case, since revealing follows
     almost every note opened — the row is on screen and only the mark moves. */
  if (opened) renderTree()
  else markActiveRow()
  el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}

/**
 * revealInTree assumes the tree is on screen; a menu item cannot. Bring the
 * Files pane up first — which opens the sidebar too if it is closed — and only
 * then unfold the way to the document and scroll its row into view.
 */
function showInFileExplorer (path) {
  togglePane('files', true)
  revealInTree(path)
}

const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'))

/* ------------------------------------------------------------- open/save */

/**
 * Opens whatever the vault holds at `path`, in the tab that is current.
 *
 * The one door in: the tree, the tabs, the history, wikilinks and the switcher
 * all come through here, so which kind of document it is has to be decided here
 * rather than by each of them. Everything about *being open* — the tab, the
 * trail, the tree's highlight, the copilot's conversation — is the same for a
 * note and for a PDF; only the pane that shows it differs.
 */
async function openNote (path, opts = {}) {
  if (isPdfPath(path)) return openPdf(path, opts)
  if (isSitePath(path)) return openSite(path, opts)
  if (isWhiteboardPath(path)) return openWhiteboard(path, opts)
  if (isDataPath(path)) return openData(path, opts)
  if (isNotebookPath(path)) return openNotebook(path, opts)
  /* A file of no kind Tulip knows. Which door it goes through is decided by
     what is actually in it rather than by what it is called: a `.log`, a
     `.env`, a `.rtf` and a file with no extension at all are text, and text
     belongs in the editor. Only the bytes can say so — see `file:probe` — and
     everything that fails that test goes to the viewer. */
  if (isViewedFilePath(path)) {
    const probe = await api.file.probe(path).catch(() => null)
    if (probe?.ok && probe.text) {
      probedText.add(path)
      return openText(path, opts)
    }
    /* A file that was text and is not any more — overwritten by something
       else while the app held it — must not be left claiming to be editable,
       or the next repaint puts a binary in the editor. */
    probedText.delete(path)
    return openFile(path, opts)
  }
  /* A source file goes down the same road as a note: it is text the vault owns
     and edits. Only its grammar differs, and `openText` reads that off the
     path. */
  return openText(path, opts)
}

/**
 * The bookkeeping every kind shares, done in the order it has to be done in:
 * the place being left is recorded while the pane still holds it, and only then
 * does the tab change hands.
 */
function enterDoc (path, { history, newTab }) {
  markPlace()

  if (newTab || !state.tabs.length) {
    // Opened beside the tab it came from rather than at the end of the strip:
    // a link followed into a new tab belongs next to what linked to it.
    state.tabs.splice(state.tabIndex + 1, 0, blankTab())
    state.tabIndex++
  }
  activeTab().path = path
  if (history) pushHistory(path)

  state.current = noteRef(path)
  /* The contents belong to the document being left. A PDF's own outline arrives
     a moment after it opens, and until it does the panel would otherwise be
     showing the last PDF's bookmarks under this one's name. */
  pdfContents = []
  state.dirty = false
  el.empty.hidden = true
  el.stage.classList.add('has-doc')
}

/**
 * Once a document is on screen, whichever kind it is.
 *
 * `chat: false` opens the document without handing the conversation over. Only
 * the copilot asks for that, and only about its own edits: it is mid-turn on
 * one note when it writes to another, and switching transcripts underneath a
 * reply still arriving would leave the answer being written into a chat nobody
 * asked the question in.
 */
function settleDoc (path, { chat = true } = {}) {
  renderTabs()
  // Opening a document never changes the tree's shape, only which row is lit.
  markActiveRow()
  setStatusRight('')
  // The copilot's transcript follows the document, so switching here switches
  // the conversation too.
  if (chat) copilot.setNote(path)
  renderOutline()
  renderLinks()
  renderSpelling()
  renderInfo()
  rememberTabs()
  sessionOnly({ lastNote: path })
}

/**
 * Close whichever viewer the outgoing document was in, before the tab changes
 * hands. Each of them is holding something that belongs to the file being left
 * — a parsed PDF and a pending write of its highlights, or a guest process with
 * a live page in it — and none of that should outlive the tab pointing at it.
 */
async function leaveDoc () {
  /* Before the teardown, not after. The place a tab was left at is read from
     the viewer that is holding it, and a closed viewer has nothing left to
     say — `enterDoc` marks the place too, but by then the page it would have
     asked about is gone. */
  markPlace()
  cancelReadingWarmup()
  stopReadingHighlights({ reset: true })
  if (viewingTex()) {
    clearTimeout(texCompileTimer)
    texCompileGeneration++
    await texPdf.close()
  } else if (viewingPdf()) await pdf.close()
  else if (viewingSite()) site.close()
  else if (viewingWhiteboard()) await whiteboardInstance?.close()
  else if (viewingData()) await dataInstance?.close()
  else if (viewingNotebook()) await notebookInstance?.close()
  /* Not merely hidden: the pane may be holding a playing video, and a
     recording that goes on playing over the note you switched to is the whole
     reason this viewer is torn down rather than left in place. */
  else if (viewingFile()) fileViewInstance?.close()
}

async function openText (path, { focus = true, history = true, place = null, newTab = false, chat = true } = {}) {
  if (state.dirty) await saveNow()

  let text
  try {
    text = await api.file.read(path)
  } catch {
    toast('That note could not be opened. Refreshing the vault.')
    await loadTree()
    return false
  }

  const tex = isTexPath(path)
  const code = isCodePath(path) || probedText.has(path)
  /* Maths is a Markdown feature. A `$` in a shell script is a variable and one
     in a TeX file is the source's own, so neither is scanned for equations —
     which also keeps a large source file off the slowest thing done on open. */
  if (!tex && !code) await prepareMath(text).catch(() => {})

  if (isLanguageTablePath(path)) {
    const normalized = normalizeLanguageTable(text)
    if (normalized !== text) {
      await api.file.write(path, normalized)
      text = normalized
    }
  }

  /* The buffer is set before anything is torn down or drawn, and deliberately
     before `enterDoc`: entering a document paints the view, the reading view
     renders from this buffer, and a buffer still holding the last note — or
     nothing at all — is a blank page. Worse than blank: an editor built from an
     empty buffer will happily autosave that emptiness over the file. */
  /* The grammar to colour the file with: `tex`, the word behind a source
     file's extension — `py`, `jl`, `cpp` — or Markdown for a note. The editor
     resolves that word to a parser; an extension no parser is carried for
     opens as plain text in the code face, which is still the file. */
  /* A file with no extension the editor carries a parser for — a `.log`, a
     `.env` — hands over its extension anyway: the editor falls back to plain
     text in the code face, which is what such a file should look like, and the
     day a parser for that word is added it starts being coloured. */
  buffer.source = tex ? 'tex' : (code ? (codeToken(path) || plainToken(path)) : 'markdown')
  buffer.text = text

  await leaveDoc()

  enterDoc(path, { history, newTab })
  if (editor) {
    editor.setSourceMode(buffer.source)
    editor.setDoc(text)
  }
  if (isLanguageTablePath(path)) await refreshLanguageHistory(path)
  // The buffer and the disk agree from here: this is the version the edits to
  // come are measured against, if a sync client rewrites the note meanwhile.
  const opened = activeTab()
  if (opened) opened.base = text
  // Boot establishes the saved view before the note is opened, so the fresh
  // editor state starts in that view instead of always building preview first.
  editor?.setRaw(state.view === 'raw')
  applyPanes()

  // Returning to a file with an unaccepted Copilot review restores both its
  // coloured diff and its change navigator.
  const pendingReview = pendingAgentDiffs.get(path)
  if (pendingReview) {
    if (reading()) setView('edit')
    editor?.showAgentDiff(pendingReview.before, pendingReview.after)
  }

  if (place) {
    editor?.dispatch({ selection: { anchor: Math.min(place.at || 0, text.length) } })
    /* The editing view's own scroller, and only while it is the one showing:
       restoring a pixel offset into a hidden editor moved nothing a reader
       could see, and the line below is what the reading view answers to. */
    if (editor && !reading()) editor.scrollDOM.scrollTop = place.top || 0
  }

  updateStatus()
  if (reading()) renderReading()
  if (focus && !reading()) editor?.focus()
  /* After the page is built, because there is nothing to scroll until then. */
  if (place?.line > 1 && reading()) restoreReadingPlace(place.line)

  settleDoc(path, { chat })
  if (tex) scheduleTexCompile(0)
  // Nothing to warm: a source file has no reading view to build ahead of time.
  else if (!code) scheduleReadingWarmup()
  return true
}

/**
 * Put a viewed document — a PDF, a website — on screen in the current tab.
 *
 * The tab is claimed before the document is read, unlike a note: parsing a
 * hundred-page PDF, or reaching a page across a network, takes long enough that
 * leaving the previous one on screen meanwhile reads as a click that did
 * nothing. Which means the recovery below matters — a document that never
 * arrives has to hand the tab back rather than leave it pointing at nothing.
 *
 * @param viewer.show     puts the document up; throwing is a failure to open
 * @param viewer.failed   what to say when it does
 * @param viewer.focus    where the caret goes once it is up
 */
async function openViewed (path, { focus = true, history = true, place = null, newTab = false, chat = true }, viewer) {
  if (state.dirty) await saveNow()

  const previous = state.current
  // What the strip looked like before the attempt, so a failure can put it back:
  // `enterDoc` may open a tab, and the count is what says whether it did.
  const tabsBefore = state.tabs.length
  const indexBefore = state.tabIndex
  await leaveDoc()
  enterDoc(path, { history, newTab })
  // Held by identity, not by position — the document is read with the tab
  // already on screen, and the strip can move under a slow one.
  const opened = state.tabs.length > tabsBefore ? activeTab() : null
  // Emptied so the editor is not holding a note that is no longer open — the
  // outline, the word count and the copilot all read from it.
  setDocEmpty()
  applyPanes()
  settleDoc(path, { chat })

  try {
    await viewer.show(path, place)
  } catch (err) {
    toast(err.message || viewer.failed)
    /* Put the strip back where it was rather than leaving a tab pointing at a
       document that never appeared. A tab opened for the attempt goes with it:
       ⌘-clicking a link to an unreadable PDF used to leave the new tab behind
       showing the note the old one was already showing, and the trail of the
       tab it came from orphaned under it. */
    const at = opened ? state.tabs.indexOf(opened) : -1
    if (at !== -1) {
      state.tabs.splice(at, 1)
      state.tabIndex = Math.min(indexBefore, Math.max(0, state.tabs.length - 1))
    }
    const tab = activeTab()
    if (tab) tab.path = previous?.path || null
    state.current = previous ? noteRef(previous.path) : null
    if (previous) await openNote(previous.path, { focus: false, history: false })
    else { applyPanes(); closeCurrentNote() }
    renderTabs()
    return false
  }

  updateStatus()
  if (focus) viewer.focus()
  return true
}

function openPdf (path, opts = {}) {
  return openViewed(path, opts, {
    show: (p, place) => pdf.open(p, place),
    failed: 'That PDF could not be opened.',
    focus: () => el.pdf.focus()
  })
}

/**
 * A website file, put on screen as the page it names.
 *
 * Unlike a PDF, a failure to *load* is not a failure to open, and so never
 * reaches the recovery above: the file opened fine and it is the page that
 * would not come, which `site.open` resolves normally and says so in the tab —
 * with the address still in the bar to correct, and Try again beneath it.
 * Handing the tab back to the previous document would take away the one screen
 * that can do anything about it. Only an unreadable file throws.
 */
function openSite (path, opts = {}) {
  return openViewed(path, opts, {
    show: (p, place) => site.open(p, place),
    failed: 'That website could not be opened.',
    /* A file with no address yet is a file waiting to be told one, so the caret
       goes where the telling happens. With an address it goes to the page,
       which is what the arrow keys and the scroll wheel should reach. */
    focus: () => { if (site.home()) site.focus(); else el.siteAddress.focus() }
  })
}

function openWhiteboard (path, opts = {}) {
  return openViewed(path, opts, {
    show: async (p, place) => (await ensureWhiteboard()).open(p, place),
    failed: 'That whiteboard could not be opened.',
    focus: () => whiteboardInstance?.focus()
  })
}

/**
 * A separated-values file, put on screen as its table.
 *
 * A viewed kind rather than a text one: there is nothing here for the editor
 * to hold. The grid is the document — see the account at the top of csv.js.
 */
function openData (path, opts = {}) {
  return openViewed(path, opts, {
    show: async (p, place) => {
      const grid = await ensureData()
      /* Told which view it is in before the file lands in it, so a table
         opened while the preference says "read" is never briefly editable. */
      grid.setReadonly(state.view === 'read')
      return grid.open(p, place)
    },
    failed: 'That table could not be opened.',
    focus: () => dataInstance?.focus()
  })
}

/**
 * A Jupyter notebook, put on screen as its cells.
 *
 * A viewed kind, like the table: the file is JSON and the document is what the
 * JSON encodes, so there is nothing here for the editor to hold. A file that
 * will not parse throws, and `openViewed` hands the tab back — better than a
 * blank notebook pane that would autosave its own emptiness over the file.
 */
function openNotebook (path, opts = {}) {
  return openViewed(path, opts, {
    show: async (p, place) => {
      const book = await ensureNotebook()
      // Told which view it is in before the file lands in it, so a notebook
      // opened while the preference says "read" is never briefly editable.
      book.setReadonly(state.view === 'read')
      return book.open(p, place)
    },
    failed: 'That notebook could not be opened.',
    focus: () => notebookInstance?.focus()
  })
}

/**
 * A file the vault has no view of its own for, put on screen as what can be
 * shown of it: the picture, the player, or the card that says plainly there is
 * no viewer for this and offers the desktop's.
 *
 * A viewed kind, like the table and the board — there is nothing here for the
 * editor to hold, and nothing to save.
 */
function openFile (path, opts = {}) {
  return openViewed(path, opts, {
    show: async (p) => (await ensureFileView()).open(p),
    failed: 'That file could not be opened.',
    focus: () => fileViewInstance?.focus()
  })
}

/* A raw preference, set aside while a language table is open. The grid has no
   raw source mode, so the view has to give way — but the preference is the one
   every other document opens in, and opening a table is not the user changing
   their mind about it. Writing 'edit' to the config from here, which is what
   this used to do, lost the setting for the vault and not just for the table. */
let heldView = null

const showView = (view) => {
  state.view = view
  el.app.dataset.view = view
  editor?.setRaw(view === 'raw')
}

/**
 * Which pane the stage is showing.
 *
 * A note has three views and the other two kinds have one each, so the two
 * facts — the view the user chose and the kind of document open — are read
 * together here rather than each pane being hidden and unhidden from a dozen
 * places.
 */
function applyPanes () {
  const pdfOpen = viewingPdf()
  const texOpen = viewingTex()
  const siteOpen = viewingSite()
  const whiteboardOpen = viewingWhiteboard()
  const codeOpen = viewingCode()
  const dataOpen = viewingData()
  const notebookOpen = viewingNotebook()
  const fileOpen = viewingFile()
  /* The chosen view, minus whatever the document on screen cannot give it. Two
     things take it away: a table has no raw source mode, and a locked file has
     only its reading view. Both set the preference aside in `heldView` rather
     than writing over it, so the next ordinary note opens in the view the user
     actually chose — and unlocking, or opening a note again, hands it straight
     back without the config ever having been touched.

     A table — the language kind, a `.csv` or a notebook — is Reading or
     Editing, so a held 'raw' gives way to Editing while one is open, and its
     editable grid is entered rather than the backing pipes briefly shown. */
  const want = heldView ?? state.view
  const tabular = viewingLanguageTable() || dataOpen || notebookOpen
  const show = lockedHere() ? 'read' : (tabular && want === 'raw' ? 'edit' : want)
  heldView = show === want ? null : want
  if (state.view !== show) showView(show)
  /* Whether the note's own panes are on screen at all. None of the viewed
     kinds has any use for them, so they all answer the same way. A source file
     is not one of them — it uses the editor, and only its extra views are
     withheld. */
  const text = viewingText()
  /* The kinds shown as source: the editor pane, and nothing else the note
     chrome offers. TeX is the one of them that also has a preview beside it. */
  const sourceOnly = texOpen || codeOpen
  el.stage.classList.toggle('is-tex', texOpen)
  el.texDivider.hidden = !texOpen
  el.texPreview.hidden = !texOpen
  el.pdf.hidden = !pdfOpen
  // The find bar is docked to the stage rather than to the PDF, so it has to be
  // told when the document it was searching is no longer the one on screen —
  // left open it would be a bar over a note, searching a paper nobody can see.
  if (!pdfOpen) pdfFind.close()
  el.site.hidden = !siteOpen
  el.whiteboard.hidden = !whiteboardOpen
  el.data.hidden = !dataOpen
  el.notebook.hidden = !notebookOpen
  el.fileview.hidden = !fileOpen
  el.reading.hidden = !text || sourceOnly || state.view !== 'read'
  el.editorHost.hidden = !text || (!sourceOnly && state.view === 'read')
  el.pdfTools.hidden = !pdfOpen
  el.siteTools.hidden = !siteOpen
  /* The switch is for the documents with more than one view of themselves: the
     note's three, and the table's two — a `.csv` is read and edited in the same
     grid, and which of the two it is in is this control. */
  el.viewSwitch.hidden = (!text && !dataOpen && !notebookOpen) || sourceOnly
  if (dataOpen) dataInstance?.setReadonly(state.view === 'read')
  if (notebookOpen) notebookInstance?.setReadonly(state.view === 'read')
  updateViewControl()
  el.studyStart.hidden = !viewingLanguageTable()
  paintKeyboard()
  /* A pinch over a PDF belongs to the PDF, and one over a page belongs to the
     page — a guest keeps a zoom of its own, and the window zooming underneath
     it would resize the chrome around a page that stayed exactly as it was.
     Claimed here rather than in either viewer's own wheel handler because the
     window's zoom is applied in the main process, which never sees the event
     the page prevented. */
  api.zoom.claim?.(pdfOpen || siteOpen || whiteboardOpen)
  paintZoomBadge()
  el.app.dataset.kind = state.current?.kind || 'note'
  syncSidebarPaneAvailability()
}

/** An attachment a note embeds or links to. The vault reads PDFs itself; for
 *  everything else the right answer is the program that owns the format. */
function openAsset (relPath) {
  if (isPdfPath(relPath)) openNote(relPath)
  else api.file.reveal(relPath)
}

/* One small player for timestamped `[[lecture.mp3#t=12:35]]` links. It is
   deliberately transient: the timestamp belongs to the Markdown link, not to
   a playlist or a sidecar record. */
let mediaDock = null

function openTimedMedia (spec) {
  mediaDock?.remove()

  const dock = document.createElement('div')
  dock.className = `media-dock is-${spec.kind}`
  const head = document.createElement('div')
  head.className = 'media-dock-head'
  const label = document.createElement('span')
  label.textContent = spec.label
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'media-dock-close'
  close.textContent = '×'
  close.title = 'Close player'
  close.setAttribute('aria-label', 'Close player')
  head.append(label, close)

  const player = renderEmbed(spec)
  dock.append(head, player)
  document.body.append(dock)
  mediaDock = dock
  close.addEventListener('click', () => {
    player.pause?.()
    dock.remove()
    if (mediaDock === dock) mediaDock = null
  })
  player.addEventListener('loadedmetadata', () => player.play().catch(() => {}), { once: true })
}

/* ----------------------------------------------------------------- tabs

   A tab is a note and the trail that led to it. Keeping the history inside the
   tab is what makes two of them independent: following links in one leaves the
   other exactly where it was, which is the whole reason to have two.
   ================================================================== */

const activeTab = () => state.tabs[state.tabIndex] || null

/** A tab holding nothing — what ⌘T opens, and what is left standing when the
 *  last note is closed, so the strip is never empty. */
const blankTab = () => ({ path: null, history: [], historyAt: -1, base: null, pinned: false })

/* The version a tab's buffer diverged from — set whenever the buffer and the
   disk are known to agree: on opening a note, on saving one, and when the
   watcher pulls a changed file back in. The three-way merge of a note someone
   else rewrote while it was being edited reads from it, so "ours" means the
   edits since the last agreement and "theirs" means the disk's. */
const tabBase = (tab) => tab?.base ?? null

function renderTabs () {
  const frag = document.createDocumentFragment()

  state.tabs.forEach((tab, i) => {
    const active = i === state.tabIndex
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `tab${active ? ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''}`
    // The folder a note sits in is the tooltip rather than the label: the strip
    // has to stay readable at eight tabs, and the name is what identifies it.
    button.title = tab.pinned ? `${tab.path} — pinned` : (tab.path || 'New tab')

    const label = document.createElement('span')
    label.className = 'tab-label'
    label.textContent = tab.path ? tabLabel(tab.path) : 'New tab'
    button.append(label)

    // The unsaved dot belongs to the note, so only the tab actually holding
    // unsaved text shows one.
    if (active && state.dirty) {
      const dot = document.createElement('span')
      dot.className = 'tab-dirty'
      dot.title = 'Unsaved changes'
      button.append(dot)
    }

    /* A pinned tab carries a mark where an ordinary one carries its close ×,
       so the swap reads as what it is: this tab is held open instead of being
       one click from gone. Both of the quick ways to close — the × and the
       middle click — are withheld from it; the menu still offers Close tab,
       because pinning is a guard against the accidental gesture and not a lock
       the reader has to undo before they can act. */
    if (tab.pinned) {
      const pin = document.createElement('span')
      pin.className = 'tab-pin'
      pin.append(svgIcon('<path d="M9.5 2.5 13 6M11 4.5 7.5 8v3L5 8.5 2.5 11h3L8.5 8"/>', { stroke: 1.3 }))
      button.append(pin)
    } else {
      /* A span rather than a button: a button inside a button is invalid, and
         the browser's own hit-testing stops working when you nest them. */
      const close = document.createElement('span')
      close.className = 'tab-close'
      close.setAttribute('role', 'button')
      close.setAttribute('aria-label', 'Close tab')
      close.textContent = '×'
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(i) })
      button.append(close)
    }

    button.addEventListener('click', () => selectTab(i))
    // Middle-click closes, the way it does in every browser.
    button.addEventListener('auxclick', (e) => {
      if (e.button === 1 && !tab.pinned) { e.preventDefault(); closeTab(i) }
    })
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showTabContextMenu(e, i)
    })

    /* Reordering by drag: the DOM is what gets rearranged while the drag is
       in flight, and the state follows it once, at the end. */
    button.draggable = true
    /* The tab itself, not its index: the strip is rearranged in the DOM while
       the drag is in flight, and an index recorded at render time would
       resolve to a different tab by the time it is read back. */
    button.tab = tab
    button.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', '')
      button.classList.add('is-dragging')
    })
    button.addEventListener('dragend', () => {
      button.classList.remove('is-dragging')
      settleTabOrder()
    })
    frag.append(button)
  })

  el.tabs.replaceChildren(frag)
  el.tabs.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  markTabOverflow()
  renderNavArrows()
}

/** Dim the arrow whose direction has nowhere left to go, for the active tab. */
function renderNavArrows () {
  const tab = activeTab()
  el.navBack.disabled = !tab || tab.historyAt <= 0
  el.navForward.disabled = !tab || tab.historyAt >= tab.history.length - 1
}

/**
 * A tab's own menu.
 *
 * A tab names a document, so it offers what a row in the Files pane offers for
 * one. Worth having in both places rather than only there: the strip is often
 * where a document is visible and the tree is not — scrolled elsewhere, or the
 * sidebar closed altogether — and it is the tab you point at when you notice
 * the name is wrong.
 */
function showTabContextMenu (event, i) {
  const tab = state.tabs[i]
  if (!tab) return

  const items = []

  /* The document half of the menu, which a tab holding nothing has none of.
     The node carries the name the rename is measured against, and it comes
     from the vault rather than from the tab: the label on screen has had its
     extension taken off, and a language table's has had its flag taken off
     too. A document the tree has not got to yet can still have its path
     copied. */
  if (tab.path) {
    const found = state.files.find((f) => f.path === tab.path)
    if (canShowBeside(tab.path)) {
      items.push({ label: 'Open to the side', run: () => openToSide(tab.path) })
    }
    items.push({ label: 'Open in new window', run: () => openInNewWindow(tab.path) })
    if (found) items.push({ label: 'Rename…', run: () => beginTabRename(i, found) })
    items.push({ label: 'Show in explorer', run: () => showInFileExplorer(tab.path) })
    items.push({ label: 'Reveal in Finder', run: () => api.file.reveal(tab.path) })
    items.push({ label: 'Copy path', run: () => copyPaths([tab.path]) })
    items.push({ sep: true })
    items.push({ label: tab.pinned ? 'Unpin tab' : 'Pin tab', run: () => togglePin(i) })
  }

  /* The closes come last and together, under a rule: they are the destructive
     end of the menu, and the two sweeps are worth keeping a hand's width away
     from Rename. Each is offered only when it would do something — a greyed
     row that explains itself by being greyed is better than one that fires and
     appears to have failed. */
  const others = othersOf(state.tabs, i)
  const right = rightOf(state.tabs, i)
  items.push({ sep: true })
  items.push({ label: 'Close tab', run: () => closeTab(i) })
  items.push({ label: 'Close others', disabled: !others.length, run: () => closeTabs(others, tab) })
  items.push({ label: 'Close to the right', disabled: !right.length, run: () => closeTabs(right, tab) })

  renderContextMenu(items, event)
}

/**
 * Hold a tab open, or let it go back to being ordinary.
 *
 * The strip is rearranged as well as marked — see tabstrip.js for why pinned
 * tabs lead it — so the index that was pinned is not the index it ends at, and
 * `tabIndex` is re-pointed at whatever was showing rather than at a number.
 */
function togglePin (i) {
  const showing = activeTab()
  const { tabs, index } = repin(state.tabs, i, !state.tabs[i]?.pinned)
  state.tabs = tabs
  /* The tab that moved is the active one only sometimes; the rest of the time
     the active one merely shifted around it. Both are answered by finding it
     again, and the fallback is the moved tab because that is the only case
     where there was no active tab to find. */
  state.tabIndex = Math.max(0, showing ? state.tabs.indexOf(showing) : index)
  renderTabs()
  rememberTabs()
}

/**
 * Close several tabs at once, and leave `keeper` showing.
 *
 * Not a loop over `closeTab`: that one re-opens a note every time the tab it
 * closed was the active one, so a sweep through eight tabs would read eight
 * documents off disk to show the last of them. The whole sweep is spliced out
 * first and the one survivor opened once, at the end — and only when it is not
 * already what is on screen.
 *
 * `doomed` must be highest-first, which is what othersOf and rightOf hand back.
 *
 * @param {number[]} doomed
 * @param {object} keeper the tab that should be showing when this is done
 */
async function closeTabs (doomed, keeper) {
  if (!doomed.length) return
  /* Before anything is spliced: if the note being typed into is one of the
     tabs about to go, its buffer is written first — the same promise closeTab
     makes on its own. */
  if (doomed.includes(state.tabIndex) && state.dirty) await saveNow()

  /* Recorded low to high so ⌘⇧T walks back through them right to left, the
     order they would have been closed in by hand. */
  for (const at of [...doomed].reverse()) {
    const tab = state.tabs[at]
    if (!tab.path) continue
    closedTabs.push({ tab, index: at })
    if (closedTabs.length > 24) closedTabs.shift()
  }
  for (const at of doomed) state.tabs.splice(at, 1)

  const to = state.tabs.indexOf(keeper)
  // The keeper is spared by construction; a strip that somehow lost it falls
  // back to the nearest tab rather than to an index that is no longer a tab.
  const already = to === state.tabIndex
  state.tabIndex = to === -1 ? Math.min(state.tabIndex, state.tabs.length - 1) : to
  if (already) { renderTabs(); rememberTabs(); return }

  const next = activeTab()
  if (!next?.path) { await showBlank(); return }
  await openNote(next.path, { history: false, place: tabPlace(next) })
  revealInTree(next.path)
}

/**
 * Rename a document from its tab, in its tab.
 *
 * The same edit-in-place the tree's rows do — see `beginRename` — but where the
 * click was. Sending the box to the sidebar instead would put it somewhere the
 * eye is not, and somewhere it may not be on screen at all.
 */
function beginTabRename (i, node) {
  /* Looked up now rather than carried from the right-click: the strip redraws
     on its own — the unsaved dot appears and disappears as you type — so the
     element the menu was opened over may already have been replaced. */
  const button = el.tabs.children[i]
  if (!button?.classList.contains('tab')) return

  /* The whole tab gives way to the box, rather than the label inside it: a tab
     is a `<button>`, and an input nested in one is invalid the same way the
     close × would have been — see the span it is drawn as. The box is styled to
     stand where the tab stood, so the strip does not move. */
  const input = document.createElement('input')
  input.className = 'tab-input'
  input.value = node.name
  input.setAttribute('aria-label', 'Rename')
  button.replaceWith(input)
  input.focus()
  input.select()

  let done = false
  /* What counts as a non-rename is `renameNote`'s to decide, and it says so by
     answering false; anything it did not carry out leaves a tab showing a name
     that is not the file's, so the strip is drawn again to put the real one
     back. A rename it did carry out redraws the strip itself, from every tab
     that was pointing at the old path. */
  const finish = async (commit) => {
    if (done) return
    done = true
    if (!commit || !(await renameNote(node, input.value))) renderTabs()
  }

  /* Its keys are the window's shortcuts until it stops them: typing a name
     should not be bounded by what Escape and the tab-cycling keys mean
     everywhere else. */
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
}

/** Whether the strip runs past its own edge — what decides the fade there. */
function markTabOverflow () {
  el.tabs.classList.toggle('is-scrollable', el.tabs.scrollWidth > el.tabs.clientWidth + 1)
}

/* The drag moves the buttons themselves — pure DOM, no re-render, so the
   dragged element survives to fire its own dragend. Redrawing the strip
   mid-drag would replace that element, and its dragend would die with it. */
el.tabs.addEventListener('dragover', (e) => {
  const moving = el.tabs.querySelector('.tab.is-dragging')
  if (!moving) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  const rest = [...el.tabs.querySelectorAll('.tab:not(.is-dragging)')]
  const after = rest.find((t) => {
    const box = t.getBoundingClientRect()
    return e.clientX < box.left + box.width / 2
  }) || null
  // `insertBefore(node, null)` is an append, so both ends are one call — and
  // the guard keeps the DOM still while the pointer stays over one tab.
  if (moving.nextElementSibling !== after) el.tabs.insertBefore(moving, after)
})
el.tabs.addEventListener('drop', (e) => e.preventDefault())

/** The state catches up with where the drag left the buttons. */
function settleTabOrder () {
  const order = [...el.tabs.querySelectorAll('.tab')].map((b) => b.tab)
  // A strip that changed under the drag — a tab closed, a rename box open —
  // cannot be trusted as an ordering; the redraw below puts truth back.
  if (order.length !== state.tabs.length) { renderTabs(); return }
  const active = activeTab()
  /* A drag is free to cross the boundary between the pinned tabs and the rest;
     it just does not get to leave them interleaved. Settling here rather than
     refusing the drop mid-flight keeps the gesture itself unfussy — the strip
     answers the pointer the whole way, and puts itself in order once. */
  state.tabs = settled(order)
  state.tabIndex = Math.max(0, state.tabs.indexOf(active))
  renderTabs()
  rememberTabs()
}

/**
 * A config write that belongs to the session, made only by the session's window.
 *
 * These are the keys that name documents — the tab strip, the note last open,
 * the document in the side pane. Every window shares one config file, so a
 * second window writing them would decide what the next launch comes back to,
 * and a window opened for one look at one note is not that.
 *
 * Preferences are deliberately NOT routed through here: the theme, the fonts,
 * the panel widths, which folders are unfolded. Those are settings, they are
 * meant to be shared, and last-writer-wins is the behaviour they already had
 * between two runs of the app.
 */
const sessionOnly = (patch) => { if (state.primary) api.config.set(patch) }

/**
 * Show a document in a window of its own.
 *
 * The buffer goes to disk first when it is the one being sent: the new window
 * reads the note off the disk, and without this it would open the version from
 * before whatever was just typed — two windows on one note, disagreeing about
 * it from the first frame.
 */
async function openInNewWindow (path) {
  if (!path) return
  if (state.dirty && state.current?.path === path) await saveNow()
  await api.window.open(path)
}

/**
 * The open tabs, so a window comes back the way it was left.
 *
 * Only from the window whose session it is. Two windows writing `tabs` to one
 * config file would each overwrite the other's, and the last one to be touched
 * before a quit would decide what came back — so a window opened for a single
 * look at a single note could replace a strip of eight. The second window's
 * strip is its own for as long as it is open and is not written down.
 */
function rememberTabs () {
  /* The active tab's place is only written down when something makes it leave,
     and remembering the strip is the other moment it matters — a quit is a
     leave nothing announced. The rest of the strip already carries the place
     each tab was last marked at. */
  markPlace()
  sessionOnly({
    tabs: state.tabs.map((t) => t.path),
    tabIndex: state.tabIndex,
    /* Beside the paths rather than nested inside them: this config is
       deliberately shallow, and a parallel list lets an older one — which has
       no places in it at all — read as a strip of notes opened at the top. */
    tabPlaces: state.tabs.map((t) => tabPlace(t)?.line || 1),
    // Same reasoning, and the same reading of an older config: no list at all
    // is a strip where nothing was pinned, which is what it was.
    tabPinned: state.tabs.map((t) => !!t.pinned)
  })
}

/** Reopen a tab where it was left off — at the note, and at the place in it. */
function tabPlace (tab) {
  const entry = tab.history[tab.historyAt]
  return entry && entry.path === tab.path ? entry : null
}

async function selectTab (i) {
  const tab = state.tabs[i]
  if (!tab || i === state.tabIndex) return
  if (state.dirty) await saveNow()

  markPlace()
  state.tabIndex = i

  if (!tab.path) { await showBlank(); return }
  await openNote(tab.path, { history: false, place: tabPlace(tab) })
  revealInTree(tab.path)
}

async function newTab () {
  markPlace()
  state.tabs.splice(state.tabIndex + 1, 0, blankTab())
  state.tabIndex++
  await showBlank()
}

/* The tabs closed this session, newest last, so ⌘⇧T can walk back through
   them. Only tabs that held a document — reopening a blank is opening
   nothing. Tabs closed because their file went away are left out to keep a
   folder delete from flushing the stack; reopenTab would refuse them anyway. */
const closedTabs = []

async function closeTab (i, { record = true } = {}) {
  const tab = state.tabs[i]
  if (!tab) return
  if (i === state.tabIndex && state.dirty) await saveNow()

  if (record && tab.path) {
    closedTabs.push({ tab, index: i })
    if (closedTabs.length > 24) closedTabs.shift()
  }

  state.tabs.splice(i, 1)

  // The strip always holds at least one tab: closing the last note leaves an
  // empty one rather than a window with no place to put anything.
  if (!state.tabs.length) {
    state.tabs.push(blankTab())
    state.tabIndex = 0
    await showBlank()
    return
  }

  if (i < state.tabIndex) { state.tabIndex--; renderTabs(); rememberTabs(); return }
  if (i > state.tabIndex) { renderTabs(); rememberTabs(); return }

  // The one that was showing has gone; its neighbour takes the screen.
  state.tabIndex = Math.min(i, state.tabs.length - 1)
  const next = state.tabs[state.tabIndex]
  if (!next.path) { await showBlank(); return }
  await openNote(next.path, { history: false, place: tabPlace(next) })
  revealInTree(next.path)
}

function cycleTab (delta) {
  if (state.tabs.length < 2) return
  selectTab((state.tabIndex + delta + state.tabs.length) % state.tabs.length)
}

/** ⌘⇧T — the most recently closed tab, back in its old slot, with the trail
 *  it carried and the place it was left at. */
async function reopenTab () {
  /* Back past any whose document has gone since — trashed, or moved out of
     the vault by another app. */
  let snap
  while ((snap = closedTabs.pop())) {
    if (state.files.some((f) => f.path === snap.tab.path)) break
    snap = null
  }
  if (!snap) return
  if (state.dirty) await saveNow()
  markPlace()

  const i = Math.min(snap.index, state.tabs.length)
  state.tabs.splice(i, 0, snap.tab)
  state.tabIndex = i
  renderTabs()
  await openNote(snap.tab.path, { history: false, place: tabPlace(snap.tab) })
  revealInTree(snap.tab.path)
}

/** Put the pane back to its empty state, with the current tab holding nothing. */
async function showBlank () {
  const tab = activeTab()
  /* Edits are saved, not dropped, before the note is abandoned — the same
     promise selectTab and closeTab make. Without it a ⌘T fired while the
     merge panel was up (which has refused the autosave) would lose the buffer
     that autosave was supposed to protect. */
  if (state.dirty) await saveNow()
  if (tab) tab.path = null
  closeCurrentNote()
  copilot.setNote('')
  rememberTabs()
}

/** Whether `path` is one of `gone`, or lives inside one of them. */
function isUnder (path, gone) {
  return Boolean(path) && (gone.has(path) || [...gone].some((g) => path.startsWith(g + '/')))
}

/**
 * Give up on writing notes that are about to be deleted.
 *
 * Called *before* the delete, not after it. The confirmation dialog does not
 * take the keyboard away from the editor, so typing during it leaves an
 * autosave armed; if that timer fires while `api.file.remove` is still in
 * flight, the write lands after the trash and `file:write` recreates the
 * directory and the note. The file comes back from the dead, the tab that
 * would have shown it is gone, and the ghost only appears at the next tree
 * load. An unsaved buffer for a file being deleted has nowhere to go, so the
 * flag and the timer are dropped while there is still time for it to matter.
 */
function disarmSaves (paths) {
  if (!isUnder(state.current?.path, new Set(paths))) return
  clearTimeout(state.saveTimer)
  state.dirty = false
  // And the crash copy: a draft outliving the file it belongs to would offer,
  // at the next launch, to restore a note the reader deliberately threw away.
  clearDraft(state.current?.path)
}

/** Close every tab pointing at a note that has gone away. */
async function dropTabsFor (paths) {
  const gone = new Set(paths)
  const doomed = (p) => isUnder(p, gone)
  /* Ordinarily already done by `disarmSaves` before the delete; repeated here
     because `closeTab` saves a dirty active tab on its way out, and this is the
     last point before that happens. */
  if (doomed(state.current?.path)) {
    clearTimeout(state.saveTimer)
    state.dirty = false
  }
  for (let i = state.tabs.length - 1; i >= 0; i--) {
    if (doomed(state.tabs[i].path)) await closeTab(i, { record: false })
  }
  // The side pane may be showing one of them too.
  if (doomed(sideDoc())) closeSidePane()
}

/* ------------------------------------------------------------ history */

/**
 * Where you have been, and where you were in it.
 *
 * Following a wikilink is the common way to move around a vault, and it is a
 * one-way trip without this — the sidebar can find a note again but not the
 * place in it you were reading. Entries therefore carry a caret offset and a
 * scroll position, recorded at the moment a note is left rather than
 * continuously.
 */
const HISTORY_MAX = 50

/** Record the place in the note currently on screen, if it is the one the
 *  cursor of this tab's history is pointing at. */
function markPlace () {
  const tab = activeTab()
  const entry = tab?.history[tab.historyAt]
  if (!entry || entry.path !== state.current?.path) return

  /* A place in a note is a caret; a place in a PDF is a page; a place in a
     website is which page of it you were on, since a tab coming back reloads
     from scratch and nothing finer than that survives. They travel in one kind
     of entry, and each pane reads the part of it that means something. */
  /* Both viewers are marked twice on the way out — once before the document is
     torn down, once by `enterDoc` afterwards — and the second time there is
     nothing left to ask. The answer taken a moment ago is the true one, so an
     empty answer is not allowed to overwrite it. */
  if (viewingPdf()) {
    const where = pdf.place()
    if (!where) return
    entry.at = where.page
    entry.page = where.page
    entry.top = where.top
    return
  }
  if (viewingSite()) {
    const { url } = site.place()
    if (url) entry.url = url
    return
  }
  if (viewingWhiteboard()) {
    const where = whiteboardInstance?.place()
    if (!where) return
    entry.x = where.x
    entry.y = where.y
    entry.zoom = where.zoom
    return
  }
  if (viewingData()) {
    const where = dataInstance?.place()
    if (!where) return
    entry.top = where.top
    entry.left = where.left
    return
  }
  if (viewingNotebook()) {
    const where = notebookInstance?.place()
    if (!where) return
    entry.top = where.top
    return
  }
  /* The line at the top of the page is the place both views understand, and
     the only one the reading view can offer: it has no caret, and the two
     views scroll different documents, so a pixel offset taken in one of them
     means nothing in the other. `viewportLine` already answers for whichever
     is showing, and `scrollToLine` already restores into it — this is the pair
     the view switch has always used, borrowed for navigation.

     Recorded before the editor check, because for a long time there was none:
     the reading view is what a launch opens into, so a tab switch, a step back
     and a reopened tab all used to land at the top of the note. */
  entry.line = viewportLine()
  if (!editor || reading()) return
  entry.at = editor.state.selection.main.head
  entry.top = editor.scrollDOM.scrollTop
}

function pushHistory (path) {
  const tab = activeTab()
  if (!tab || tab.history[tab.historyAt]?.path === path) return

  // Opening something new after stepping back drops what was ahead, the way a
  // browser does — the forward stack described a future you did not take.
  tab.history.length = tab.historyAt + 1
  tab.history.push({ path, at: 0, top: 0 })
  if (tab.history.length > HISTORY_MAX) tab.history.shift()
  tab.historyAt = tab.history.length - 1
}

async function goHistory (delta) {
  const tab = activeTab()
  if (!tab) return

  const target = tab.historyAt + delta
  if (target < 0 || target >= tab.history.length) {
    setStatusRight(delta < 0 ? 'Nothing further back' : 'Nothing further forward')
    // Reachable with the arrow lit when a deleted note was just spliced out of
    // the trail below — the history shrank, so the arrows are re-read from it.
    renderNavArrows()
    return
  }

  markPlace()
  const entry = tab.history[target]
  // Set before opening: openNote records the place it is leaving against the
  // entry the cursor points at, which by then has to be the one being left.
  const opened = await openNote(entry.path, { history: false, place: entry })

  if (!opened) {
    // The note is gone. Drop it and keep going the same way, so a deleted note
    // in the middle of the trail does not become a wall.
    tab.history.splice(target, 1)
    if (tab.historyAt > target) tab.historyAt--
    return goHistory(delta)
  }

  /* The open above redrew the strip before the cursor moved, so the arrows
     were painted from where it used to point — settle them from where it does. */
  tab.historyAt = target
  renderNavArrows()
  revealInTree(entry.path)
}

el.navBack.addEventListener('click', () => goHistory(-1))
el.navForward.addEventListener('click', () => goHistory(1))

/* The side buttons on a mouse mean back and forward everywhere else, and the
   browser default they would otherwise trigger does nothing useful here. */
window.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return
  e.preventDefault()
  goHistory(e.button === 3 ? -1 : 1)
})

/** Keep the trail pointing at notes that moved rather than at where they were. */
function retraceHistory (from, to) {
  const moved = (path) => {
    if (path === from) return to
    if (path?.startsWith(from + '/')) return to + path.slice(from.length)
    return path
  }
  // Every tab, not just the one on screen: a note that moved has to keep being
  // findable from whichever tab was pointing at it.
  for (const tab of state.tabs) {
    tab.path = moved(tab.path)
    for (const entry of tab.history) entry.path = moved(entry.path)
  }
  /* The closed ones too: a tab reopened after the note it held was renamed
     must come back as the note, not as the name it used to have. */
  for (const snap of closedTabs) {
    snap.tab.path = moved(snap.tab.path)
    for (const entry of snap.tab.history) entry.path = moved(entry.path)
  }
  renderTabs()
  rememberTabs()
  /* And the locks, by the same rule: a note renamed while it was locked has to
     come back locked, or the lock is quietly lost by the one operation nobody
     would think to check afterwards. */
  if (state.locked.size) {
    const next = new Set([...state.locked].map(moved))
    if ([...next].some((path) => !state.locked.has(path))) {
      state.locked = next
      rememberLocks()
    }
  }
  // The side pane follows a moved document the same way the tabs do, by the
  // same rule — `moved` is the one place that rule is written.
  const next = moved(sideDoc())
  if (next !== sideDoc()) openToSide(next, { keepScroll: true })
  /* And the conversations about it. They are filed under the note's path, so
     until this existed renaming a note you had been discussing left the whole
     transcript — the CLI session id with it — under a name nothing would ever
     ask for again, to be dropped the next time the history was trimmed.
     Handed `moved` rather than the two paths: the rule for what a move does to
     a path is this function's, and the panel taking a copy of it is how the
     folder case comes to be handled in one of them and not the other. */
  copilot.renamed(moved)
}

/**
 * Pull the open note back off disk after something else has written to it.
 * Chasing a rename through the vault can edit the very note being read, but so
 * can an edit in another app or a sync client — this is wired to the file
 * watcher, so the trigger does not have to be one Tulip knows about.
 *
 * Unsaved edits are left alone: whatever is on screen is worth more than a
 * link the user can fix by hand. The cursor is put back where it was, which is
 * close enough given only a link's text changed.
 */
async function reloadCurrent () {
  // A PDF is never edited here, and re-reading one on every watcher tick would
  // mean re-parsing it. If it changed on disk, reopening the tab shows it.
  if (!state.current || state.dirty || viewingPdf()) return

  /* A website file is one line, so re-reading it costs nothing and following it
     is the whole point: the file *is* the document, and an address changed by
     hand, by a sync or by the copilot should move the page the way an edited
     note moves the text. */
  if (viewingSite()) {
    try { site.rehome(await api.file.read(state.current.path)) } catch { /* gone */ }
    return
  }

  if (viewingWhiteboard()) {
    try { await whiteboardInstance?.open(state.current.path, whiteboardInstance.place()) } catch { /* gone */ }
    return
  }

  /* A table rewritten underneath is reread in place, scrolled where it was —
     unless the reader has unsaved cells of their own, in which case theirs
     stand and the disk's version is not pulled in over them. */
  if (viewingData()) {
    if (state.dirty) return
    try { await dataInstance?.open(state.current.path, dataInstance.place()) } catch { /* gone */ }
    updateStatus()
    return
  }

  /* A notebook rewritten underneath — by a Jupyter running beside Tulip, which
     is the ordinary way to have one — is reread in place, scrolled where it
     was. Unsaved cells of the reader's own stand: theirs is the version on
     screen, and pulling the disk's over it would lose what they typed. */
  if (viewingNotebook()) {
    if (state.dirty) return
    try {
      await notebookInstance?.open(state.current.path, notebookInstance.place())
    } catch { /* gone, or no longer a notebook */ }
    updateStatus()
    return
  }

  let text
  try { text = await api.file.read(state.current.path) } catch { return }
  /* The buffer answers when there is no editor — a note being read while a
     sync client rewrites it is the ordinary case, not an unusual one, and
     `patchDoc` below already knows how to apply the change to either. */
  if (text === noteText()) return

  state.patching = true
  try {
    // Applied as an edit, not a replacement: whatever moved the file — a link
    // rewrite, the copilot, a sync client — the caret and the undo history
    // belong to the person at the keyboard and should outlive it. That holds
    // in reading view too, where the buffer sits behind the page: the page is
    // redrawn around the patched buffer rather than a fresh one.
    if (patchDoc(text) && reading()) rerenderReading()
  } finally {
    state.patching = false
  }
  state.dirty = false
  if (viewingTex()) scheduleTexCompile(0)
  /* The buffer and the disk now agree again: the text that was pulled in is
     what the next edits measure against. */
  const tab = activeTab()
  if (tab) tab.base = text
  updateStatus()
}

/* ------------------------------------------------------------ copilot */

/* The edit tool announces its target before it reports success. Keep that
   version in memory so the editor can show exactly what the Copilot removed;
   it is presentation state only and never creates a side file in the vault. */
const agentBefore = new Map()
// Unaccepted Copilot changes, kept outside the document. They let a reopened
// note redraw its review without adding metadata or side files to the vault.
const pendingAgentDiffs = new Map()

/** The compact `+X −Y` and first destination shared by the editor and chat. */
function agentEditSummary (before, after) {
  if (before == null) {
    const lines = String(after || '').split('\n')
    if (lines.at(-1) === '') lines.pop()
    return { added: lines.length, removed: 0, line: 1 }
  }

  const { rows, added, removed } = fileDiff(before, after)
  const first = rows.findIndex((row) => row.kind === 'add' || row.kind === 'del')
  if (first === -1) return { added: 0, removed: 0, line: 1 }
  const next = rows.slice(first).find((row) => row.after != null)
  const previous = rows.slice(0, first).reverse().find((row) => row.after != null)
  const lines = Math.max(1, String(after || '').split('\n').length)
  return {
    added,
    removed,
    line: Math.max(1, Math.min(next?.after || (previous?.after || 0) + 1, lines))
  }
}

function rememberAgentBefore (relPath, needle = '', tool = 'Edit') {
  if (!relPath || !isEditableTextPath(relPath)) return
  const onScreen = relPath === state.current?.path &&
    !viewingPdf() && !viewingSite() && !viewingWhiteboard()
  const currentText = onScreen ? noteText() : ''
  const before = onScreen
    ? Promise.resolve(currentText)
    : api.file.read(relPath)
  agentBefore.set(relPath, Promise.resolve(before).catch(() => null))

  if (onScreen) {
    if (reading()) setView('edit')
    const exact = needle ? currentText.indexOf(needle) : -1
    const at = exact >= 0
      ? exact
      : tool === 'Write'
        ? 0
        : editor.state.selection.main.head
    editor?.revealAgentEdit(at)
  }
}

/**
 * A note the copilot just wrote to, put on screen as it is written.
 *
 * The pane follows the work: a note the copilot edits or creates is opened if
 * it is not already open, so watching the copilot work means watching the
 * note change rather than reading a list of file names afterwards. Each write
 * arrives as its tool call finishes, then the changed span is revealed as if
 * it were being typed. The file itself still lands as one edit rather than a
 * reload (see `editor.patchAnimated`), so the caret, selection and undo history
 * survive it and autosave never sees a half-written Copilot replacement.
 *
 * The conversation stays where it is. Following the edit changes the document
 * on screen, not the note the reply is being written into.
 */
/* The tail of the chain of edits being absorbed — see `onEdited` below. */
let absorbQueue = Promise.resolve()

async function absorbAgentEdit (relPath) {
  const beforePromise = agentBefore.get(relPath)
  agentBefore.delete(relPath)
  const before = beforePromise ? await beforePromise : null

  if (relPath !== state.current?.path) {
    /* The tree first, because the file may be one the copilot has just
       created and the pane is about to show it. Only what this app can show,
       though: the copilot may touch anything in the vault, and a JSON file
       opened as a note is a worse answer than none. */
    await loadTree()
    if (!relPath || !(isEditableTextPath(relPath) || isPdfPath(relPath) || isSitePath(relPath) || isWhiteboardPath(relPath))) return
    // Not focused: the reader is at the message box, and taking the caret out
    // of a half-typed follow-up is not what following an edit should cost.
    await openNote(relPath, { focus: false, chat: false })
    if (relPath === state.current?.path && isEditableTextPath(relPath)) {
      const after = editor.state.doc.toString()
      const reviewBefore = pendingAgentDiffs.get(relPath)?.before ?? before ?? ''
      if (reviewBefore !== after) {
        pendingAgentDiffs.set(relPath, { before: reviewBefore, after })
        // A live diff belongs in the editor: Reading view has no place to keep
        // deleted source that is deliberately absent from the rendered note.
        if (reading()) setView('edit')
        editor?.showAgentDiff(reviewBefore, after)
      }
      return agentEditSummary(before, after)
    }
    return isEditableTextPath(relPath)
      ? agentEditSummary(before, editor.state.doc.toString())
      : null
  }

  let text
  try { text = await api.file.read(relPath) } catch { return }
  // The pane can move while the read is in flight — the reader clicking another
  // note is enough. Whatever is on screen now is not what this edit is about.
  if (state.current?.path !== relPath) return

  // The file on screen is a website, and its text is an address rather than
  // anything the editor holds. Following it means moving the page.
  if (viewingSite()) { site.rehome(text); return }

  /* A whiteboard is JSON on disk but an Excalidraw scene on screen. Feeding
     that JSON through the hidden CodeMirror buffer would neither update the
     canvas nor preserve its state. Reopen the scene in place as soon as the
     Copilot's atomic write lands, unless the reader has drawn on the same
     board in the meantime — that version is kept by the watcher conflict path
     above rather than silently replaced here. */
  if (viewingWhiteboard()) {
    if (!state.dirty) {
      await whiteboardInstance?.open(relPath, whiteboardInstance.place())
    }
    return
  }

  if (viewingData()) {
    if (!state.dirty) await dataInstance?.open(relPath, dataInstance.place())
    return
  }

  if (viewingNotebook()) {
    if (!state.dirty) {
      await notebookInstance?.open(relPath, notebookInstance.place()).catch(() => {})
    }
    return
  }

  /* Both sides wrote. The copilot's write is on disk and the reader has been
     typing into the same note while it worked — patching the file's text in
     would drop what they wrote with nothing said, leaving it only in the undo
     stack. It is the same situation as a sync client changing a note under an
     unsaved buffer, so it is settled the same way: fold the two together from
     the version the copilot started at, and ask where they both rewrote the
     same lines. */
  const buffer = editor.state.doc.toString()
  if (state.dirty && before != null && buffer !== before && buffer !== text) {
    const result = merge3(before, buffer, text)
    if (result.conflicts.length) {
      // The panel owns the note until it is settled, autosave included.
      mergeOpen = true
      clearTimeout(state.saveTimer)
      mergePanel.show(relPath, result)
      return agentEditSummary(before, text)
    }
    state.patching = true
    try {
      if (patchDoc(result.text) && reading()) rerenderReading()
    } finally {
      state.patching = false
    }
    /* Still dirty: the merged text is a version neither the buffer nor the file
       held, so it has yet to be written anywhere. */
    queueSave()
    if (viewingTex()) scheduleTexCompile()
    setStatusRight('Merged the copilot’s changes')
    updateStatus()
    return agentEditSummary(before, text)
  }

  const baseline = before ?? buffer
  const reviewBefore = pendingAgentDiffs.get(relPath)?.before ?? baseline
  state.patching = true
  let animation
  try {
    if (baseline !== text && reading()) setView('edit')
    /* The one document change happens before patchAnimated yields. Keep the
       global guard around that transaction only, so a real keystroke made as
       the letters appear is still treated as the user's edit. */
    animation = editor
      ? editor.patchAnimated(text, { before: reviewBefore })
      : (patchDoc(text), null)
  } finally {
    state.patching = false
  }
  await animation
  if (reviewBefore !== text) pendingAgentDiffs.set(relPath, { before: reviewBefore, after: text })
  state.dirty = false
  if (viewingTex()) scheduleTexCompile(0)
  updateStatus()
  renderTabs()
  return agentEditSummary(baseline, text)
}

/** Draw an unaccepted edit, using the durable history copy after a reload. */
async function showAgentReview (path, operationId = null) {
  let change = pendingAgentDiffs.get(path)
  if (!change && operationId) {
    const operation = await api.trust.operation(operationId).catch(() => null)
    change = operation?.changes.find((item) => item.path === path) || null
    if (change) pendingAgentDiffs.set(path, { before: change.before ?? '', after: change.after ?? '' })
  }
  if (!change || state.current?.path !== path || viewingPdf() || viewingSite() || viewingWhiteboard()) return
  /* Before the view switch, which defers itself when there is no editor to
     switch to. The `after` text below is an argument, so it was evaluated even
     when the call it belongs to was skipped. */
  const view = await ensureEditor()
  if (reading()) setView('edit')
  view.showAgentDiff(change.before ?? '', change.after ?? view.state.doc.toString())
}

/** Accepting is the only action that dismisses the editor-side review. */
async function acceptAgentChanges (operation) {
  const detail = await api.trust.operation(operation.id).catch(() => null)
  const cleared = new Set()
  for (const summary of operation.changes) {
    const saved = detail?.changes.find((item) => item.path === summary.path)
    const pending = pendingAgentDiffs.get(summary.path)
    if (!pending || !saved || pending.after === saved.after) {
      pendingAgentDiffs.delete(summary.path)
      cleared.add(summary.path)
    }
  }
  if (cleared.has(state.current?.path)) editor?.clearAgentDiff()
}

/** Follow a rename Copilot asked main to perform through the open UI state. */
async function absorbAgentRename ({ from, path, links = 0, rewritten = [] }) {
  if (!from || !path) return
  const followed = state.current?.path === from
  const pending = pendingAgentDiffs.get(from)
  if (pending) {
    pendingAgentDiffs.delete(from)
    pendingAgentDiffs.set(path, pending)
  }

  retraceHistory(from, path)
  if (followed) {
    state.current = noteRef(path)
    editor?.refresh()
    if (reading()) renderReading()
    settleDoc(path)
  }
  await loadTree()
  if (rewritten.includes(state.current?.path)) await reloadCurrent()
  if (links) toast(linkNote(links))
}

const noteHistory = mountHistory({
  el: {
    panel: $('history-panel'),
    list: $('history-list'),
    close: $('history-close'),
    subtitle: $('history-subtitle')
  },
  api,
  confirm: ask,
  beforeRestore: saveNow,
  onError: toast
})

/* --------------------------------------------------------------- merging

   A note changed on disk while it was being edited. `mergeOpen` keeps the
   autosave from overwriting the disk's version while the merge is on screen:
   `queueSave` refuses to arm a timer and `saveNow` resolves the panel as
   "keep mine" before any explicit save trigger. The panel itself is a set of
   cards, one per contested place, built by mergepanel.js; the merge of the
   two texts is merge.js's. */
let mergeOpen = false

const mergePanel = mountMergePanel({
  el: {
    panel: $('merge-panel'),
    title: $('merge-title'),
    intro: $('merge-intro'),
    list: $('merge-list'),
    close: $('merge-close'),
    keep: $('merge-keep'),
    save: $('merge-save')
  },
  apply: (text) => {
    /* The one save the merge owns: the buffer becomes the settled text and is
       written, so the note on disk is the note both sides chose. */
    mergeOpen = false
    if (patchDoc(text) && reading()) rerenderReading()
    setStatusRight('Merged')
    saveNow()
  },
  keep: async () => {
    /* "Keep mine" closes the merge and settles the note the way the toast
       always said it had: the buffer is saved, the disk's version put aside.
       The copy is made *before* the save, because the save is what overwrites
       the thing being copied. */
    mergeOpen = false
    await keepBufferOverDisk(state.current?.path)
    saveNow()
  }
})

/**
 * The buffer wins, and the disk's version is kept anyway.
 *
 * Every path that ends "your version was kept" comes through here. It used to
 * be a toast and nothing else, which made it a quiet deletion: the other
 * side's work — a sync client's, another window's, a Jupyter writing the same
 * notebook — was overwritten by the next autosave and there was no copy of it
 * anywhere. Now the file on disk is copied to a sibling first, so the sentence
 * "your version was kept" is true without also meaning "theirs was destroyed".
 *
 * The copy is best-effort on purpose. Failing to make one is not a reason to
 * refuse to save; the message just stops promising a file that is not there.
 */
async function keepBufferOverDisk (path, kind = 'note') {
  const noun = kind === 'whiteboard'
    ? 'This whiteboard'
    : kind === 'notebook' ? 'This notebook' : kind === 'file' ? 'This file' : 'This note'
  let copy = null
  try { copy = await api.file.conflictCopy(path) } catch { copy = null }
  toast(copy
    ? `${noun} changed on disk while you had unsaved work. Your version was kept, theirs is in “${docLabel(copy)}”.`
    : `${noun} changed on disk while you had unsaved work. Your version was kept.`)
  /* A new file appeared beside the open one, and the tree is drawn from a
     snapshot that predates it. */
  if (copy) await loadTree()
  return copy
}

/**
 * The open note was rewritten by something other than Tulip while it was being
 * edited. Merge the buffer against the disk, from the version both sides last
 * agreed on; where they both rewrote the same lines, the merge panel asks.
 * Returns whether the note was handled, so the caller can skip the plain
 * reload that would otherwise follow.
 */
async function handleDiskConflict (path) {
  const base = tabBase(activeTab())
  if (base == null) return false
  /* A merge is already being settled, or a save asked for in the meantime
     settled it as "keep mine" — either way there is nothing to redo. */
  if (mergeOpen) return true
  /* Stop the autosave before any await, or it could fire mid-merge and write
     the buffer over the disk's version. */
  mergeOpen = true
  clearTimeout(state.saveTimer)

  let disk
  try { disk = await api.file.read(path) } catch {
    mergeOpen = false
    return false
  }
  const buffer = editor.state.doc.toString()
  if (disk === buffer) { mergeOpen = false; return true }

  const result = merge3(base, buffer, disk)
  if (result.conflicts.length === 0) {
    /* Nothing the disk did touched anything the buffer did — the two fold
       together. Apply and save, and the note is whole again. */
    const merged = result.text !== buffer
    if (merged && patchDoc(result.text) && reading()) rerenderReading()
    mergeOpen = false
    await saveNow()
    if (merged && !state.dirty) setStatusRight('Merged changes from disk')
    return true
  }

  mergePanel.show(path, result)
  return true
}

/**
 * Ask the disk whether the open note is still what we think it is.
 *
 * The merge above only ever runs because the watcher said something moved, and
 * a watcher is not a guarantee: it dies with an unmounted volume, it is capped
 * by the system's watch descriptors, and the app deliberately ignores anything
 * it believes to be its own write. Coming back to the window is the moment a
 * missed change matters — you were somewhere else, which is exactly when a sync
 * client had the file to itself — so the one note on screen is re-read and put
 * through the same two paths a watcher event would have taken. One file read
 * per focus, and nothing at all when there is no note or the buffer is clean
 * and unchanged.
 */
async function recheckOpenNote () {
  const path = state.current?.path
  if (!path || viewingPdf() || !isEditableTextPath(path)) return
  let disk
  try { disk = await api.file.read(path) } catch { return }
  // The note may have been closed or switched while the read was in flight.
  if (state.current?.path !== path) return
  /* Through the buffer, not the editor: this runs on every window focus, and a
     window focused in the first moments of a launch into the reading view has
     no editor to ask — which used to throw here and take the whole check with
     it, at exactly the moment it exists for. `state.dirty` cannot be true
     without an editor (nothing else can type), so the conflict branch below is
     safe to reach only from a state that has one. */
  if (disk === noteText()) return
  if (state.dirty) { await handleDiskConflict(path) } else { await reloadCurrent() }
}

window.addEventListener('focus', () => { recheckOpenNote() })

const copilotDeps = {
  el: {
    app: el.app,
    panel: el.aiPanel,
    log: el.aiLog,
    attachments: el.aiAttachments,
    input: el.aiInput,
    send: el.aiSend,
    model: el.aiModel,
    attach: el.aiAttach,
    write: el.aiWrite,
    writeLabel: el.aiWriteLabel,
    effort: el.aiEffort,
    effortRow: el.aiEffortRow,
    effortRange: el.aiEffortRange,
    effortStops: el.aiEffortStops,
    configSep: el.aiConfigSep,
    context: el.aiContext,
    contextWrap: el.aiContextWrap,
    contextPop: el.aiContextPop,
    pop: el.aiPop,
    menu: el.aiMenu,
    config: el.aiConfig,
    configModel: el.aiConfigModel,
    configEffort: el.aiConfigEffort
  },
  api,
  onConfig: (patch) => {
    state.cfg = { ...state.cfg, ...patch }
    api.config.set(patch)
    applySettings(state.cfg)
  },
  // Awaited before every turn: an unsaved buffer would otherwise send the
  // agent to read a stale copy of the very note being discussed.
  context: copilotContext,
  /* What the vault holds, for the `@` picker. The list the tree is drawn from,
     read live rather than handed over once — it changes with every note made,
     and a picker offering yesterday's vault is worse than none. */
  files: () => state.files,
  onCite: ({ path, page }) => {
    goToCitation(path, page).catch(() => toast('That page could not be opened.'))
  },
  onOpen: async (path, line = null, operationId = null) => {
    await openNote(path, { focus: false })
    if (line != null && state.current?.path === path) {
      if (reading()) setView('edit')
      goToLine(Math.max(1, Math.min(line, editor.state.doc.lines)))
    }
    await showAgentReview(path, operationId)
  },
  onAccept: acceptAgentChanges,
  onPermission: ({ providerLabel, grant, model }) => ask({
    title: `Allow ${providerLabel} to edit this vault?`,
    detail: `${providerLabel} will use ${model} for this turn. It may ${grant || 'read, edit and create files inside the vault'}.`,
    go: 'Allow this turn'
  }),
  onRenamed: absorbAgentRename,
  onWarn: (message) => toast(message),
  onRestore: (operation, path = null) => noteHistory.restore(operation, path),
  onEditing: rememberAgentBefore,
  // A failure here means the note on screen has quietly fallen behind the file
  // on disk, which is the one state this feature must never reach silently.
  onEdited: (relPath) => {
    /* One at a time, in the order the writes happened. Absorbing an edit opens
       notes, reads files and plays an animation — a dozen awaits — while
       reading and writing the one `state.current` the whole app shares. Two
       edits a few hundred milliseconds apart used to interleave: the second
       would decide whether its note was the one on screen, then act on that
       answer after the first had switched the pane, and patch one note's text
       into the other note's buffer. Serialising is enough to fix it, because
       every branch inside is correct as long as nothing moves underneath it. */
    const run = absorbQueue.then(() => absorbAgentEdit(relPath))
    // The queue must survive a failure, or one bad edit stops the app from
    // following any that come after it.
    absorbQueue = run.catch(() => {})
    return run.catch((err) => {
      console.error('absorbing a copilot edit failed', err)
      toast('The copilot changed this note but the editor could not follow. Reopen it.')
      return null
    })
  }
}

/* ------------------------------------------------------- copilot, on demand

   The panel is a tenth of everything the renderer compiles at launch, and it
   opens closed. So it is fetched the first time something actually wants it,
   and until then `copilot` below stands in for it.

   The stand-in is not a general proxy, because the two kinds of call it takes
   are not the same:

   - Things a reader asked for — open, toggle, ask, quote — load the panel and
     then happen. Ordering survives: every one of them awaits the same promise,
     so `open()` then `quote()` still arrives in that order.
   - Things that only tell the panel about a change — setNote, applyConfig,
     close, flush — are dropped when it was never built. A quit must not load
     the copilot in order to flush transcripts it does not have, and moving
     between notes must not build a panel nobody opened.

   `renamed` is the exception in that second group, and the reason this is a
   list rather than a rule: chats are filed under the note's path, in memory and
   in the history file, so a rename that the panel sleeps through leaves every
   conversation about that note under a name nothing will ask for again. It
   loads. Renames are rare; a lost conversation is not recoverable. */
let copilotLive = null
let copilotArriving = null

function loadCopilot () {
  if (copilotLive) return Promise.resolve(copilotLive)
  copilotArriving ||= import('./copilot.js').then(async ({ mountCopilot }) => {
    const built = mountCopilot(copilotDeps)
    /* Built after boot, so it has missed what boot would have told it: the
       settings that dress its controls, the stored conversations, and which
       note is on screen. `restore` is the first two — the same call boot used
       to make — and it is awaited so that whoever asked for the panel gets one
       with its history already in it. */
    await built.restore(state.cfg).catch(() => {})
    copilotLive = built
    if (state.current?.path) built.setNote(state.current.path)
    return built
  })
  return copilotArriving
}

const copilot = {
  // Asked for: these build the panel.
  open: () => loadCopilot().then((c) => c.open()),
  toggle: () => loadCopilot().then((c) => c.toggle()),
  ask: (text) => loadCopilot().then((c) => c.ask(text)),
  quote: (text) => loadCopilot().then((c) => c.quote(text)),
  renamed: (moved) => loadCopilot().then((c) => c.renamed(moved)),

  /* Boot. A panel left open is built now, because it is about to be on screen
     anyway and the window should not be revealed with a gap where it goes. A
     panel left closed is not built at all — its conversations are read when it
     is first opened, which is the only moment anything can look at them. */
  restoreAtBoot: (cfg) => (cfg.ai === 'open' ? loadCopilot() : Promise.resolve()),

  // Told to: these are nothing at all until there is a panel to tell.
  close: () => copilotLive?.close(),
  setNote: (path) => copilotLive?.setNote(path),
  applyConfig: (cfg) => copilotLive?.applyConfig(cfg),
  flush: async () => copilotLive ? copilotLive.flush() : undefined
}

/* A block that failed offers to hand the failure over — see runcode.js, which
   writes the question and knows nothing about who answers it. Opening the panel
   is part of the gesture, the same as asking about a passage in a PDF. */
onAskToFix((prompt) => {
  copilot.open()
  copilot.ask(prompt)
})

/* ----------------------------------------------------- code block copilot

   A focused prompt before the full Copilot panel. The sparkle on a fence does
   not send anything by itself: it opens this small form inside that code block,
   so the request stays attached to its source while the note scrolls. Sending
   then opens Copilot and asks it to replace only the captured block. */
const codeAiPop = node('form', 'code-ai-popover')
codeAiPop.setAttribute('role', 'dialog')
codeAiPop.setAttribute('aria-label', 'Edit code block with Copilot')
const codeAiInput = node('textarea', 'code-ai-input')
codeAiInput.rows = 5
codeAiInput.placeholder = 'Describe what to change…'
codeAiInput.setAttribute('aria-label', 'Instructions for Copilot')
const codeAiHint = node('span', 'code-ai-hint', '⌘ Enter to send')
codeAiHint.setAttribute('aria-hidden', 'true')
/* The hint sits in the field's bottom corner, so it is measured from the field
   and not from the form. The two are the same box in the reading view and are
   not in the editing one, where the form carries the frame's border and inset
   — position it against the form and it drifts onto the textarea's border on
   one side and its scrollbar on the other, in that view only. */
const codeAiField = node('div', 'code-ai-field')
codeAiField.append(codeAiInput, codeAiHint)
codeAiPop.append(codeAiField)

let codeAiSession = null

function closeCodeAi ({ restore = true } = {}) {
  const anchor = codeAiSession?.anchor
  const connected = anchor?.isConnected
  // The editor put it in the document; only the editor can take it out again.
  if (codeAiSession?.inEditor) editor?.hideCodeForm()
  codeAiPop.remove()
  codeAiSession = null
  if (restore && connected) anchor.focus()
}

el.app.addEventListener('tulip:code-copilot', (event) => {
  const { anchor, code, lang } = event.detail || {}
  if (!(anchor instanceof HTMLElement)) return
  if (codeAiPop.isConnected && codeAiSession?.anchor === anchor) {
    closeCodeAi()
    return
  }
  /* Both views draw the same sparkle (blocks.js), but they hold it in very
     different boxes. Reading builds the block itself, so the form goes straight
     into it — under the header, above the source, pushing the code down.
     Editing has no such box: the block is the editor's own lines. It gets the
     same place all the same, by handing the form to the editor to carry as a
     block widget between the fence and the first line of code — which is the
     one thing that can put a node in there without the editor reading it back
     as an edit to the note, and which makes room for it rather than covering
     the code the request is about. */
  const body = anchor.closest('.code-wrap')?.querySelector('.code-body')
  const line = body ? null : anchor.closest('.cm-line')
  if (!body && !line) return

  codeAiInput.value = ''
  /* Reading drops it into a block that already draws the frame; editing hands
     it to lines that each draw their own, so out there the form paints that
     surface itself rather than leaving a gap in the middle of the block. */
  codeAiPop.classList.toggle('in-frame', !body)
  if (body) body.before(codeAiPop)
  else if (!editor?.showCodeForm(line, codeAiPop)) return

  codeAiSession = {
    anchor,
    code: String(code || ''),
    lang: String(lang || ''),
    inEditor: Boolean(line)
  }
  codeAiInput.focus()
})

/* The reading view's copy goes wherever its block goes — it is rebuilt with the
   note, and disappears with it. The editing view's is held by editor state,
   which outlives the note on screen, so it needs telling. Losing focus is what
   switching notes, switching views and clicking back into the text all have in
   common, and is what a small prompt over a document should answer to anyway.
   Restoring focus here would fight whatever just took it. */
codeAiPop.addEventListener('focusout', (event) => {
  if (!codeAiSession?.inEditor) return
  /* Except to the sparkle itself, which is a request to close: closing here
     first would leave its click looking at an empty screen and open the form
     straight back up. */
  if (event.relatedTarget === codeAiSession.anchor) return
  queueMicrotask(() => {
    if (codeAiSession?.inEditor && !codeAiPop.contains(document.activeElement)) {
      closeCodeAi({ restore: false })
    }
  })
})

codeAiPop.addEventListener('keydown', (event) => {
  /* The field is a textarea, so Enter itself writes a newline — sending is
   * the chord every chat box uses for it. */
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    codeAiPop.requestSubmit()
  }
  /* The way out. Kept off the app's global Escape so it cannot be swallowed by
     whatever else is listening while the caret is in this field. */
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeCodeAi()
  }
})
codeAiPop.addEventListener('submit', (event) => {
  event.preventDefault()
  const request = codeAiInput.value.trim()
  if (!request || !codeAiSession) { codeAiInput.focus(); return }
  const { code, lang } = codeAiSession
  const fence = code.includes('```') ? '~~~~' : '```'
  closeCodeAi({ restore: false })
  copilot.open()
  copilot.ask(
    `Edit only the following ${lang || 'fenced'} code block in the open note. ` +
    `Change nothing else.\n\nRequest: ${request}\n\n` +
    `${fence}${lang}\n${code}\n${fence}`
  )
})

/**
 * What the copilot is told about the document on screen, before every turn.
 *
 * A PDF and a note are described the same way — which file is open, and what the
 * reader has in hand — because the agent reads both from the vault itself. The
 * difference is where the passage comes from: a note's is the editor's
 * selection, and a PDF's outlives the selection that made it, since reaching the
 * message box costs the reader the selection on the page.
 */
/* How much of a selection travels with the question. A passage longer than this
   is cut rather than dropped: the agent is told the text was cut short (see
   `opened` in electron/ai.js) and can read the file for the rest, which is
   better than the silence a dropped selection used to be — the reader had
   selected three pages and the agent was told of no selection at all. */
const SELECTION_LIMIT = 4000

const cut = (text) => String(text || '').slice(0, SELECTION_LIMIT)

/** The heading the cursor sits under, for a question asked without a selection.
 *  Through `headingsFor`, like every other part of the app that asks — a private
 *  scan here would call the `# comment` at the top of a shell block a heading,
 *  and it is cached per document besides. */
function headingAt (pos) {
  const here = editor.state.doc.lineAt(pos).number
  const above = headingsFor(editor.state.doc).filter((heading) => heading.line <= here)
  return above.at(-1)?.text || ''
}

async function copilotContext () {
  if (state.dirty) await saveNow()

  if (viewingPdf()) {
    const quote = pdf.quote()
    const text = quote?.text || ''
    return {
      note: state.current.path,
      kind: 'pdf',
      page: quote?.page || pdf.page(),
      pages: pdf.pages(),
      selection: cut(text),
      truncated: text.length > SELECTION_LIMIT,
      marks: pdf.marks().length
    }
  }

  /* A website is described by the page, not by the file. The file says one
     thing the agent could read for itself; what it cannot read for itself is
     which page is actually on screen, since the reader may have clicked three
     links deep from the address the file names. There is no selection to send
     — the text belongs to a guest, and reaching into one to take it is the
     thing the fence around a guest exists to prevent. */
  if (viewingSite()) {
    const view = site.state()
    return {
      note: state.current.path,
      kind: 'site',
      url: view.url,
      title: view.title,
      selection: ''
    }
  }

  /* A file with no view of its own: the path is the whole of what can honestly
     be said about it here. There is nothing on screen to quote — a picture, a
     recording, a `.docx` — and the agent has its own tools for a file it can
     make anything of. */
  if (viewingFile()) {
    const shown = fileViewInstance?.context() || { kind: 'file', size: 0 }
    return {
      note: state.current.path,
      kind: 'file',
      shownAs: shown.kind,
      bytes: shown.size,
      selection: ''
    }
  }

  if (viewingWhiteboard()) {
    const board = whiteboardInstance?.context() || { selection: '', text: '', elements: 0 }
    return {
      note: state.current.path,
      kind: 'whiteboard',
      selection: cut(board.selection),
      text: cut(board.text),
      elements: board.elements,
      truncated: board.selection.length > SELECTION_LIMIT || board.text.length > SELECTION_LIMIT
    }
  }

  /* A table has no text on screen to quote, so what goes over is the file's
     own shape: its headings and enough rows to see what the columns hold. The
     grid is showing it, and a model that cannot see the grid would otherwise
     have to read the quoted source to learn the column names. */
  if (viewingData()) {
    const table = dataInstance?.context() || { text: '', rows: 0, columns: 0 }
    return {
      note: state.current.path,
      kind: 'data',
      selection: '',
      text: cut(table.text),
      rows: table.rows,
      columns: table.columns,
      truncated: table.rows > 50 || table.text.length > SELECTION_LIMIT
    }
  }

  /* A notebook says the one thing about itself that a model reading the file
     could not get to cheaply: the cells, as source, without the base64 the
     outputs are stored as. */
  if (viewingNotebook()) {
    const book = notebookInstance?.context() || { text: '', cells: 0, code: 0, language: '' }
    return {
      note: state.current.path,
      kind: 'notebook',
      selection: '',
      text: cut(book.text),
      cells: book.cells,
      language: book.language,
      truncated: book.text.length > SELECTION_LIMIT
    }
  }

  /* No editor, so no caret and no selection — a note being read, which is what
     the copilot is most often asked about and, since the app opens into the
     reading view, may be all there has ever been. Everything below that the
     agent actually needs is in the text; the rest was already being reported
     as absent whenever `reading()` was true. The head of the note stands in
     for an excerpt around a cursor there is none of. */
  if (!editor) {
    const text = noteText()
    const excerpt = noteExcerpt(text, 0)
    return {
      note: state.current?.path || '',
      kind: viewingTex()
        ? 'tex'
        : viewingCode()
            ? (languageLabel(codeToken(state.current?.path)) || 'source').toLowerCase()
            : (viewingLanguageTable() ? 'language' : 'note'),
      selection: '',
      truncated: false,
      line: 0,
      heading: '',
      excerpt: excerpt.text,
      excerptCut: excerpt.cut,
      noteChars: text.length
    }
  }

  const caret = editor.state.selection.main
  const selection = reading() ? '' : editor.state.sliceDoc(caret.from, caret.to)
  /* The note itself, whole wherever it fits. Sent alongside a selection rather
     than instead of it: the selection says what is being discussed, and the
     text says what it is being discussed against — an agent asked "does this
     contradict anything above?" about three highlighted lines cannot answer
     from the three lines. */
  const text = docText(editor.state.doc)
  const excerpt = noteExcerpt(text, caret.head)
  return {
    note: state.current?.path || '',
    /* A source file says which language it is in, not just that it is source:
       "python" is the difference between the copilot reading the excerpt as a
       script and guessing at it from the punctuation. */
    kind: viewingTex()
      ? 'tex'
      : viewingCode()
          ? (languageLabel(codeToken(state.current?.path)) || 'source').toLowerCase()
          : (viewingLanguageTable() ? 'language' : 'note'),
    selection: cut(selection),
    truncated: selection.length > SELECTION_LIMIT,
    /* Where the reader is, when they have not said. The rendered view has no
       caret worth reporting — it is a page, not a document being edited. */
    line: reading() ? 0 : editor.state.doc.lineAt(caret.head).number,
    heading: reading() ? '' : headingAt(caret.head),
    excerpt: excerpt.text,
    excerptCut: excerpt.cut,
    noteChars: text.length
  }
}

/* How much of the open note travels with the question.

   Two budgets, because a note is either small enough to hand over whole or it
   is not, and the two cases want different things said. Under the first the
   agent has the entire text and never has to decide whether the answer might
   be in the part it was not shown — which is nearly always, since a note of
   four hundred thousand characters is a book. Over it a window around the
   cursor stands in, and the prompt says how much was left out so the agent
   reads the file rather than answering from a fragment.

   The old excerpt was six thousand characters because the note was quoted on
   every turn, and a thread that re-sends its context costs the square of its
   own length. It is not quoted per turn any more: `promptFor` in
   electron/prompt.js quotes the text once and names it afterwards, so a note
   is paid for when it changes rather than when it is asked about. That is what
   makes sending the whole thing affordable. */
const WHOLE_NOTE_LIMIT = 400000
const NOTE_WINDOW_LIMIT = 24000

/** The note as the Copilot will see it: whole when it fits, and a window
 *  around `head` when it does not. */
function noteExcerpt (text, head) {
  const source = String(text || '')
  if (source.length <= WHOLE_NOTE_LIMIT) return { text: source, cut: false }
  /* Snapped out to whole lines, so neither end of the window lands mid-word or
     halfway through a fenced block. */
  const half = Math.floor(NOTE_WINDOW_LIMIT / 2)
  const from = source.lastIndexOf('\n', Math.max(0, head - half)) + 1
  const after = source.indexOf('\n', Math.min(source.length, head + half))
  const to = after === -1 ? source.length : after
  return {
    text: `${from ? '…\n' : ''}${source.slice(from, to)}${to < source.length ? '\n…' : ''}`,
    cut: true
  }
}

/**
 * Which PDF a citation names, when it names one at all.
 *
 * Resolved the way a wikilink is — by the file's own name, wherever it sits —
 * because that is the name the copilot has in hand: it was given a path into
 * the vault, and what comes back in the reply is usually the last part of it.
 * A full path still wins, and only PDFs are considered, so a citation cannot
 * be talked into opening a note.
 */
function resolvePdfPath (name) {
  const wanted = String(name).toLowerCase().replace(/^\.?\//, '')
  const pdfs = state.files.filter((f) => isPdfPath(f.path))
  return (
    pdfs.find((f) => f.path.toLowerCase() === wanted) ||
    pdfs.find((f) => f.path.toLowerCase().endsWith(`/${wanted}`)) ||
    bestLinkTarget(pdfs.filter((f) => f.name.toLowerCase() === wanted.replace(PDF_EXT, '')))
  )?.path || ''
}

/**
 * A page the copilot cited, put on screen.
 *
 * The usual citation names no document, and means the one being discussed —
 * which is the one open, since the conversation belongs to it. A citation that
 * does name a file opens that file first, and only then jumps: `goToPage`
 * measures against pages that exist, and `openPdf` does not return until they
 * do.
 *
 * The page is the PDF's own — the nth sheet — not the number printed on it,
 * because that is what the extracted text's `--- page N ---` markers count and
 * so what the copilot is reading off. Front matter means the two disagree by a
 * dozen pages in a book, and the marker is the one that can be acted on.
 */
async function goToCitation (path, page) {
  if (!Number.isFinite(page) || page < 1) return

  const wanted = path ? resolvePdfPath(path) : (viewingPdf() ? state.current.path : '')
  if (!wanted) {
    toast(path ? `No PDF named "${path}" is in this vault.` : 'No PDF is open.')
    return
  }

  if (!viewingPdf() || state.current.path !== wanted) {
    if (!await openNote(wanted)) return
    revealInTree(wanted)
  }
  if (page > pdf.pages()) { toast(`That PDF has only ${pdf.pages()} pages.`); return }
  pdf.goToPage(page)
  el.pdf.focus()
}

const speech = makeSpeech()

const languageStudy = mountLanguageStudy({
  el: {
    root: $('study'),
    card: $('study-card'),
    prompt: $('study-prompt'),
    word: $('study-word'),
    english: $('study-english'),
    aside: $('study-aside'),
    summary: $('study-summary'),
    firstCorrect: $('study-first-correct'),
    firstWrong: $('study-first-wrong'),
    input: $('study-input'),
    feedback: $('study-feedback'),
    verdict: $('study-verdict'),
    replay: $('study-replay'),
    hint: $('study-hint'),
    progress: $('study-progress'),
    close: $('study-close')
  },
  /* The open note's text rather than the file's, so a word typed a second ago
     is in the deck: the buffer is what the reader can see. */
  source: () => noteText(),
  /* Which note the cards belong to: a card's identity begins with it, so this
     is what keeps one language's schedule apart from another's. */
  notePath: () => state.current?.path || '',
  /* And every other table in the vault, for a review that is not about the
     note in front of you. */
  decks: () => api.language.decks(),
  speech,
  settings: () => ({
    newPerDay: state.cfg.studyNewPerDay,
    retention: state.cfg.studyRetention,
    speaking: state.cfg.studySpeaking
  }),
  api,
  onEmpty: toast
})

el.aiClose.addEventListener('click', () => copilot.close())
el.aiToggle.addEventListener('click', () => copilot.toggle())

/* The button beside the tabs mirrors the panel — a toggle can come from the
   chord, the palette or the button itself, and data-ai is where they all end
   up. */
const paintAiToggle = () =>
  el.aiToggle.setAttribute('aria-pressed', String(el.app.dataset.ai === 'open'))
new MutationObserver(paintAiToggle).observe(el.app, { attributeFilter: ['data-ai'] })
paintAiToggle()

/* The button beside the tabs studies the table it is on, and is the only way
   in — the palette entry and the ⌃⌘S chord that reviewed everything due,
   wherever you were, are both gone. */
el.studyStart.addEventListener('click', () => languageStudy.open())

/* ------------------------------------------------- the language keyboard */

const keyboard = mountKeyboard({
  root: el.langKeys,
  keys: el.langKeysRow,
  shift: el.langKeysShift,
  mode: el.langMode
})

/**
 * The letters this language's keyboard offers.
 *
 * Nothing is filled in and nothing is read from the vault: a language folder
 * already carries a flag and a name, and between them that is enough. The name
 * is tried first so `Español` and `Spanish` reach the same row, then the flag —
 * which is the more dependable of the two, because it is picked from a list
 * when the language is created while the name is free text somebody may have
 * written as "Spanish practice".
 *
 * A language neither knows falls back to the common Latin accents, which is
 * both the likeliest answer and better than an empty strip: the keys are there
 * to be typed, not to be configured.
 */
function keysFor (dir) {
  const { flag, name } = languageIdentity(dir.split('/').pop() || '')

  const set =
    ALPHABETS.byName[name.trim().toLowerCase()] ||
    ALPHABETS.byName[ALPHABETS.byCountry[countryCode(flag)]] ||
    ALPHABETS.default

  return set.split(/\s+/).filter(Boolean)
}

/* The folder the strip was last built for, so moving between the three files of
   one language does not rebuild the same row of buttons. */
let keyboardFor = null

function paintKeyboard () {
  // Only where there is a grid to type into: the reading view renders the table
  // as prose, and there is nothing in it to put a letter in.
  const note = viewingLanguageTable() && !reading() ? state.current : null
  keyboard.show(!!note)
  if (!note) { keyboardFor = null; return }

  if (note.dir === keyboardFor) return
  keyboardFor = note.dir
  keyboard.setKeys(keysFor(note.dir))
}

/* Counted with matchAll rather than match: the iterator yields one match at a
   time, where `match` builds an array holding every word in the note first and
   then throws it away to read `.length`.

   Han, kana, and Hangul put no spaces between words, so under a bare
   `[\p{L}…]+` a whole Chinese paragraph arrives as one match — "1 word". In
   those scripts a character is nearer a word than a letter, and one-per-glyph
   is how their editors conventionally count. The subtraction keeps the run
   alternative from swallowing them first. */

function updateStatus () {
  let text = ''

  /* A PDF is measured in what has been marked on it. Not in pages: the toolbar
     already says which page this is, and saying it twice on one screen is one
     place too many. Counting its words would mean parsing every page to answer
     a question nobody asked. */
  if (state.current && viewingPdf()) {
    const marks = pdf.marks().length
    text = pdf.pages()
      ? (marks ? `${marks} ${marks === 1 ? 'highlight' : 'highlights'}` : '')
      : 'Opening…'
  }

  /* Notes and websites say nothing here. A website's own title was in this line, on the
     reasoning that a browser puts it in the tab and Tulip's tab carries the
     file's name instead — but a page is a picture of itself, and its title is
     almost always the words already across the top of it. A second copy along
     the foot of the window was a strip of chrome earning nothing.
     The title is still read: the copilot is told it, because a model cannot
     see the page. See copilotContext.

     Notes already carry their counts in Info, alongside reading time, headings,
     links and tags. Repeating two of them across the foot of every page spends
     permanent chrome on information that has a proper home. */

  /* A source file does say something here, and it is the one thing about it
     that is not on screen: which language it is being read as. An extension
     the app has no parser for still opens, coloured or not, and this line is
     where that shows — "Plain text" under a `.zig` is the answer to why it is
     grey. */
  if (state.current && viewingCode()) {
    text = languageLabel(codeToken(state.current.path)) || 'Plain text'
  }

  // A table is measured in its shape, and so is a notebook.
  if (state.current && viewingData()) text = dataInstance?.summary() || ''
  if (state.current && viewingNotebook()) text = notebookInstance?.summary() || ''

  el.statusLeft.textContent = text
  el.statusLeft.hidden = !text
}

/* Zoom indicator. It stays beside Copilot so the current window size is always
   visible and the reset control never has to be caught before it fades. */
const DEFAULT_ZOOM_PERCENT = Math.round(DEFAULT_ZOOM * 100)
let zoomTimer = null
let zoomPercent = DEFAULT_ZOOM_PERCENT

/* Never over a PDF. The window's zoom and the page's are two different sizes,
   and a readout of the first sitting in the corner of a document that has its
   own is a question the reader has to answer before ignoring it. */
function paintZoomBadge () {
  if (!el.zoom) return
  el.zoom.textContent = `${zoomPercent}%`
  el.zoom.hidden = viewingPdf() || viewingSite() || viewingWhiteboard()
}

/**
 * A size the window really is, reported by the main process — ⌘+, ⌘−, ⌘0, the
 * View menu, the settings stepper, or the size a session was restored at. Every
 * one of them is a deliberate act, so every one of them is worth a word.
 */
function showZoom (percent) {
  if (!el.zoom || percent === zoomPercent) return
  zoomPercent = percent
  el.zoom.textContent = `${percent}%`
  el.zoom.hidden = viewingPdf() || viewingSite() || viewingWhiteboard()
  el.zoom.classList.add('is-flash')

  clearTimeout(zoomTimer)
  zoomTimer = setTimeout(() => {
    el.zoom.classList.remove('is-flash')
  }, 1500)
}

/**
 * Pinching a note does nothing.
 *
 * macOS delivers a pinch as a wheel event with ctrlKey set — as does a mouse's
 * ⌘-scroll — and left alone Chromium answers it by resizing the whole window.
 * Over a note that is the wrong size to be changing: two fingers drifting apart
 * mid-scroll is not a request for a bigger app, and the reader who wanted one
 * has ⌘+, ⌘− and the settings stepper, each of which lands on a stop and can be
 * put back exactly. So the gesture is swallowed here, before the window sees it.
 *
 * A PDF and a website are documents rather than notes: each keeps a zoom of its
 * own and prevents the event before it reaches this listener, which is why the
 * claim is checked rather than assumed.
 */
document.addEventListener('wheel', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return
  if (event.defaultPrevented || viewingPdf() || viewingSite() || viewingWhiteboard()) return
  event.preventDefault()
}, { passive: false })

/* The right-hand end of the status bar keeps its own timer: it is a passing
   remark, and clearing it must not cancel the word count settling on the left. */
let statusRightTimer = null
function setStatusRight (msg) {
  el.statusRight.textContent = msg
  clearTimeout(statusRightTimer)
  if (msg) statusRightTimer = setTimeout(() => { el.statusRight.textContent = '' }, 1800)
}

/* ------------------------------------------------------------- wikilinks */

/**
 * Follows `[[Note]]`, `[[Note#Heading]]`, and `[[#Heading]]`.
 *
 * The anchor is split off before the note is looked for — without that, a link
 * with a heading in it matches nothing and the app helpfully creates a note
 * called "Note#Heading". A bare anchor means this note, which is how a long
 * note links to its own sections.
 */
async function openWikilink (target, { newTab = false, side = false } = {}) {
  const attachment = embedSpec(target, { resolve: resolveHere })
  if (attachment.path && (attachment.kind === 'audio' || attachment.kind === 'video')) {
    openTimedMedia(attachment)
    return
  }
  if (attachment.path && attachment.kind === 'pdf') {
    // ⌥ means "beside what I am writing, not over it" — see src/sidepane.js.
    if (side) { openToSide(attachment.path); return }
    await openNote(attachment.path, { newTab })
    revealInTree(attachment.path)
    if (attachment.page) pdf.goToPage(attachment.page)
    return
  }

  const { name, anchor } = splitAnchor(target)

  if (!name) {
    // `[[#Heading]]` — already here, so there is nothing to open.
    if (anchor) jumpToHeading(anchor)
    return
  }

  const wanted = name.toLowerCase()
  let hit = linkTargetFor(wanted)

  /* Nothing by that name — which is the one moment it is worth asking main for
     a fresh alias list, because the alternative is creating a note. An alias
     added since the last refresh (in a note that is open, or by a sync client)
     would otherwise be a second copy of a note the vault already has, written
     to disk before anyone saw the link fail. */
  if (!hit) {
    await refreshAliases()
    hit = linkTargetFor(wanted)
  }

  if (hit) {
    // ⌥ on a website falls back to the ordinary open rather than doing
    // nothing — it is the one kind the pane cannot hold.
    if (side && canShowBeside(hit.path)) { openToSide(hit.path); return }
    await openNote(hit.path, { newTab })
    revealInTree(hit.path)
    if (anchor) jumpToHeading(anchor)
    return
  }

  const dir = state.current?.dir || ''
  const path = await api.file.create(dir, name)
  await loadTree()
  await openNote(path, { newTab })
  revealInTree(path)
  toast(`Created "${name}"`)
}

/**
 * The note a lowercased link name means, as a tree entry.
 *
 * A name, then a path, then an alias — main's `linkTarget` resolves in the same
 * order for the same reason: a note actually called `Wanted` outranks one that
 * merely answers to it, and two answers for one link is how a backlink used to
 * be attributed to the wrong note.
 */
function linkTargetFor (wanted, files = state.files) {
  const named = bestLinkTarget(files.filter((f) => f.name.toLowerCase() === wanted))
  if (named) return named
  const byPath = files.find((f) => f.path.toLowerCase().replace(NOTE_EXT, '') === wanted)
  if (byPath) return byPath
  const claimed = state.aliases[wanted]
  if (!claimed?.length) return null
  const set = new Set(claimed)
  return bestLinkTarget(files.filter((f) => set.has(f.path)))
}

/** The alias list, re-read. Cheap, and only asked for when a link misses. */
async function refreshAliases () {
  try {
    state.aliases = (await api.vault.aliases()) || {}
  } catch {
    // A vault that is closed or gone has no aliases; the caller falls through
    // to the same "no such note" it would have reached anyway.
    state.aliases = {}
  }
}

/**
 * The note a bare name means, as a path — what a transclusion or a hover
 * preview resolves through. The same answer `openWikilink` arrives at, minus
 * the creating: an embed of a note that does not exist is a missing embed,
 * not an invitation to make one. An empty name means this note, which is how
 * `[[#Heading]]` previews its own section.
 */
function noteFromName (name) {
  if (!name) return state.current && NOTE_EXT.test(state.current.path) ? state.current.path : null
  const wanted = String(name).toLowerCase().replace(NOTE_EXT, '')
  const hit = linkTargetFor(wanted, state.files.filter((f) => NOTE_EXT.test(f.path)))
  return hit ? hit.path : null
}

/**
 * Which note `[[Name]]` means when the vault holds more than one by that name.
 *
 * Taking the first match in flatten order made the answer depend on where the
 * twin happened to sit in the tree, not on where the link was written. The one
 * beside the linking note wins; failing that, the one whose folder shares the
 * most of the way there, with the shorter path breaking ties and the
 * alphabetical path the last resort. This is exactly `nearestNamed`'s rule
 * over in electron/main.js, on purpose: the backlink scanner resolves the same
 * link, and two answers for one link is how a mention used to be attributed
 * to the wrong twin.
 */
function bestLinkTarget (matches) {
  if (matches.length < 2) return matches[0] || null

  const here = state.current?.dir || ''
  const shared = (dir) => {
    if (dir === here) return Infinity
    const a = here ? here.split('/') : []
    const b = dir ? dir.split('/') : []
    let n = 0
    while (n < a.length && n < b.length && a[n] === b[n]) n++
    return n
  }

  let best = matches[0]
  for (const next of matches.slice(1)) {
    const dShared = shared(next.dir) - shared(best.dir)
    if (dShared > 0 ||
        (dShared === 0 && next.path.length < best.path.length) ||
        (dShared === 0 && next.path.length === best.path.length &&
          next.path.localeCompare(best.path) < 0)) {
      best = next
    }
  }
  return best
}

/**
 * Put a line at the top of whichever view is up, with the caret on it.
 *
 * The selection is moved without a scroll of its own. Asking for two
 * alignments in one gesture — "reveal the caret" and "put this line at the
 * top" — lets the second undo the first, and CodeMirror's reveal is the
 * cheapest one: it stops as soon as the caret is visible, which lands the
 * heading at the *bottom* of the viewport rather than the top.
 */
function goToLine (n, col = 0) {
  if (!reading() && editor) {
    const line = editor.state.doc.line(n)
    editor.dispatch({ selection: { anchor: Math.min(line.from + col, line.to) } })
    editor.focus()
  }
  scrollToLine(n)
  markOutlinePlace()
}

/** Put a named heading of the open note at the top of whichever view is up. */
function jumpToHeading (anchor) {
  const text = noteText()
  const block = String(anchor || '').trim().startsWith('^')
  const found = block
    ? findBlock(text, anchor)
    : findHeading(headings(text), anchor)
  if (!found) {
    toast(block
      ? `No block “${anchor}” in this note.`
      : `No heading “${anchor}” in this note.`)
    return
  }
  goToLine(found.line)
}

/* --------------------------------------------------------------- outline

   The note's headings, as a map of it. Both views answer for "which line is at
   the top", so the panel tracks the reader the same way in either — see
   `viewportLine`, which is the one address the two agree on.
   ================================================================== */

let outlineHeadings = []
let outlineRows = []

/* Collapsed branches belong to the note, not to the Outline pane itself. Keep
   them for the life of the window so switching panes or opening another note
   does not unfold the map the reader just arranged. The key is structural —
   heading ancestry plus sibling occurrence — so typing prose above a heading
   does not lose its state merely because its line number moved. */
const outlineCollapsed = new Map()

function outlineKeys (list) {
  const parents = []
  const seen = new Map()
  return list.map((heading) => {
    while (parents.length && parents[parents.length - 1].level >= heading.level) parents.pop()
    const parent = parents[parents.length - 1]?.key || ''
    const stem = `${heading.level}:${heading.slug || heading.text.toLowerCase()}`
    const occurrence = (seen.get(`${parent}\u0000${stem}`) || 0) + 1
    seen.set(`${parent}\u0000${stem}`, occurrence)
    const key = `${parent}/${stem}:${occurrence}`
    parents.push({ level: heading.level, key })
    return key
  })
}

function collapsedOutlineKeys () {
  const path = state.current?.path || ''
  if (!outlineCollapsed.has(path)) outlineCollapsed.set(path, new Set())
  return outlineCollapsed.get(path)
}

/** Apply every folded ancestor in one downward pass. A child keeps its own
 *  folded state while hidden, so opening its parent restores the smaller map
 *  exactly as the reader left it. */
function applyOutlineCollapse () {
  const collapsed = collapsedOutlineKeys()
  const parents = []
  for (const item of outlineRows) {
    while (parents.length && parents[parents.length - 1].level >= item.heading.level) parents.pop()
    item.el.hidden = parents.some((parent) => parent.collapsed)
    const folded = item.hasChildren && collapsed.has(item.key)
    item.el.classList.toggle('is-collapsed', folded)
    if (item.toggle) {
      item.toggle.setAttribute('aria-expanded', String(!folded))
      item.toggle.title = `${folded ? 'Expand' : 'Collapse'} ${item.heading.text}`
      item.toggle.setAttribute('aria-label', `${folded ? 'Expand' : 'Collapse'} ${item.heading.text}`)
    }
    parents.push({ level: item.heading.level, collapsed: folded })
  }
}

/* A current heading can sit inside a folded branch. In that case the visible
   parent is the useful position marker; lighting a display:none child would
   make the outline appear to have lost the reader altogether. */
function visibleOutlineIndex (index) {
  if (index < 0 || !outlineRows[index]?.el.hidden) return index
  const level = outlineHeadings[index]?.level || 7
  for (let i = index - 1; i >= 0; i--) {
    if (!outlineRows[i].el.hidden && outlineHeadings[i].level < level) return i
  }
  return index
}

function markOutlineRow (index) {
  const visible = visibleOutlineIndex(index)
  for (const [i, item] of outlineRows.entries()) {
    item.row.classList.toggle('is-here', i === visible)
  }
}

/* The row the reader asked for, and where that request left the view.
   Geometry alone cannot answer for the headings at the end of a note: nothing
   can scroll the last one to the top, because there is not enough document
   below it to do it with, so "the last heading above the fold" names the one
   before it and clicking the bottom row marks the row above. What the reader
   asked for is remembered instead, and held for exactly as long as the view
   stays where the request put it — the moment they scroll, geometry has the
   answer again. */
let outlinePin = null

/* --------------------------------------------------------- sidebar panes

   Four things live in the sidebar besides the vault: a map of whatever
   document is open, what points at it, what is misspelt in it, and what is
   known about it. They used to take turns with the file tree in a single
   panel, chosen by a strip of five tabs above it — which meant the sidebar's
   whole reason for being, the vault, was one click away from gone, and the
   pairing people actually want (the tree and one of the four) was the one
   arrangement the strip could not produce.

   So the tree is not a pane any more. It is the sidebar's upper panel, always,
   and the other four only ever appear *underneath* it, one at a time, chosen
   by the strip that belongs to that lower panel. Deliberately one more panel
   and not a general stacking system: two is the whole of the need, a third
   would be forty pixels of list each.

   The four bodies are siblings of the tree in the markup and stay so — a panel
   becomes the lower one by being moved after the divider, which is why
   `.pane-split` sits between them in index.html rather than wrapping anything.
   ================================================================== */

const sidebarOpen = () => el.app.dataset.sidebar === 'open'

/* Each lower panel's body and what to run when it comes up. Stated once so
   adding a fifth is one entry rather than four edits spread through this
   file — which is what the version before the strip had become. */
const PANES = {
  outline: { body: () => el.outlineList, paint: renderOutline },
  links: { body: () => el.linksList, paint: renderLinks },
  spelling: { body: () => el.spellingList, paint: renderSpelling },
  info: { body: () => el.infoPane, paint: renderInfo }
}

const paneTabBelow = (name) => el.paneTabsBelow.querySelector(`.pane-tab[data-pane="${name}"]`)

/* PDFs cannot participate in the Markdown backlink graph. Keep the control
   out of the tab order as well as out of sight, and hand an already-open Links
   pane to the PDF's own navigation instead of showing a known-empty panel. */
const sidebarPaneAvailable = (name) => name !== 'links' || !viewingPdf()

function syncSidebarPaneAvailability () {
  for (const name of Object.keys(PANES)) {
    paneTabBelow(name).hidden = !sidebarPaneAvailable(name)
  }
  // Opening a PDF under the Links panel closes it rather than emptying it.
  if (!sidebarPaneAvailable(state.paneBelow)) setPaneBelow(null, false)
}

/** Whether a named pane is on show — what everything that draws into the
 *  sidebar asks before doing the work. */
function paneOpen (name) {
  if (!sidebarOpen()) return false
  // The tree is up whenever the sidebar is; the rest have to be the lower one.
  return name === 'files' || paneBelow() === name
}

const outlineOpen = () => paneOpen('outline')

/** Which panel is underneath, or null when the sidebar is one panel tall. */
function paneBelow () {
  const wanted = state.paneBelow
  /* Never one that does not apply to what is open — a PDF has no backlinks,
     and the lower slot must not be the place that fact is discovered. */
  if (!wanted || !PANES[wanted] || !sidebarPaneAvailable(wanted)) return null
  return wanted
}

/**
 * @param {'outline'|'links'|'spelling'|'info'|null} pane  null closes it
 * @param {boolean} [remember]  false while restoring a stored setting
 */
function setPaneBelow (pane, remember = true) {
  /* A tab in the strip only ever chooses; closing the panel is the header's
     split button, or the shortcut that opened it. Selection follows focus in
     this tablist, and a tab that closed the strip it lives in would take the
     focus with it. */
  state.paneBelow = PANES[pane] && sidebarPaneAvailable(pane) ? pane : null
  if (remember) setSetting('paneBelow', state.paneBelow || undefined)
  renderPanes()
}

function renderPanes () {
  const below = paneBelow()

  for (const [name, spec] of Object.entries(PANES)) {
    const on = name === below
    spec.body().hidden = !on
    const tab = paneTabBelow(name)
    tab.hidden = !sidebarPaneAvailable(name)
    tab.classList.toggle('is-on', on)
    tab.setAttribute('aria-selected', String(on))
    /* Roving tabindex: the strip is one stop on the way through the app, and
       the arrow keys move within it — see the keydown handler below. Without
       this, Tab visited all four. */
    tab.tabIndex = on ? 0 : -1
    if (on) tab.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }

  el.paneSplit.hidden = !below
  el.paneSplitToggle.setAttribute('aria-pressed', String(!!below))
  el.paneSplitToggle.title = below ? 'Hide the second panel' : 'Show a second panel below'
  if (below) {
    /* Moved rather than copied. The body element is the panel — it holds the
       scroll position, the rendered rows and every listener bound to it — so
       putting the same element in a new place is how it changes place. */
    const body = PANES[below].body()
    if (body.previousElementSibling !== el.paneSplit) el.sidebar.append(body)
  }

  /* The outline tab names whatever the open document offers, and it says so
     whether or not the outline is the panel showing. */
  paintOutlineTab()
  if (below) PANES[below].paint()
  paintFoldToggle()
}

el.paneSplitToggle.addEventListener('click', () => {
  /* Opening it picks the most useful panel rather than asking: the outline
     under the files is the pairing this exists for. */
  setPaneBelow(paneBelow() ? null : 'outline')
})

el.paneTabsBelow.addEventListener('click', (event) => {
  const button = event.target.closest('.pane-tab')
  if (button) setPaneBelow(button.dataset.pane)
})

/* How tall the lower panel is, as a share of the sidebar rather than pixels:
   the sidebar's height is the window's, and a panel pinned at 240px is most of
   a short window and a strip of a tall one. */
const PANE_BELOW_DEFAULT = 0.4
const PANE_BELOW_MIN = 0.15
const PANE_BELOW_MAX = 0.75

function setPaneBelowHeight (share, remember = true) {
  const held = Math.min(PANE_BELOW_MAX, Math.max(PANE_BELOW_MIN, share))
  el.sidebar.style.setProperty('--pane-below', String(held))
  if (remember) setSetting('paneBelowHeight', held)
}

/* Its own handful of lines rather than a sixth case in panels.js: that module
   is about the three columns and the arithmetic that keeps the note readable
   between them, none of which is true of a divider inside one panel. */
el.paneSplitGrip.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  el.paneSplitGrip.setPointerCapture(event.pointerId)
  el.paneSplitGrip.classList.add('is-dragging')

  const shareAt = (clientY) => {
    const box = el.sidebar.getBoundingClientRect()
    // Measured from the bottom, because that is the edge the lower panel owns.
    return box.height ? (box.bottom - clientY) / box.height : PANE_BELOW_DEFAULT
  }
  const move = (moved) => setPaneBelowHeight(shareAt(moved.clientY), false)
  const done = (ended) => {
    el.paneSplitGrip.releasePointerCapture(ended.pointerId)
    el.paneSplitGrip.classList.remove('is-dragging')
    el.paneSplitGrip.removeEventListener('pointermove', move)
    el.paneSplitGrip.removeEventListener('pointerup', done)
    el.paneSplitGrip.removeEventListener('pointercancel', done)
    // Written once, at the end, rather than on every frame of the drag.
    setPaneBelowHeight(shareAt(ended.clientY))
  }
  el.paneSplitGrip.addEventListener('pointermove', move)
  el.paneSplitGrip.addEventListener('pointerup', done)
  el.paneSplitGrip.addEventListener('pointercancel', done)
})

el.paneSplitGrip.addEventListener('dblclick', () => setPaneBelowHeight(PANE_BELOW_DEFAULT))

el.paneSplitGrip.addEventListener('keydown', (event) => {
  const step = event.shiftKey ? 0.08 : 0.02
  const now = Number(el.sidebar.style.getPropertyValue('--pane-below')) || PANE_BELOW_DEFAULT
  if (event.key === 'ArrowUp') setPaneBelowHeight(now + step)
  else if (event.key === 'ArrowDown') setPaneBelowHeight(now - step)
  else return
  event.preventDefault()
})

/**
 * ⌘⇧E and ⌘⇧K, the menu, and the command palette all land here.
 *
 * Showing a panel means opening the sidebar too if it is closed — asking for a
 * panel that is not on screen should produce the panel, not a stored preference
 * that takes effect the next time you open the sidebar. Asking for the one
 * already up puts it away, so the same key is the way out of it.
 *
 * The files are not a panel to be shown any more, they are the sidebar's upper
 * half; asking for them is asking for the sidebar.
 */
function togglePane (name, on = !paneOpen(name)) {
  if (on && !sidebarOpen()) toggleSidebar(true)
  if (name === 'files') return
  setPaneBelow(on ? name : null)
}

const toggleOutline = (on) => togglePane('outline', on)

/* A tablist is navigated with the arrow keys, not with Tab — Tab is how you
   leave it for the panel it controls. The strip declared `role="tablist"` and
   had none of that, so the four tabs were four separate stops on the way to
   the tree, which is the failure the role exists to prevent.

   Hidden tabs are skipped rather than focused: which panes exist depends on
   what is open (a PDF has contents, a note has an outline), and stepping onto
   a tab that is not there would look like the keys had stopped working. */
el.paneTabsBelow?.addEventListener('keydown', (event) => {
  const STEP = { ArrowRight: 1, ArrowLeft: -1, Home: 0, End: 0 }
  if (!(event.key in STEP)) return

  const tabs = Object.keys(PANES).map(paneTabBelow).filter((tab) => !tab.hidden)
  if (tabs.length < 2) return
  const from = tabs.indexOf(document.activeElement)
  if (from < 0) return

  event.preventDefault()
  const to = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      // Wraps, which is what a tablist does at either end.
      : (from + STEP[event.key] + tabs.length) % tabs.length

  /* Selection follows focus. With four cheap panels that is the behaviour the
     spec prefers — it saves a keystroke and there is nothing to commit. */
  tabs[to].focus()
  tabs[to].click()
})

/**
 * The tab's name, which is the name of whatever it would show: a note has an
 * outline, a PDF has the contents its publisher wrote — or, once there are
 * any, the highlights the reader made.
 *
 * Kept out of the two render functions below because both of them open by
 * giving up when the outline is not the pane on show. With the file tree up,
 * that left the label reading whatever the last document set, so opening a
 * note after a PDF put it behind a tab marked "Contents".
 */
function paintOutlineTab () {
  el.paneOutlineTab.textContent = viewingPdf()
    ? (pdf.marks().length ? 'Highlights' : 'Contents')
    : 'Outline'
}

/* The heading list as last drawn, so a redraw that would change nothing can be
   skipped. This runs every 250ms while typing, and a keystroke almost never
   lands in a heading — the common case is the same list, byte for byte. */
let outlineSig = ''

function renderOutline () {
  // Before the early return: the tab is on screen in either pane.
  paintOutlineTab()
  if (!outlineOpen()) return
  if (viewingPdf()) { renderPdfOutline(); return }

  /* A live page has an outline, but it is the page's own and reaching into a
     guest to take it would mean running Tulip's code inside somebody else's
     site — which is the one thing the fence around a guest exists to prevent.
     Saying there is nothing here beats a panel that silently shows the
     headings of whatever note was open before. */
  /* The kinds with nothing this panel can list. A source file has structure,
     but it is the language's and not the document's — reading it would mean a
     definition scanner per language, which is a different feature from an
     outline of headings. Saying so beats a panel silently showing the last
     note's headings under a Python file. */
  if (viewingSite() || viewingWhiteboard() || viewingCode() || viewingData() ||
      viewingNotebook()) {
    outlineSig = ''
    pdfOutlineRows = []
    outlineHeadings = []
    outlineRows = []
    outlinePin = null
    const empty = document.createElement('p')
    empty.className = 'outline-empty'
    empty.textContent = viewingWhiteboard()
      ? 'Use frames on the canvas to organise this whiteboard.'
      : viewingCode()
          ? 'A source file has no outline here.'
          : viewingData()
              ? 'A table has no outline here.'
              : viewingNotebook()
                  ? 'A notebook has no outline here.'
                  : 'A website has no outline here.'
    el.outlineList.replaceChildren(empty)
    return
  }

  const next = state.current ? headings(noteText()) : []
  const sig = (state.current?.path || 'none') + SHAPE_SEP +
    next.map((h) => `${h.level}${SHAPE_SEP}${h.line}${SHAPE_SEP}${h.text}`).join('\n')
  if (sig === outlineSig && el.outlineList.childElementCount) {
    // Same headings, same rows: the DOM stands, the pin keeps meaning what the
    // reader asked for, and only the here-mark may need to move.
    outlineHeadings = next
    markOutlinePlace()
    return
  }
  outlineSig = sig

  pdfOutlineRows = []
  outlineHeadings = next
  outlineRows = []
  el.outlineList.replaceChildren()
  // The rows are about to be rebuilt, so an index into the old ones means
  // nothing — a heading typed above the pinned one would shift it.
  outlinePin = null

  if (!outlineHeadings.length) {
    const empty = document.createElement('p')
    empty.className = 'outline-empty'
    empty.textContent = state.current ? 'This note has no headings.' : 'No note is open.'
    el.outlineList.append(empty)
    return
  }

  /* Indented by depth, but relative to the shallowest heading present — a note
     whose headings all start at ## should not be drawn permanently indented. */
  const top = Math.min(...outlineHeadings.map((h) => h.level))
  const keys = outlineKeys(outlineHeadings)

  const frag = document.createDocumentFragment()
  for (const [index, heading] of outlineHeadings.entries()) {
    const item = document.createElement('div')
    item.className = 'outline-item'
    item.style.setProperty('--depth', String(heading.level - top))

    const hasChildren = outlineHeadings[index + 1]?.level > heading.level
    let toggle = null
    if (hasChildren) {
      toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'outline-toggle'
      toggle.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2.5 4 3.5-4 3.5"/></svg>'
      toggle.addEventListener('click', () => {
        const collapsed = collapsedOutlineKeys()
        const key = keys[index]
        if (collapsed.has(key)) collapsed.delete(key)
        else collapsed.add(key)
        applyOutlineCollapse()
        markOutlinePlace()
      })
      item.append(toggle)
    }

    const row = document.createElement('button')
    row.type = 'button'
    row.className = `outline-row is-h${heading.level}${hasChildren ? ' has-children' : ''}`
    /* Depth, not a pixel offset: the row's indent, its guide rule and the
       level's colour are all drawn from it in CSS. */
    row.style.setProperty('--depth', String(heading.level - top))
    row.dataset.line = String(heading.line)
    row.dataset.level = `H${heading.level}`
    row.title = `H${heading.level} · ${heading.text}`

    const label = document.createElement('span')
    label.className = 'outline-text'
    label.textContent = heading.text
    row.append(label)
    row.addEventListener('click', () => {
      goToLine(heading.line)
      // Recorded after the jump, so the pin holds the position the jump
      // actually reached rather than the one it aimed at.
      outlinePin = { index, at: viewportLine() }
      markOutlinePlace()
    })
    item.append(row)
    outlineRows.push({ el: item, row, toggle, heading, index, key: keys[index], hasChildren })
    frag.append(item)
  }
  el.outlineList.append(frag)
  applyOutlineCollapse()
  markOutlinePlace()
}

/**
 * The same panel, for a PDF: what the document says it contains, and what the
 * reader has marked on it.
 *
 * Both belong here rather than in a panel of their own. The outline is where
 * you look to move about a long document, and in a PDF that is either the
 * publisher's table of contents or your own highlights — usually both.
 */
let pdfOutlineRows = []

function renderPdfOutline () {
  outlineHeadings = []
  outlineRows = []
  pdfOutlineRows = []
  // The panel no longer holds the rows the note signature describes, so the
  // next note render must not be talked out of rebuilding them.
  outlineSig = ''
  el.outlineList.replaceChildren()

  const contents = pdfContents
  const marks = pdf.marks()
  // The tab says what it is holding — see `paintOutlineTab`, which names it
  // for both kinds of document and runs whichever pane is up.
  paintOutlineTab()

  if (!contents.length && !marks.length) {
    const empty = document.createElement('p')
    empty.className = 'outline-empty'
    empty.textContent = 'Select text in the PDF to highlight it.'
    el.outlineList.append(empty)
    return
  }

  const frag = document.createDocumentFragment()

  const heading = (text) => {
    const h = document.createElement('p')
    h.className = 'outline-group'
    h.textContent = text
    frag.append(h)
  }

  if (contents.length) {
    if (marks.length) heading('Contents')
    // Indented relative to the shallowest entry, the way a note's headings are.
    const top = Math.min(...contents.map((c) => c.level))
    for (const entry of contents) {
      const row = document.createElement('button')
      row.type = 'button'
      const level = Math.min(entry.level, 6)
      row.className = `outline-row is-h${level}`
      row.style.setProperty('--depth', String(entry.level - top))
      row.dataset.level = `H${level}`

      const label = document.createElement('span')
      label.className = 'outline-text'
      label.textContent = entry.title
      row.append(label)
      row.title = `${entry.title} — page ${entry.page}`
      // The entry rather than its page: a section starting halfway down a page
      // should put its heading on screen, which is the viewer's business.
      row.addEventListener('click', () => pdf.goToOutline(entry))
      pdfOutlineRows.push({ el: row, page: entry.page, contents: true })
      frag.append(row)
    }
  }

  if (marks.length) {
    if (contents.length) heading('Highlights')
    for (const mark of marks) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'outline-row is-mark'
      row.dataset.color = mark.color

      const page = document.createElement('span')
      page.className = 'outline-mark-page'
      page.textContent = String(mark.rects[0]?.page || 1)

      const text = document.createElement('span')
      text.className = 'outline-mark-text'
      text.textContent = mark.text || '(no text)'

      row.append(page, text)
      row.title = mark.text
      row.addEventListener('click', () => pdf.goToMark(mark.id))
      /* The panel is a list of passages, so the gesture that removes one lives
         here too — otherwise a highlight can only be undone on the page it is
         on, which for a document you are scrolling through is the wrong place. */
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        renderContextMenu([
          // Electron's clipboard: `navigator.clipboard` refuses when the
          // window is not focused, and the old optional chain hid the refusal.
          { label: 'Copy passage', run: () => api.copy(mark.text) },
          {
            label: 'Ask the copilot',
            run: () => {
              copilot.open()
              copilot.quote(quoteFor({ text: mark.text, page: mark.rects[0]?.page || 1 }))
            }
          },
          { label: 'Remove highlight', run: () => pdf.removeMark(mark.id) }
        ], event)
      })

      pdfOutlineRows.push({ el: row, page: mark.rects[0]?.page || 1, contents: false })
      frag.append(row)
    }
  }

  el.outlineList.append(frag)
  markOutlinePlace()
}

/** Light up the heading the reader is currently under. */
/**
 * Whether the view is as far down as it goes — and had somewhere to go in the
 * first place. The second half matters: a note short enough to fit the window
 * is trivially "at the end", and without the check every such note would mark
 * its last heading no matter where the cursor was.
 */
function atDocumentEnd () {
  const box = reading() ? el.reading : editor.scrollDOM
  const slack = box.scrollHeight - box.clientHeight
  return slack > 4 && box.scrollTop >= slack - 2
}

function markOutlinePlace () {
  if (!outlineOpen()) return

  if (viewingPdf()) {
    const at = pdf.page()

    /* One contents entry, but every highlight on the page.
       A section is being read until the next one starts, so the entry to mark
       is the last one at or before this page — the rule a note's outline
       follows. Marking every entry whose page matches lights up the whole of a
       page that three sections happen to begin on. Highlights are the other
       case: a page can hold several, and none is more current than the rest. */
    let section = -1
    for (const [i, row] of pdfOutlineRows.entries()) {
      if (row.contents && row.page <= at) section = i
    }
    for (const [i, row] of pdfOutlineRows.entries()) {
      row.el.classList.toggle('is-here', row.contents ? i === section : row.page === at)
    }
    return
  }
  if (viewingWhiteboard() || viewingSite()) return

  if (!outlineHeadings.length) return
  const line = viewportLine()

  /* A row that was asked for stays marked until the view moves off where the
     request left it. This is what makes clicking the last heading mark the
     last heading. */
  if (outlinePin && outlinePin.at === line) {
    markOutlineRow(outlinePin.index)
    return
  }
  outlinePin = null

  // The last heading at or above the fold is the one being read.
  let active = -1
  for (let i = 0; i < outlineHeadings.length; i++) {
    if (outlineHeadings[i].line <= line + 1) active = i
    else break
  }

  /* Except at the very end, which is inside the last section whatever the fold
     says. Without this the final heading is unmarkable by scrolling too: the
     text below it is shorter than the window, so it never reaches the top. */
  if (atDocumentEnd()) active = outlineHeadings.length - 1

  markOutlineRow(active)
}

/* Scrolling either view moves the mark. Coalesced onto a frame: a scroll fires
   far more often than the panel can usefully change. */
let outlineTick = null
function queueOutlineMark () {
  if (outlineTick || !outlineOpen()) return
  outlineTick = requestAnimationFrame(() => { outlineTick = null; markOutlinePlace() })
}

el.reading.addEventListener('scroll', queueOutlineMark, { passive: true })
/* The editing view's scroller does not exist until the editor does — attached
   in ensureEditor, beside the other listeners that need one. */
function watchEditorScroll () {
  editor.scrollDOM.addEventListener('scroll', queueOutlineMark, { passive: true })
}

/* ------------------------------------------------------------- backlinks

   The outline reads a note downward; this reads it sideways. Three lists: the
   notes this one points at, the notes that point here, and the notes that say
   the name without pointing — which is the more useful of the three, because
   it is the list of links you have not made yet.

   Both are scanned in the main process, off the same index the search reads.
   Nothing is cached here: a backlink list is a fact about every *other* note
   in the vault, so the only honest moment to ask is when the panel is about
   to be looked at.
   ================================================================== */

/* Bumped on every ask, so a slow scan of the note you have left cannot paint
   over the note you are now on. */
let linksToken = 0

function linksMessage (text) {
  const p = document.createElement('p')
  p.className = 'outline-empty'
  p.textContent = text
  el.linksList.replaceChildren(p)
}

async function renderLinks () {
  if (!paneOpen('links')) return

  const token = ++linksToken
  if (!state.current) { linksMessage('No note is open.'); return }
  if (viewingPdf()) {
    // A PDF is not a link target: nothing in the vault can write `[[…]]` at it.
    linksMessage('A PDF has no backlinks.')
    return
  }
  if (viewingWhiteboard() || viewingSite() || viewingCode() || viewingData() ||
      viewingNotebook()) {
    linksMessage(viewingWhiteboard()
      ? 'Whiteboard note cards link out to notes; boards are not backlink targets yet.'
      : viewingCode() || viewingData() || viewingNotebook()
        // Nothing in the vault can write `[[…]]` at one — the same as a PDF.
        ? 'This file has no backlinks.'
        : 'A website has no backlinks.')
    return
  }

  // Only on a first draw, so switching notes does not blank a panel that is
  // about to be filled from an index already in memory.
  if (!el.linksList.childElementCount) linksMessage('Reading the vault…')

  let found
  try {
    found = await api.links.to(state.current.path)
  } catch {
    if (token === linksToken) linksMessage('The vault could not be read.')
    return
  }
  if (token !== linksToken || !paneOpen('links')) return

  const { linked = [], unlinked = [], outgoing = [] } = found
  if (!linked.length && !unlinked.length && !outgoing.length) {
    linksMessage('Nothing links here, and this note links nowhere.')
    return
  }

  const frag = document.createDocumentFragment()
  if (outgoing.length) frag.append(outgoingSection(outgoing))
  if (linked.length) frag.append(linkSection('Linked mentions', linked, 'linked'))
  if (unlinked.length) frag.append(linkSection('Unlinked mentions', unlinked, 'unlinked'))
  el.linksList.replaceChildren(frag)
}

/**
 * The notes this one points at — outgoing links, one row per distinct target.
 *
 * A target the vault has no note for is a note waiting to be written, so it
 * stays on the list, marked as missing; clicking it takes the ordinary
 * wikilink path, which creates it in the folder this note sits in.
 */
function outgoingSection (targets) {
  const section = document.createElement('section')
  section.className = 'link-group is-outgoing'

  const head = document.createElement('h3')
  head.className = 'link-head'
  head.append(document.createTextNode('Linked from here'))
  const count = document.createElement('span')
  count.className = 'link-count'
  count.textContent = String(targets.length)
  head.append(count)
  section.append(head)

  for (const target of targets) {
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'link-note' + (target.missing ? ' is-missing' : '')
    name.title = target.missing
      ? `“${target.target}” — not created yet; click to create`
      : (target.path || target.target)
    const label = document.createElement('span')
    label.className = 'link-note-name'
    label.textContent = target.name
    name.append(label)
    if (target.missing) {
      const badge = document.createElement('span')
      badge.className = 'link-note-count is-missing'
      badge.textContent = '+'
      name.append(badge)
    }
    name.addEventListener('click', async () => {
      if (target.missing) { openWikilink(target.target); return }
      if (!await openNote(target.path)) return
      revealInTree(target.path)
    })
    section.append(name)
  }
  return section
}

/**
 * One list, headed by what it is and how much of it there is.
 *
 * The count is of mentions rather than of notes: "9" against three notes is
 * the honest number, and it is the one that says whether the list is worth
 * reading before you read it.
 */
function linkSection (title, notes, kind) {
  const section = document.createElement('section')
  section.className = `link-group is-${kind}`

  const head = document.createElement('h3')
  head.className = 'link-head'
  head.append(document.createTextNode(title))
  const count = document.createElement('span')
  count.className = 'link-count'
  count.textContent = String(notes.reduce((n, note) => n + note.total, 0))
  head.append(count)
  section.append(head)

  for (const note of notes) {
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'link-note'
    name.title = note.path
    const label = document.createElement('span')
    label.className = 'link-note-name'
    label.textContent = note.name
    name.append(label)
    // Only when it is more than the rows below it are showing — a "2" over two
    // visible lines is a number nobody needed.
    if (note.total > note.hits.length) {
      const more = document.createElement('span')
      more.className = 'link-note-count'
      more.textContent = String(note.total)
      name.append(more)
    }
    name.addEventListener('click', () => openMention(note.path, note.hits[0]))
    section.append(name)

    for (const hit of note.hits) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'link-hit'
      row.textContent = hit.text
      row.title = `${note.name} · line ${hit.line}`
      row.addEventListener('click', () => openMention(note.path, hit))
      section.append(row)
    }
  }
  return section
}

/**
 * Open the note a mention is in, at the line it is on.
 *
 * Only if it opened. A note deleted since the panel was drawn leaves the
 * previous note on screen, and scrolling *that* to the line the mention was on
 * would move the reader somewhere nothing asked for.
 */
async function openMention (path, hit) {
  if (!await openNote(path)) return
  revealInTree(path)
  if (hit) goToLine(Math.min(hit.line, editor.state.doc.lines), hit.col || 0)
}

/* The panel is about a note, so it is redrawn when the note changes — and when
   the vault does, since a backlink is something another note did. Debounced:
   a save, its watcher tick and the tree reload behind it arrive together. */
let linksTimer = null
function queueLinks () {
  if (!paneOpen('links')) return
  clearTimeout(linksTimer)
  linksTimer = setTimeout(renderLinks, 200)
}

const INFO_WORD = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]|[[\p{L}\p{N}'’\-]--[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]]+/gv

function fileSize (bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`
  const units = ['kB', 'MB', 'GB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function infoRow (label, value, title, onClick = null) {
  const row = node('div', 'info-row')
  row.append(node('span', 'info-label', label))
  const said = node(onClick ? 'button' : 'span', `info-value${onClick ? ' is-copy' : ''}`, String(value))
  if (title) said.title = title
  if (onClick) {
    said.type = 'button'
    said.setAttribute('aria-label', `Copy ${label.toLowerCase()} path`)
    said.addEventListener('click', onClick)
  }
  row.append(said)
  return row
}

function infoSection (title) {
  const section = node('section', 'info-group')
  section.append(node('h3', 'info-head', title))
  return section
}

function textFacts (text) {
  const parsed = parseFrontmatter(text)
  const body = parsed.range ? text.slice(parsed.range.end) : text
  let words = 0
  const matches = body.matchAll(INFO_WORD)
  while (!matches.next().done) words++
  const links = new Set()
  for (const match of body.matchAll(/(^|[^!])\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    links.add(match[2].trim().toLowerCase())
  }
  return {
    words,
    characters: body.length,
    /* From the text this was handed, not from the parsed document: the Info
       pane is painted on the way into every note, and a note opened into the
       reading view has no parsed document to count. */
    headings: headings(text).length,
    links: links.size
  }
}

/* ------------------------------------------------------------- spelling

   The words the dictionary does not know, and where each of them is.

   One pass answers two questions: which words to list in the pane, and which
   ranges the editor should underline. They used to be answered separately —
   the pane from here, the underline by Chromium — and the two disagreed, since
   Chromium knows nothing of code fences or wikilinks and, in a CodeMirror
   document whose lines are rebuilt as you type, mostly never marked anything
   at all. So the underline is drawn from this answer too (editor.setMisspellings),
   and the pass runs whether or not the pane is open.

   The checking itself is main's, over a Hunspell dictionary of its own plus
   the custom words Chromium was taught — see the spelling section of
   electron/main.js — so a word accepted in one place is accepted in both.

   Which words are even asked about is the interesting half, and it lives in
   src/spelling.js: a note is prose with code, maths, links and filenames mixed
   into it, and a panel that lists those is a panel nobody keeps open.
   ================================================================== */

let spellingToken = 0
let spellingKeys = ''
/* Where each word's places are, refreshed on every pass — the rows survive an
   edit that adds no new mistakes, but every position in the note behind them
   has moved. */
let spellingGroups = new Map()
/* Which occurrence the next click on a word goes to, so clicking a word that
   appears four times walks the four rather than returning to the first. */
const spellingStep = new Map()

function spellingMessage (text) {
  spellingKeys = ''
  spellingGroups = new Map()
  el.spellingList.replaceChildren(node('p', 'outline-empty', text))
}

/** Select one occurrence of a flagged word and put it on screen. */
async function goToSpelling (key) {
  const group = spellingGroups.get(key)
  if (!group?.at.length) return
  const step = ((spellingStep.get(key) ?? -1) + 1) % group.at.length
  spellingStep.set(key, step)
  const at = group.at[step]

  /* Awaited before the view is switched, not after. `setView` defers itself
     when there is no editor — it returns, fetches one and calls itself again —
     so everything below it used to run in the reading view against an editor
     that did not exist yet. With one already in hand the switch runs straight
     through and the caret has somewhere to land. */
  const view = await ensureEditor()
  // A misspelling is something to fix, and fixing happens in the editing view.
  if (reading()) setView('edit')
  /* Selected rather than merely scrolled to: the next thing after finding a
     typo is typing over it. The scroll is left to scrollToLine for the reason
     goToLine explains — two alignments in one gesture fight each other. */
  view.dispatch({ selection: { anchor: at.from, head: at.to } })
  view.focus()
  scrollToLine(view.state.doc.lineAt(at.from).number)
}

/**
 * Nothing to say about this document: no underlines, and the pane's reason for
 * having no rows — which is only worth writing if anyone is looking at it.
 */
function spellingBlank (why) {
  editor?.setMisspellings([])
  if (paneOpen('spelling')) spellingMessage(why)
}

/**
 * One pass of the dictionary over the open note. Draws the underlines always,
 * and the pane's rows when the pane is open.
 */
async function renderSpelling () {
  if (!state.current) { spellingBlank('No note is open.'); return }
  /* Source and data files are here for the same reason as the rest: prose is
     what a spell checker is for, and underlining every identifier in a Python
     file would be a panel of noise nobody can act on. */
  if (viewingPdf() || viewingSite() || viewingWhiteboard() ||
      viewingCode() || viewingData() || viewingNotebook()) {
    spellingBlank('Spelling is checked in notes.')
    return
  }
  if (state.cfg?.spellcheck === false) {
    spellingBlank('Spellcheck is off — turn it on in Settings.')
    return
  }
  /* Spelling reads the *parsed* document, because what it must not underline —
     code, maths, wikilink targets, the frontmatter block — is known from the
     syntax tree and not from the text. There is no tree until the editing
     stack arrives, and this runs on the way into every note, so on a launch
     into the reading view it used to be reached with no editor at all and
     throw. `ensureEditor` calls it again the moment there is one to ask. */
  if (!editor) { spellingBlank('Checking the spelling…'); return }

  const text = editor.state.doc.toString()
  const groups = groupWords(wordsIn(text, editor.state))
  // Positions first: the rows below may not be rebuilt, and a click has to
  // land where the word is now rather than where it was two edits ago.
  spellingGroups = groups

  const asked = [...groups.values()].map((group) => group.word)
  if (!asked.length) { spellingBlank('Nothing to check in this note.'); return }

  const token = ++spellingToken
  const measured = editor.state.doc.length
  let flagged
  try {
    flagged = new Set(await api.spell.check(asked))
  } catch {
    spellingBlank('The dictionary could not be read.')
    return
  }
  // A newer pass has started while the dictionary was answering — this one is
  // about a document that may no longer be open.
  if (token !== spellingToken) return
  spellingGroups = groups

  const rows = [...groups.entries()]
    .filter(([, group]) => flagged.has(group.word))
    .sort((a, b) => a[1].at[0].from - b[1].at[0].from)

  /* The underlines, which are the half of this that shows whether the pane is
     open or shut. Every place of every flagged word, at the positions this pass
     measured — so if the document moved under it while main was answering they
     are left alone, and the pass queued by that edit draws them a moment later
     against the text it is actually looking at. */
  if (editor.state.doc.length === measured) {
    editor?.setMisspellings(rows.flatMap(([, group]) => group.at))
  }

  if (!paneOpen('spelling')) return
  if (!rows.length) { spellingMessage('No spelling mistakes in this note.'); return }

  /* The rows stand while the set of flagged words stands. Rebuilding them on
     every keystroke would throw away the step through a repeated word — and
     the row you were about to click. */
  const keys = rows.map(([key, group]) => `${key}:${group.at.length}`).join(' ')
  if (keys === spellingKeys && el.spellingList.childElementCount) return
  spellingKeys = keys

  // Words that left the list have no place left to step through.
  const live = new Set(rows.map(([key]) => key))
  for (const key of [...spellingStep.keys()]) if (!live.has(key)) spellingStep.delete(key)

  const frag = document.createDocumentFragment()
  for (const [key, group] of rows) {
    const item = node('div', 'spelling-item')

    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'spelling-row'
    row.title = group.at.length > 1
      ? `“${group.word}” · ${group.at.length} places — click to step through them`
      : `“${group.word}” — click to go to it`
    row.append(node('span', 'spelling-word', group.word))
    if (group.at.length > 1) {
      row.append(node('span', 'spelling-count', String(group.at.length)))
    }
    row.addEventListener('click', () => goToSpelling(key))

    /* The other half of a spelling panel: half of what it flags is not a
       mistake but a name it has never met. Teaching it here is the same act as
       "Learn Spelling" in the editor's own context menu, and writes to the same
       list — so the red underline goes too. */
    const teach = document.createElement('button')
    teach.type = 'button'
    teach.className = 'spelling-teach'
    teach.title = `Add “${group.word}” to the dictionary`
    teach.setAttribute('aria-label', `Add “${group.word}” to the dictionary`)
    teach.textContent = '+'
    teach.addEventListener('click', async (event) => {
      event.stopPropagation()
      await api.dictionary.add(group.word)
      // The word is gone from the list, so the list is what has to be redrawn
      // — not this row, which is about to stop existing.
      spellingKeys = ''
      renderSpelling()
    })

    item.append(row, teach)
    frag.append(item)
  }
  el.spellingList.replaceChildren(frag)
}

let spellingTimer = null

function queueSpelling () {
  /* Not gated on the pane any more: the underlines are wanted in the editor
     whether or not anything is listing them. Switching spellcheck off is the
     one thing that stops the pass, and it clears the marks on its way out
     (editor.setSpellcheck) rather than leaving them for a pass that will not
     run. */
  if (state.cfg?.spellcheck === false) return
  clearTimeout(spellingTimer)
  /* Slower than the outline's quarter second: this crosses to another process
     and back, and a word half-typed is a misspelling of nothing. */
  spellingTimer = setTimeout(renderSpelling, 500)
}

let infoToken = 0

async function renderInfo ({ force = false } = {}) {
  if (!paneOpen('info')) return
  if (!force && el.infoPane.contains(document.activeElement)) return
  const token = ++infoToken
  if (!state.current) {
    el.infoPane.replaceChildren(node('p', 'outline-empty', 'No document is open.'))
    return
  }
  const path = state.current.path
  /* Last-known tags and stat paint immediately — on a typing tick they are
     already right, and holding the whole pane for two IPC round-trips left
     it blank exactly when the reader glanced at it. */
  const cached = infoCache.get(path)
  if (cached) paintInfo(path, cached.tags, cached.stat)
  const [tags, stat] = await Promise.all([
    api.fileTags.get(path).catch(() => []),
    api.file.info(path).catch(() => null)
  ])
  if (token !== infoToken || !paneOpen('info')) return
  const changed = !cached ||
    JSON.stringify([cached.tags, cached.stat]) !== JSON.stringify([tags, stat])
  infoCache.set(path, { tags, stat })
  if (changed) paintInfo(path, tags, stat)
}

const infoCache = new Map() // path -> { tags, stat } as last painted

function paintInfo (path, tags, stat) {
  const file = infoSection('File')
  file.append(infoRow('Name', path.split('/').pop()))
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  file.append(infoRow('Folder', folder || 'Vault root', `Copy ${systemPath(folder)}`, () => copyPaths([folder])))
  if (stat?.ok) {
    file.append(infoRow('Size', fileSize(stat.size)))
    if (stat.created) file.append(infoRow('Created', when(stat.created), new Date(stat.created).toLocaleString()))
    file.append(infoRow('Modified', when(stat.modified), new Date(stat.modified).toLocaleString()))
  }

  const sections = [file]
  if (!viewingPdf() && !viewingSite() && !viewingWhiteboard()) {
    const facts = textFacts(noteText())
    const text = infoSection('Text')
    text.append(infoRow('Words', facts.words.toLocaleString()))
    text.append(infoRow('Characters', facts.characters.toLocaleString()))
    if (facts.headings) text.append(infoRow('Headings', facts.headings))
    if (facts.links) text.append(infoRow('Links out', facts.links))
    sections.push(text)
  }

  const tagSection = infoSection('Tags')
  tagSection.classList.add('is-tags')
  const wrap = node('div', 'tags-editor file-tags-editor')
  const chips = node('div', 'tags-chips')
  const commit = async (next) => {
    await api.fileTags.set(path, next)
    if (state.current?.path === path) renderInfo({ force: true })
  }
  for (const [index, tag] of tags.entries()) {
    const chip = node('span', 'tag-chip')
    chip.append(node('span', 'tag-chip-label', `#${tag}`))
    const remove = node('button', 'tag-chip-remove', '×')
    remove.type = 'button'
    remove.title = `Remove #${tag}`
    remove.setAttribute('aria-label', `Remove tag ${tag}`)
    remove.addEventListener('click', () => commit(tags.filter((_tag, at) => at !== index)))
    chip.append(remove)
    chips.append(chip)
  }
  const input = node('input', 'tag-input')
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = tags.length ? 'Add another tag…' : 'Add a tag…'
  input.setAttribute('aria-label', 'Add tag')
  const add = () => {
    const fresh = input.value.trim().replace(/^#+/, '').toLowerCase()
    if (!fresh || tags.includes(fresh)) return false
    input.value = ''
    commit([...tags, fresh])
    return true
  }
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add()
    } else if (event.key === 'Backspace' && !input.value && tags.length) {
      event.preventDefault()
      commit(tags.slice(0, -1))
    }
  })
  input.addEventListener('blur', add)
  wrap.append(chips, input)
  tagSection.append(wrap)
  sections.push(tagSection)
  /* Aliases are the other names the quick switcher and `[[` resolution answer
     to. Unlike tags they live in the note's own head, so this editor edits
     the note — which is why it only appears for markdown notes. */
  if (NOTE_EXT.test(path) && !viewingPdf() && !viewingSite() && !viewingWhiteboard() &&
      !viewingData() && !viewingNotebook()) {
    sections.push(aliasSection(path))
  }
  el.infoPane.replaceChildren(...sections)
}

/**
 * The note's aliases as removable chips with a field to add one — the same
 * editor the tags get, writing to a different place: `aliases:` in the head,
 * through the one frontmatter writer, so every line the head holds that is
 * not this list survives the edit untouched.
 */
function aliasSection (path) {
  const section = infoSection('Aliases')
  section.classList.add('is-tags')

  const parsed = parseFrontmatter(noteText())
  const prop = parsed.entries.find((entry) => entry.key !== undefined && /^alias(es)?$/i.test(entry.key))
  const aliases = prop
    ? (Array.isArray(prop.value) ? prop.value : [prop.value])
        .map((value) => String(value ?? '').trim()).filter(Boolean)
    : []

  const commit = async (next) => {
    if (state.current?.path !== path) return
    // Editing the head is editing the note, and the palette-less path here
    // can be reached from the reading view.
    const view = await ensureEditor()
    const now = view.state.doc.toString()
    const updated = writeListProp(now, prop?.key || 'aliases', next)
    if (updated === now) return
    /* Only the head moves. Replacing the whole document would map the caret
       to the end and turn one alias into a full-note change in the history. */
    const oldHead = frontmatterRange(now)?.end ?? 0
    const newHead = frontmatterRange(updated)?.end ?? 0
    view.dispatch({ changes: { from: 0, to: oldHead, insert: updated.slice(0, newHead) } })
    renderInfo({ force: true })
  }

  const wrap = node('div', 'tags-editor file-tags-editor')
  const chips = node('div', 'tags-chips')
  for (const [index, alias] of aliases.entries()) {
    const chip = node('span', 'tag-chip')
    chip.append(node('span', 'tag-chip-label', alias))
    const remove = node('button', 'tag-chip-remove', '×')
    remove.type = 'button'
    remove.title = `Remove “${alias}”`
    remove.setAttribute('aria-label', `Remove alias ${alias}`)
    remove.addEventListener('click', () => commit(aliases.filter((_alias, at) => at !== index)))
    chip.append(remove)
    chips.append(chip)
  }
  const input = node('input', 'tag-input alias-input')
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = aliases.length ? 'Add another alias…' : 'Add an alias…'
  input.setAttribute('aria-label', 'Add alias')
  const add = () => {
    const fresh = input.value.trim()
    if (!fresh || aliases.some((one) => one.toLowerCase() === fresh.toLowerCase())) return false
    input.value = ''
    commit([...aliases, fresh])
    return true
  }
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      add()
    } else if (event.key === 'Backspace' && !input.value && aliases.length) {
      event.preventDefault()
      commit(aliases.slice(0, -1))
    }
  })
  input.addEventListener('blur', add)
  wrap.append(chips, input)
  section.append(wrap)
  return section
}

el.editorHost.addEventListener('tulip:tags', () => {
  togglePane('info', true)
  requestAnimationFrame(() => {
    el.infoPane.querySelector('.tag-input')?.focus()
  })
})

let infoTimer = null
function queueInfo () {
  if (!paneOpen('info')) return
  clearTimeout(infoTimer)
  infoTimer = setTimeout(renderInfo, 250)
}

/* ---------------------------------------------------------- reading view */

let readingHighlightObserver = null
const readingHighlightJobs = new Map()
let readingWarmup = null

/**
 * Build the hidden Reading page once the freshly opened editor has spare time.
 *
 * The page is already retained between view changes, but the first trip from
 * Editing or Raw used to pay for Markdown parsing, DOM construction and embed
 * dressing inside the click handler. Warming that exact document while the
 * renderer is idle turns the first click into the same cache hit as every
 * later one. There is deliberately no idle timeout: active typing wins, and a
 * reader who switches before the browser becomes idle simply follows the old
 * on-demand path.
 */
function scheduleReadingWarmup () {
  cancelReadingWarmup()
  if (!state.current || reading() || viewingPdf() || viewingSite() || viewingWhiteboard()) return

  const path = state.current.path
  const doc = editor.state.doc
  const warm = () => {
    readingWarmup = null
    if (reading() || state.current?.path !== path || editor.state.doc !== doc) return
    renderReading({ reuse: true })
  }

  readingWarmup = typeof requestIdleCallback === 'function'
    ? { idle: true, handle: requestIdleCallback(warm) }
    : { idle: false, handle: setTimeout(warm, 500) }
}

function cancelReadingWarmup () {
  if (!readingWarmup) return
  if (readingWarmup.idle && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(readingWarmup.handle)
  } else {
    clearTimeout(readingWarmup.handle)
  }
  readingWarmup = null
}

/** Return one block to its original, span-free text after it leaves the
 *  reader's neighbourhood. The string is kept by the job because highlighting
 *  replaces the text nodes it came from. */
function resetReadingHighlight (job) {
  if (!job.highlighted) return
  job.code.replaceChildren(document.createTextNode(job.source))
  job.highlighted = false
}

/** Stop the observer owned by the current render.
 *
 * `reset` is used when the reading pane is merely being hidden (for Editing,
 * Raw, PDF, or website view), where its DOM stays alive. A render replacement
 * can skip that walk because the whole old tree is about to be discarded.
 */
function stopReadingHighlights ({ reset = false } = {}) {
  readingHighlightObserver?.disconnect()
  readingHighlightObserver = null
  for (const job of readingHighlightJobs.values()) {
    job.stopped = true
    if (reset) resetReadingHighlight(job)
  }
  readingHighlightJobs.clear()
}

/**
 * Everything the rendered page is built from besides the note's own text:
 * where a relative `<img src>` resolves (the note's folder, and the attachment
 * index behind it), which `![[Note]]` names now name a note, and the palette
 * and typeface a mermaid diagram is drawn in — it reads both when it draws and
 * paints them into its SVG, so neither is merely CSS as far as this page is
 * concerned. Composed from state the app already keeps for its own no-op
 * checks.
 */
const readingStamp = () => [
  state.current?.path || '',
  state.assetsKey,
  state.revision?.tree || '',
  document.documentElement.dataset.theme,
  state.fonts.body,
  state.fonts.ui
].join(' ')

/** What the reading pane is showing, as the two things that decide it. */
let shown = null

/**
 * Build the reading view, and say whether it built anything.
 *
 * Most callers are here precisely because something outside the note changed —
 * an attachment landed, a link began resolving, the palette moved under the
 * diagrams — so a render is the default, and `reuse` is asked for by the one
 * caller that knows nothing did: switching between the views of a note that is
 * already on screen. Opt-in rather than an invalidation counter kept beside the
 * state that matters: a call site added later renders again, which is only
 * slower, where a forgotten invalidation would leave the page silently stale.
 *
 * The stamp is the second half of that. `reuse` says the *caller* believes
 * nothing changed; the stamp checks the belief against the dependencies that
 * can be named. Without it, an attachment landing while the editing view was up
 * — where the call at `applyAssets` renders nothing, because nothing is
 * showing — would still be missing when the reading view came back.
 */
function renderReading ({ reuse = false } = {}) {
  if (!state.current) return false

  /* The cached string for this document: `equationsFor` below reads the same
     entry, and the money layer keeps it warm. Unchanged text is the same string
     rather than an equal one, so the comparison is a pointer test. */
  const body = noteText()
  const stamp = readingStamp()
  if (reuse && shown && shown.body === body && shown.stamp === stamp &&
      el.reading.firstChild) {
    /* The page stands, but its colouring does not: leaving the reading view
       took the spans back off every block and stopped the observer that would
       put them on again. */
    startReadingHighlights(el.reading)
    return false
  }

  stopReadingHighlights()

  // One column wrapper, so every block shares a left edge. Centring each child
  // independently would stagger narrow blocks (tables) against wide ones.
  const col = document.createElement('div')
  col.className = 'reading-col'

  const title = document.createElement('h1')
  title.className = 'inline-title'
  title.textContent = state.current.name
  if (state.current.flag) {
    const flag = document.createElement('span')
    flag.className = 'inline-title-flag'
    flag.textContent = state.current.flag
    flag.setAttribute('aria-label', 'Language country flag')
    title.append(flag)
  }
  col.append(title)

  const rendered = document.createElement('div')
  rendered.className = 'reading-body'
  /* `equationsFor` rather than `equationIndex`: the numbering is a fact about
     this document, and the document's own cache already holds it — asking for
     it by string would scan the whole note a second time, which is the mistake
     src/math.js documents beside that cache. (Transclusion still goes in by
     string: the note it renders is not the one in the editor.) */
  /* Enormous notes are shown from the top and said to be. Everything after the
     parse is already bounded by `content-visibility`, so what is left growing
     with the document is `md.render` and the HTML parse — about 460ms together
     for 84,000 lines, measured, and linear from there. A note in the megabytes
     is the one that stops opening, and going quiet for several seconds is the
     worst of the available answers. See src/reading-split.js for why this is a
     prefix rather than a progressive render. */
  const cut = readingWhole.has(state.current?.path) ? body.length : safeCut(body, READING_LIMIT)
  const shownBody = cut >= body.length ? body : body.slice(0, cut)
  rendered.innerHTML = md.render(shownBody, { equations: noteEquations() })
  installHeadingFolds(rendered)
  col.append(rendered)
  if (shownBody !== body) col.append(readingMoreNotice(body, shownBody))

  for (const table of rendered.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'table-wrap'
    table.replaceWith(wrap)
    wrap.append(table)
  }

  // The render being replaced may hold embeds that own real resources — an
  // inline PDF's parsed document, say — and they are let go before the DOM is.
  // Run controls own painter closures too. Retire those first so an idle block
  // cannot retain this detached page and everything it printed.
  retirePainters(el.reading)
  destroyEmbeds(el.reading)
  el.reading.replaceChildren(col)
  dressEmbeds(rendered)
  markImageCells(rendered)
  dressCodeBlocks(rendered)
  dressCitations(rendered, {
    dir: state.current?.dir || '',
    resolve: state.resolveAsset,
    read: (path) => api.file.read(path)
  }).catch(() => {})

  shown = { body, stamp }
  return true
}

/* Where the reading view stops on its own. Chosen from the measurement in
   reading-split.js: 1.5MB is around 84,000 lines of ordinary prose and code,
   which opens in about 460ms. Notes get to be slow; they do not get to be
   unopenable, and nothing in a vault of hand-written notes reaches this by
   accident — what does is a log, a dump, or a paste that went wrong. */
const READING_LIMIT = 1_500_000

/* The notes the reader has asked to see all of, for this session. Kept by path
   rather than as a flag on the tab: the answer belongs to the note, and it
   should survive closing the tab and coming back within the same sitting. It
   is deliberately not persisted — the reason to say yes is usually "I need to
   find one thing in here", not a standing preference. */
const readingWhole = new Set()

/**
 * The footer under a note that was only partly rendered.
 *
 * Says how much is missing in the units the reader thinks in, and offers the
 * rest. Not a silent truncation and not a dialog: the note is readable, the
 * notice is at the point where it stops, and the button is right there.
 */
function readingMoreNotice (body, shownBody) {
  const restLines = body.slice(shownBody.length).split('\n').length
  const mb = (body.length / 1_000_000).toFixed(1)

  const box = node('div', 'reading-more')
  box.append(node('p', 'reading-more-text',
    `${restLines.toLocaleString()} more lines are not shown. This note is ${mb} MB, ` +
    'and rendering all of it at once would lock the window for several seconds.'))

  const go = node('button', 'reading-more-go', 'Render the whole note')
  go.type = 'button'
  go.addEventListener('click', () => {
    const path = state.current?.path
    if (!path) return
    readingWhole.add(path)
    /* Through the status line rather than silently: the wait is the thing that
       was just agreed to, and a window that stops answering without having
       said it would is the failure this whole notice exists to avoid. */
    setStatusRight('Rendering the whole note…')
    /* A frame, so the line above is actually painted before the main thread
       goes away to do it. */
    requestAnimationFrame(() => rerenderReading({ reuse: false }))
  })
  box.append(go)

  const edit = node('button', 'reading-more-edit', 'Open in the editor')
  edit.type = 'button'
  /* The editor is the answer for most of the notes that get here: CodeMirror
     only builds the lines in view, so it opens a file this size immediately
     where the reading view cannot. */
  edit.addEventListener('click', () => setView('edit'))
  box.append(edit)

  return box
}

/**
 * Render the page again without losing the reader's place. The render replaces
 * every child of the pane, which snaps its scroll to the top; the line at the
 * top of the viewport is the one address that survives the rebuild — the same
 * one a view switch travels on.
 *
 * Nothing to restore when nothing was replaced: re-anchoring a page that never
 * moved would drag the scroll from wherever it was up to the top of the line it
 * was showing.
 */
function rerenderReading (opts) {
  const line = viewportLine()
  if (renderReading(opts)) scrollToLine(line)
}

/**
 * Whether a picture is the whole of the block it was written in — a figure,
 * which stands on its own line — or one thing among others, like a row of
 * badges or an icon in the middle of a sentence.
 *
 * Asked here rather than in the stylesheet because CSS cannot ask it:
 * `:only-child` counts elements and ignores text, so `Build status: ![](…)`
 * would come out looking alone. The editing view answers the same question
 * about a line, in src/editor.js, so that both views agree on which pictures
 * are figures.
 */
const standsAlone = (slot) => {
  const host = slot.parentElement?.closest('p, li')
  return !!host && host.textContent.trim() === '' &&
         host.querySelectorAll('.embed-slot').length === 1
}

/** Swap every stub the embed rules left behind for the real thing. */
function dressEmbeds (root) {
  const slots = [...root.querySelectorAll('.embed-slot')]
  /* Settled for all of them before any one is replaced: a badge's neighbours
     are the other stubs, and swapping them in turn would leave the last of a
     row looking like the only thing in its paragraph. */
  const figures = new Set(slots.filter(standsAlone))

  for (const slot of slots) {
    const { src, alt, w, h, syntax } = slot.dataset
    const size = w || h ? { width: Number(w) || null, height: Number(h) || null } : null
    const embed = renderEmbed(specForEmbed({ src, alt, size, syntax },
      { resolve: resolveHere, resolveNote: noteFromName }))
    if (figures.has(slot)) embed.classList.add('is-figure')
    slot.replaceWith(embed)
  }
}

/* What a fenced block becomes in the reading view, in the order the kinds are
   tried. The editing view keeps the same list as the fields in editor.js's
   RENDERED — a table there and a ladder here meant adding a kind was two
   different edits in two different shapes, and the run control (the fallback,
   and the only entry that decides for itself whether the language is one it
   knows) had to be remembered as the last arm of an if.

   A block with no language tile gets none of them: that tile is the signal
   that the parser identified a complete typed fence. */
const BLOCK_KINDS = [
  // A scene is shown as the film it renders to, not as the source that
  // describes it — so this block gets the manim treatment instead of a Run
  // control it has no use for.
  {
    matches: isManim,
    attach: (wrap, head, code) => attachManim(wrap, head, code, {
      noteName: state.current?.name || 'Untitled',
      scene: wrap.dataset.info || ''
    })
  },
  // A picture, on the same terms as a scene: TeX draws it once into the vault
  // and the drawing is what the block shows from then on.
  {
    matches: isTikz,
    attach: (wrap, head, code) => attachTikz(wrap, head, code, {
      noteName: state.current?.name || 'Untitled'
    })
  },
  // Same bargain as a scene, without the wait: a diagram is drawn from its own
  // source every time, so there is nothing to render and nothing to keep.
  {
    matches: isMermaid,
    attach: (wrap, _head, code) => attachMermaid(wrap, code)
  },
  // The same again, with nothing at all in between: the block already is the
  // drawing, so all that happens is that it is read.
  {
    matches: isSvg,
    attach: (wrap, _head, code) => attachSvg(wrap, code)
  },
  // HTML is always rendered in Reading view, inside its sandboxed guest.
  {
    matches: isHtmlRun,
    attach: (wrap, _head, code) => htmlFence.attach(wrap, code)
  },
  // A scene, in the same guest and on the same terms: what the block is for is
  // the thing it draws, so Reading view draws it.
  {
    matches: isThree,
    attach: (wrap, _head, code) => threeFence.attach(wrap, code)
  },
  /* The fallback: the button goes in the header beside the language mark, and
     the output box after the frame. Blocks in a language Tulip cannot run are
     untouched — attachRunControl is what knows which those are. */
  {
    matches: () => true,
    attach: (wrap, head, code) => attachRunControl(wrap, head, wrap.dataset.lang, code)
  }
]

/** Give every fenced block its language tile and, once the parser lands, its
 *  colours. Blocks without a language keep the plain frame. */
function dressCodeBlocks (root) {
  for (const wrap of root.querySelectorAll('.code-wrap')) {
    const lang = wrap.dataset.lang || ''
    const code = wrap.querySelector('code')
    if (!code) continue
    const source = code.textContent

    /* The header's two ends: the chip (and whatever the fence said after the
       language) on the left, the controls on the right. The controls are one
       group so the modules that add a Run or Draw button and the copy button
       below all land in the same corner without knowing about each other. */
    const tools = node('span', 'code-tools')

    if (lang) {
      const head = node('div', 'code-head')
      const chip = languageChip(lang)
      if (chip) head.append(chip)
      /* A manim block names its scene there, a snippet its file — words the
         fence carried that were parsed out and then shown nowhere. */
      if (wrap.dataset.info) head.append(node('span', 'code-info', wrap.dataset.info))
      head.append(tools)
      wrap.prepend(head)
      BLOCK_KINDS.find((kind) => kind.matches(lang)).attach(wrap, tools, source)
    } else {
      /* No language means no header — an empty bar is just a bar — so the
         copy control floats over the code's corner and appears on hover. */
      tools.classList.add('is-floating')
      wrap.prepend(tools)
    }
    tools.append(codeCopilotButton(lang, source), copyButton(source))
  }

  startReadingHighlights(root)
}

/**
 * Arm the colouring of every fenced block on the page.
 *
 * Separate from the dressing above because it does not only follow it: leaving
 * the reading view stops the observer and hands every block back its plain
 * text (`stopReadingHighlights({ reset: true })`), and returning to a page that
 * was kept rather than rebuilt has to arm it again — otherwise every block on
 * a reused page stays grey for as long as it is shown. Everything a job needs
 * is readable from the block itself, so a page already on screen can be armed
 * as readily as one just built.
 */
function startReadingHighlights (root) {
  const canObserve = typeof IntersectionObserver === 'function'
  /* The blocks this call is arming, as opposed to the ones already armed —
     which is what makes arming an armed page cost nothing and, more to the
     point, keeps it from building a second observer over the first. */
  const fresh = []

  for (const wrap of root.querySelectorAll('.code-wrap')) {
    const lang = wrap.dataset.lang || ''
    const code = wrap.querySelector('code')
    if (!lang || !code || readingHighlightJobs.has(wrap)) continue
    /* The source outlives the colouring: highlighting replaces the text nodes
       it was built from, and `textContent` reads the same string back through
       the spans. */
    const source = code.textContent

    if (canObserve) {
      readingHighlightJobs.set(wrap, {
        code,
        source,
        lang,
        visible: false,
        pending: false,
        highlighted: false,
        stopped: false
      })
      fresh.push(wrap)
    } else {
      // Older Chromium fallback: keep the eager behaviour rather than leave
      // every block uncoloured when IntersectionObserver is unavailable.
      highlightInto(code, source, lang).catch(() => {})
    }
  }

  if (!canObserve || !fresh.length) return

  readingHighlightObserver ||= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const job = readingHighlightJobs.get(entry.target)
      if (!job) continue

      job.visible = entry.isIntersecting
      if (!job.visible) {
        resetReadingHighlight(job)
        continue
      }
      if (job.pending || job.highlighted) continue

      job.pending = true
      /* Behind the picture, a block still reads as what it is written in — the
         alias table in highlight.js is what knows which that is. A parser that
         finishes after the block or the whole render left view is allowed to
         finish, then immediately gives its spans back. This avoids two parser
         runs racing to own the same code element. */
      highlightInto(job.code, job.source, job.lang).then((highlighted) => {
        job.pending = false
        if (!highlighted) return
        job.highlighted = true
        if (job.stopped || !job.visible) resetReadingHighlight(job)
      }).catch(() => { job.pending = false })
    }
  }, {
    root: el.reading,
    // A viewport and a half of runway on either side keeps ordinary scrolling
    // from catching the parser while still bounding the highlighted DOM.
    rootMargin: '150% 0px 150% 0px'
  })

  for (const wrap of fresh) readingHighlightObserver.observe(wrap)
}

/**
 * Where the reader is, as a line of the file.
 *
 * Each view scrolls its own box and lays the same text out differently, so a
 * pixel offset means nothing once you leave. Every block in the reading view
 * carries the line it came from, and the editor can answer for the line at the
 * top of its viewport, which makes the line number the common address.
 */
function viewportLine () {
  if (!state.current || viewingPdf()) return 1
  /* An editing view with no editor is the moment between asking for one and
     its arriving; the top of the note is the truthful answer until then. */
  if (!reading()) return editor ? editor.topLine() : 1

  const top = el.reading.getBoundingClientRect().top
  const nodes = el.reading.querySelectorAll('[data-line]')
  /* The blocks come back in document order, which on a page laid out in normal
     flow is top-to-bottom — so the first one below the fold is found by
     bisection rather than by measuring every block above it. This runs once
     per scroll frame, and the linear walk made the frame pay for the length of
     the note.

     Bisected over the raw list, and never over a filtered copy of it. Building
     one meant asking every block on the page whether it was laid out, and
     `offsetParent` is a question that cannot be answered without laying the
     page out — so the O(log n) search was preceded by an O(n) walk that forced
     layout n times. `readingNodeAt` below was given this same treatment for
     the same reason; this one was missed, and on a note with tens of thousands
     of blocks it did not merely get slow. Measured on a 1.7MB note (13,000
     headings, ~50,000 addressable blocks) the window stopped answering
     altogether: `markPlace` calls this, `rememberTabs` calls `markPlace`, and
     opening the note never finished. */
  let lo = 0
  let hi = nodes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const at = laidOutNear(nodes, mid, lo, hi)
    /* Nothing in reach of the midpoint is on the page — a long folded run.
       Everything measurable is above it, so look there. */
    if (at < 0) { hi = mid; continue }
    if (nodes[at].getBoundingClientRect().top - top > 2) hi = at
    else lo = at + 1
  }
  // The block before that one is the block being read.
  for (let i = lo - 1; i >= 0; i--) {
    if (nodes[i].offsetParent !== null) {
      return Number(nodes[i].dataset.line) + 1   // markdown-it counts from zero
    }
  }
  return 1
}

/* How far either side of a probe to look for a block that is actually on the
   page. A folded heading section and a collapsed callout are `display: none`,
   and a hidden element's rectangle is all zeros — which breaks the bisection's
   one assumption, that the tops it compares increase down the list. A run of
   zeros in the middle is what once sent a view switch to a line from the wrong
   side of a fold.

   Bounded rather than unbounded so the search stays logarithmic: a fold longer
   than this reads as "nothing here", which moves the probe up instead of
   stalling. That biases the answer towards the top of the note in the one case
   where the reader has folded away more than a screenful at a stretch, which
   is a place worth landing and cheap to be slightly wrong about. */
const FOLD_REACH = 64

/**
 * The index at or nearest `mid`, within `[lo, hi)`, of a block that is laid
 * out. -1 when there is none within reach.
 */
function laidOutNear (nodes, mid, lo, hi) {
  for (let step = 0; step <= FOLD_REACH; step++) {
    const before = mid - step
    if (before >= lo && nodes[before].offsetParent !== null) return before
    const after = mid + step
    if (after < hi && nodes[after].offsetParent !== null) return after
    if (before < lo && after >= hi) break
  }
  return -1
}

/** The last visible rendered block at or before a source line.
 *
 * Entering Reading makes its retained DOM visible all at once. Filtering every
 * block through `offsetParent` at that moment forces layout repeatedly and was
 * the remaining cost on the click. Source lines are already ordered, so find
 * the candidate without layout and only test the few nodes needed to step out
 * of a folded section.
 */
function readingNodeAt (line) {
  const nodes = el.reading.querySelectorAll('[data-line]')
  let lo = 0
  let hi = nodes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (Number(nodes[mid].dataset.line) + 1 <= line) lo = mid + 1
    else hi = mid
  }
  for (let i = lo - 1; i >= 0; i--) {
    if (nodes[i].offsetParent !== null) return nodes[i]
  }
  return null
}

function scrollToLine (line) {
  if (!state.current || viewingPdf() || viewingSite() || viewingWhiteboard()) return
  if (!reading()) { editor?.scrollToLine(line); return }

  // A folded block has no position; readingNodeAt walks back to the visible
  // heading or callout that owns it instead of sending the pane to the top.
  const target = readingNodeAt(line)
  el.reading.scrollTop = target
    ? el.reading.scrollTop + target.getBoundingClientRect().top -
      el.reading.getBoundingClientRect().top
    : 0
}

/**
 * Put a reopened note back at the line it was left showing.
 *
 * Twice, a frame apart, and that is not belt-and-braces. The reading view is
 * built with `content-visibility: auto`, so every block below the fold is an
 * estimate — `contain-intrinsic-block-size: auto 44px` — until it is laid out
 * for real. The first scroll therefore aims at a document whose height above
 * the target is a guess; the moment it lands, the blocks it passed are measured
 * properly, the page above shrinks or grows by the difference, and the reader
 * arrives a block or so from where they left. Measured drift on a 200-section
 * note was exactly one block, always late. The second pass aims at a page that
 * has now been measured, which is why it lands.
 *
 * This does not apply to the view switch, which reuses the DOM it already laid
 * out — see `renderReading({ reuse: true })` — and so has real heights from the
 * first attempt.
 */
function restoreReadingPlace (line) {
  let frames = 0
  /* The last position this function put the pane at. Anything else is the
     reader, and the reader wins: chasing a line somebody has already scrolled
     past would take the page back off them mid-gesture. */
  let mine = -1
  const settle = () => {
    if (!reading() || frames++ > READING_PLACE_FRAMES) return
    if (mine >= 0 && Math.abs(el.reading.scrollTop - mine) > 1) return
    const target = readingNodeAt(line)
    if (!target) return
    const off = target.getBoundingClientRect().top - el.reading.getBoundingClientRect().top
    /* Corrected every frame rather than until it first lands. Landing is not
       the end of the movement: the blocks just scrolled past are measured on
       arrival, the page above the target grows or shrinks by the difference,
       and a loop that stopped at the first good frame left the reader drifting
       a block or two further down than where they were. */
    if (Math.abs(off) > 0.5) el.reading.scrollTop += off
    mine = el.reading.scrollTop
    requestAnimationFrame(settle)
  }
  settle()
}

/* Half a second of frames. Long enough for a long note's estimated blocks to
   be measured for real, short enough that a page which will never settle — an
   image still loading, a diagram still drawing — stops being chased rather
   than scrolling under the reader for as long as it takes. */
const READING_PLACE_FRAMES = 30

/* Language tables are purpose-built study documents, so their fixed grid has
   no raw source mode. Remove that inapplicable control while one is open; it
   returns with the other two views as soon as an ordinary note is active. */
const VIEWS = ['read', 'edit', 'raw']
const VIEW_NAMES = { read: 'Reading', edit: 'Editing', raw: 'Raw' }

function updateViewControl () {
  /* A locked file's other views are disabled rather than hidden: what is on
     screen has to say *why* it cannot be edited, and a switch that quietly
     lost two of its three buttons would read as a document with no editing
     view at all. */
  const locked = lockedHere()
  for (const button of el.viewSwitch.querySelectorAll('.view-option')) {
    const view = button.dataset.view
    const unavailable = view === 'raw' &&
      (viewingLanguageTable() || viewingData() || viewingNotebook())
    const barred = locked && view !== 'read'
    button.hidden = unavailable
    button.disabled = unavailable || barred
    button.setAttribute('aria-pressed', String(view === state.view))
    button.title = barred
      ? 'This file is locked — unlock it from the command palette to edit it'
      : unavailable
        ? `${VIEW_NAMES[view]} view is unavailable for ${
            viewingData() ? 'CSV tables' : viewingNotebook() ? 'notebooks' : 'language tables'}`
        : `${VIEW_NAMES[view]} view (⌘${VIEWS.indexOf(view) + 1})`
  }
  el.lockMark.hidden = !locked
}

/** The locked set, written down. One place, so the config and `state.cfg`
 *  cannot end up disagreeing about which files are held. */
function rememberLocks () {
  const lockedFiles = [...state.locked]
  state.cfg = { ...state.cfg, lockedFiles }
  api.config.set({ lockedFiles })
}

/**
 * Lock the open document to its reading view, or let it go again.
 *
 * Asked about first, in both directions. Locking is asked about because it
 * takes editing away from a file and the reader should know that is what the
 * command did; unlocking is asked about because a lock that could be undone by
 * one stray press of Return in the palette is not a lock at all.
 */
async function toggleLock () {
  if (!state.current) { toast('Open a document to lock it.'); return }
  if (!canLock()) {
    toast('This kind of document has no reading view to be held in.')
    return
  }
  const path = state.current.path
  const locking = !state.locked.has(path)
  const name = docLabel(path)
  const yes = await ask(locking
    ? {
        title: `Lock “${name}”?`,
        detail: 'It stays in reading view until you unlock it from the command palette.',
        go: 'Lock'
      }
    : {
        title: `Unlock “${name}”?`,
        detail: 'It can be edited again.',
        go: 'Unlock'
      })
  if (!yes) return

  if (locking) state.locked.add(path)
  else state.locked.delete(path)
  rememberLocks()
  /* Locking moves the document into the reading view, and unlocking hands back
     whatever view was being held for it — both are `applyPanes` reading the
     lock again, not a second copy of the rule. */
  applyPanes()
  toast(locking
    ? `“${name}” is locked — reading view only.`
    : `“${name}” is unlocked.`)
}

/* Called with the current view too — at boot, where it is what marks the
   active button — so it must not shortcut when nothing is changing. */
function setView (view) {
  if ((viewingLanguageTable() || viewingData() || viewingNotebook()) && view === 'raw') {
    view = 'edit'
  }
  /* A locked file has one view. Refused here rather than in the two callers
     that are the switch and the chords, because every other way of asking for
     the editor — the find panel, a template, a link followed into a note —
     asks by calling this. The preference itself is left alone: the reader has
     not changed their mind about how notes open, they have picked up a
     document that is not taking edits. */
  if (lockedHere()) {
    /* Reading is refused too, quietly: the document is already in it, and the
       one thing the click would otherwise do is write "read" over the
       preference the reader is having held for them. */
    if (view !== 'read') {
      toast('This file is locked — unlock it from the command palette to edit it.')
    }
    return
  }
  /* Editing and Raw are the editor, and on a launch that opened into Reading it
     may not have arrived yet. Deferred whole rather than half-applied: the
     switch reads the scroll position out of one view and restores it into the
     other, and doing that around an editor that does not exist would land the
     reader at the top of the note. Called again — not continued — so every
     branch below sees a complete editor. */
  if (view !== 'read' && !editor && !viewingPdf() && !viewingSite() &&
      !viewingWhiteboard() && !viewingData() && !viewingNotebook()) {
    ensureEditor().then(() => setView(view)).catch(() => {})
    return
  }
  /* The viewed kinds: nothing here is the text editor, so the chosen view is
     recorded and handed to whatever is on screen. A table is the one of them
     that does something with it — `applyPanes` puts the grid into Reading or
     Editing — and for the rest it is the view the next note will open in. */
  if (viewingPdf() || viewingSite() || viewingWhiteboard() || viewingData() ||
      viewingNotebook()) {
    state.view = view
    el.app.dataset.view = view
    applyPanes()
    api.config.set({ view })
    return
  }
  cancelReadingWarmup()
  // Chosen rather than coerced: whatever was being held for the reader is what
  // they have just replaced.
  heldView = null
  // Read before anything moves, restore after everything has.
  const line = viewportLine()

  state.view = view
  el.app.dataset.view = view
  /* A PDF is showing, so the chosen view is remembered rather than applied —
     it is what the next note opened will be shown in. */
  applyPanes()
  editor?.setRaw(view === 'raw')

  // Icon only: which view you are in is the icon, and the title says what a
  // click does next.
  updateViewControl()

  /* Switching views does not change the note, so the page already built for it
     stands — which is the whole cost of a toggle on a long note. `scrollToLine`
     below still runs: the line to land on is the one the view being left was
     showing, whether or not the page was rebuilt. */
  if (view === 'read') renderReading({ reuse: true })
  else {
    stopReadingHighlights({ reset: true })
    if (state.current) editor?.focus()
  }

  scrollToLine(line)
  // Pictures and highlighted code settle a frame later and can move the ground
  // under the anchor, so it is placed once more once they have.
  requestAnimationFrame(() => scrollToLine(line))

  api.config.set({ view })
}

/**
 * Reading view is not editable, but a checkbox is a control rather than text.
 * Toggling one swaps a single character in the source, which keeps every line
 * number in the rendered output valid — so the page never has to re-render and
 * the scroll position never jumps.
 */
/* Ticking a box in the reading view is an edit to the note, and an edit has to
   go through the editor: it is what marks the buffer dirty and so what gets the
   change saved. On a launch into the reading view there may be none yet, so one
   is asked for — the first tick of a session waits for it, and the rest do not.
   Answering asynchronously is why the caller unticks the box on a promise. */
async function toggleTaskAtLine (lineIndex, box) {
  /* A checkbox is the one control the reading view offers that writes to the
     file, so it is the one thing a lock has to refuse here as well as at the
     views. The caller unticks the box when this says no. */
  if (lockedHere()) {
    toast('This file is locked — unlock it from the command palette to edit it.')
    return false
  }
  const view = await ensureEditor()
  const { doc } = view.state
  const n = lineIndex + 1
  if (n < 1 || n > doc.lines) return false

  const line = doc.line(n)
  const match = /\[([ xX])\]/.exec(line.text)
  if (!match) return false

  const wasChecked = match[1] !== ' '
  const at = line.from + match.index + 1
  view.dispatch({ changes: { from: at, to: at + 1, insert: wasChecked ? ' ' : 'x' } })

  box.closest('li')?.classList.toggle('is-done', !wasChecked)
  return true
}

/* Where a click inside a rendered note goes, shared by every surface that
   renders one — this view, the hover popover and the side pane. See
   src/links.js for what the rule is and why it is only written once. */
/* Clicking a tag asks the vault for it. The search understands `tag:` already
   and answers hierarchically, so this is the existing question with the
   existing answer — only now there is a way to ask it by pointing at one. */
const openTag = (name) => openOverlay('search', { query: `tag:${name}` })

const fragmentRouting = {
  openWikilink,
  openAsset,
  openTag,
  openExternal: (url) => api.openExternal(url)
}

el.reading.addEventListener('click', (e) => {
  const target = e.target
  if (!(target instanceof HTMLElement)) return

  /* A callout written `[!note]-` or `[!note]+` folds. Only those do: a plain
     `[!note]` is not a disclosure and should not behave like one. */
  const foldable = target.closest('.callout.is-foldable > .callout-head')
  if (foldable) {
    foldable.parentElement.classList.toggle('is-collapsed')
    return
  }

  const box = target.closest('input.task')
  if (box) {
    // The native toggle is left to stand — calling preventDefault here would
    // make the browser revert the tick after this handler runs, leaving the box
    // disagreeing with the file. If the write fails, undo it by hand instead.
    toggleTaskAtLine(Number(box.dataset.line), box)
      .then((done) => { if (!done) box.checked = !box.checked })
    return
  }

  // Wikilinks, attachments and plain anchors mean here what they mean in every
  // other place a note is rendered — see src/links.js.
  routeFragmentClick(e, fragmentRouting)
})

/* ------------------------------------------------------------- overlays */

/**
 * What the palette offers: the three things that have nowhere better to live.
 *
 * Everything the app can do still runs through `runCommand` — the menus, the
 * shortcuts and the empty-state buttons all call it, and none of them read
 * this list. What was here was a second copy of the menu bar, searchable: a
 * list you had to read past to reach anything, where every entry named the
 * shortcut that made the entry redundant. Three rows is a list you take in
 * whole, which is the only thing a palette is faster than a menu at.
 *
 * The test for adding a fourth: is there any other way to reach it? Reading
 * view has ⌘1, the sidebar has ⌘B — those go in the menu. A theme picker has
 * no key of its own, so it goes here.
 *
 * Linting the file passes that test too: it has no key and no menu item, because
 * the rules are applied on every save anyway — this is for the one thing a save
 * leaves alone, the blank line the caret is sitting in.
 */
const COMMANDS = [
  { id: 'new-file', title: 'New file…', key: '›' },
  { id: 'fold-all-headings', title: 'Fold all headings', scope: 'markdown' },
  { id: 'unfold-all-headings', title: 'Unfold all headings', scope: 'markdown' },
  { id: 'center-headings', title: 'Center headings', scope: 'markdown' },
  { id: 'note-history', title: 'Show history…', scope: 'text' },
  { id: 'move-file', title: 'Move this file…', scope: 'file' },
  { id: 'orphaned-images', title: 'Show orphaned images…' },
  { id: 'themes', title: 'Change theme…' },
  { id: 'font-body', title: 'Change markdown font…' },
  { id: 'font-ui', title: 'Change interface font…' },
  { id: 'lint-file', title: 'Lint current file', scope: 'markdown' },
  /* Both pass the test above. A block's own Run button is per block and only
     exists where the block is on screen — a note of twenty of them has no
     "and the rest", and the output panels have no way at all to be closed
     again short of editing every block to change its key. */
  { id: 'run-all-blocks', title: 'Run all code blocks', scope: 'markdown' },
  { id: 'clear-block-outputs', title: 'Clear all code block outputs', scope: 'markdown' },
  /* Spellcheck is the one setting people want to reach mid-sentence — a note
     full of names underlined in red is a reason to turn it off for a minute,
     and walking to Settings for that is the whole trip the palette exists to
     save. It stays a vault-wide setting either way, so no scope. */
  { id: 'toggle-spellcheck', title: 'Toggle spellcheck', scope: 'markdown' },
  /* Passes the test above: a template has no key and no menu item, and the
     only other way to use one would be to open it and copy it out by hand. */
  { id: 'insert-template', title: 'Insert template…', scope: 'markdown' },
  { id: 'export-pdf', title: 'Export as PDF…', scope: 'markdown' },
  { id: 'export-html', title: 'Export as HTML…', scope: 'markdown' },
  { id: 'export-markdown', title: 'Export as Markdown…', scope: 'markdown' },
  /* Passes the admission test the way `insert-template` does: every tag in
     the vault with its count, and no other surface lists them — a tag is
     otherwise only findable by already knowing its name. */
  { id: 'browse-tags', title: 'Browse tags…' },
  { id: 'settings', title: 'Settings…', key: '⌘,' },
  /* Passes the palette's admission test the same way `insert-template` does:
     there is no other way to reach it, and there is deliberately nothing
     automatic behind it — Tulip asks about updates when it is asked to and
     never otherwise. */
  /* The vault's own study record — see review-panel.js. The numbers are the
     whole vault's, but the only documents they are about are the language
     tables, so that is where it is offered: a study record has nothing to say
     while a spreadsheet is open. */
  { id: 'open-recent-vault', title: 'Open recent vault…' },
  { id: 'review-stats', title: 'Review statistics…', scope: 'language' },
  /* Same admission as review-stats: only reachable here, and only offered
     with a language table open — the file the imported rows join. */
  { id: 'import-cards', title: 'Import cards from CSV…', scope: 'language' },
  { id: 'check-for-updates', title: 'Check for updates…' },
  /* Where the failure toast sends people. Both are here rather than in
     Settings because this is what a reader reaches for at the moment something
     has gone wrong, and the palette is the one place they already know to
     look. */
  { id: 'reveal-crash-log', title: 'Reveal crash log' },
  { id: 'copy-diagnostics', title: 'Copy diagnostics' },
  /* Two windows on one vault: the same notes, two places in them. Offered in
     the palette as well as the Window menu because the palette is where this
     app's readers look for anything they do not do every day. */
  { id: 'new-window', title: 'New window', key: '⌘⌥N' },
  { id: 'open-in-new-window', title: 'Open in new window', scope: 'file' },
  { id: 'copilot', title: 'Toggle copilot', key: '⌘⇧A', scope: 'copilot' }
]

/* One doorway in the command palette, then the same complete set of things the
   explorer can create. Keeping the destination on the overlay matters: once
   this nested list is open it describes the directory the command was invoked
   from, even if the rest of the window redraws underneath it. */
const NEW_FILE_COMMANDS = [
  { id: 'new-note', title: 'Markdown note', kind: 'note' },
  { id: 'new-table', title: 'Table', kind: 'note' },
  /* "Source file" opens a second picker rather than making one, because a
     source file is not a kind until it has a language — the same arrangement
     as a language table, which asks for a country first. */
  { id: 'new-source', title: 'Source file', kind: 'code' },
  { id: 'new-csv', title: 'CSV table', kind: 'data' },
  { id: 'new-notebook', title: 'Jupyter notebook', kind: 'notebook' },
  { id: 'new-tex', title: 'TeX document', kind: 'tex' },
  { id: 'new-website', title: 'Website', kind: 'site' },
  { id: 'new-whiteboard', title: 'Whiteboard', kind: 'whiteboard' }
]

/**
 * The list above, plus whatever the open note earns.
 *
 * Fitting the columns is a grid's problem — a language table's or a `.csv`'s.
 * Offering it over an ordinary note would be a row that does nothing in a list
 * whose whole argument is that it is short enough to read at a glance.
 */
function commandList () {
  /* What a command needs the open document to be. A row that cannot act on
     what is on screen is worse than a missing one: it is read, chosen, and
     then does nothing. Unscoped means the command is about the vault or the
     app rather than the document — the theme, the fonts, the settings — and
     those stay offered even with nothing open at all. */
  const SCOPES = {
    markdown: () => Boolean(state.current && NOTE_EXT.test(state.current.path)),
    text: () => Boolean(state.current && isEditableTextPath(state.current.path)),
    language: () => viewingLanguageTable(),
    file: () => Boolean(state.current),
    // The second window has no copilot to toggle — see `state.primary`.
    copilot: () => state.primary
  }
  const commands = COMMANDS.filter(({ scope }) => !scope || SCOPES[scope]())

  /* Both kinds of grid earn it, and for the same reason: the grid is the
     document, it is the thing people drag columns around in, and a column
     dragged in March is the wrong width by June. */
  if (viewingLanguageTable() || viewingData()) {
    commands.push({ id: 'fit-columns', title: 'Auto-resize all columns' })
  }
  /* Only the data grid: a language table's columns are the four the format
     defines, and there is nothing in them to pick a category out of. */
  if (viewingData()) {
    commands.push({ id: 'filter-column', title: 'Filter this column…' })
    commands.push({ id: 'clear-filters', title: 'Clear every filter' })
  }
  /* One row, and which one depends on the document: a file is either locked or
     it is not, and offering both spellings at once would be a list with a row
     in it that cannot do anything. It passes the admission test above too —
     there is no chord, no menu item and no button for it, and the palette is
     the only way back out of a lock, which is exactly what the confirmation
     says it is. */
  if (canLock()) {
    commands.push(lockedHere()
      ? { id: 'unlock-file', title: 'Unlock this file' }
      : { id: 'lock-file', title: 'Lock this file' })
  }
  if (viewingWhiteboard()) {
    commands.push(
      { id: 'whiteboard-add-note', title: 'Add note to whiteboard…' },
      { id: 'whiteboard-template-mind-map', title: 'Insert mind-map template' },
      { id: 'whiteboard-template-study-plan', title: 'Insert study-plan template' },
      { id: 'whiteboard-template-research', title: 'Insert research-board template' },
      { id: 'export-whiteboard-png', title: 'Export whiteboard as PNG…' },
      { id: 'export-whiteboard-svg', title: 'Export whiteboard as SVG…' }
      )
  }
  return commands.sort((a, b) => a.title.localeCompare(b.title))
}

/* The two font pickers are one overlay each, and this is what tells the shared
   machinery — previewing, reverting, choosing — which role it is looking at. */
const FONT_MODES = { 'font-body': 'body', 'font-ui': 'ui' }

/* A typeface is a property of the app rather than of the vault, so both
   pickers open with no vault, the same way the theme picker does. */
const VAULTLESS = new Set(['commands', 'themes', 'font-body', 'font-ui', 'vaults'])

/* What the panel says it is, in the field and to a screen reader. Kept side by
   side so a new picker cannot gain a prompt without gaining an announcement. */
const OVERLAY_PROMPT = {
  switcher: 'Jump to a note…',
  search: 'Search notes, PDFs, and highlights…',
  commands: 'Run a command…',
  'new-files': 'Choose a file type…',
  'new-source': 'Choose a language…',
  themes: 'Change the theme…',
  'font-body': 'Choose the font notes are written in…',
  'font-ui': 'Choose the font the app is drawn in…',
  countries: 'Choose a country flag…',
  'move-to': 'Move to a folder…',
  templates: 'Insert a template…',
  vaults: 'Open a vault Tulip knows…',
  tags: 'Filter tags…'
}

const OVERLAY_LABEL = {
  switcher: 'Quick switcher',
  search: 'Search the vault',
  commands: 'Command palette',
  'new-files': 'New file',
  'new-source': 'New source file',
  themes: 'Theme',
  'font-body': 'Markdown font',
  'font-ui': 'Interface font',
  countries: 'Country flag',
  'move-to': 'Move to a folder',
  vaults: 'Recent vaults',
  templates: 'Insert a template',
  tags: 'Tags'
}

/* A folder of notes to start other notes from. A plain folder in the vault,
   because everything else here is: a template is a note, editable the way every
   other note is, and a vault carried to another app keeps them as readable
   files rather than as a feature that only existed inside Tulip. */
const TEMPLATE_DIR = 'templates'

/** The templates the vault holds, newest name order, as overlay items. */
function templateItems () {
  const prefix = `${TEMPLATE_DIR}/`
  return state.files
    .filter((f) => f.path.toLowerCase().startsWith(prefix) && isEditableTextPath(f.path))
    .map((f) => ({ ...f, label: f.path.slice(prefix.length).replace(/\.md$/i, '') }))
}

/**
 * The handful of placeholders a template may carry.
 *
 * Deliberately few, and all answerable from what the app already knows — a
 * template language is a program, and this is a note with today's date in it.
 * `{{title}}` is the note being written into, not the template.
 */
function fillTemplate (text, title) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const values = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    title
  }
  return String(text).replace(/\{\{\s*(date|time|title)\s*\}\}/gi, (whole, name) => {
    const value = values[name.toLowerCase()]
    return value === undefined ? whole : value
  })
}

/**
 * Put a template into the note on screen, at the caret.
 *
 * Inserted rather than replacing: a template is usually reached from an empty
 * note, but "insert" is the honest description of what happens in one that is
 * not, and it is the behaviour that cannot lose anything.
 */
async function insertTemplate (path) {
  const text = await api.file.read(path)
  if (typeof text !== 'string') return
  const title = state.current?.path
    ? state.current.path.split('/').pop().replace(/\.md$/i, '')
    : ''
  const filled = fillTemplate(text, title)
  // Inserting is editing, and the palette is open in the reading view too.
  const view = await ensureEditor()
  const at = view.state.selection.main
  view.dispatch({
    changes: { from: at.from, to: at.to, insert: filled },
    // The caret lands after what was inserted, where writing continues.
    selection: { anchor: at.from + filled.length },
    scrollIntoView: true
  })
  view.focus()
}

function openOverlay (mode, meta = {}) {
  if (!state.vault && !VAULTLESS.has(mode)) { connectVault(); return }
  // One picker opening straight over another never reaches closeOverlay, so
  // the outgoing one's preview is undone here instead.
  revertPreview(state.overlay?.mode)
  state.overlay = { mode, items: [], index: 0, ...meta }
  el.overlay.hidden = false
  el.panelInput.value = String(meta.query || '')
  el.panelInput.placeholder = OVERLAY_PROMPT[mode]
  /* The panel is one dialog reused by nine pickers. Its label is written in the
     markup as "Quick switcher", which is what a screen reader announced when it
     was opened to change the theme or search the vault — the placeholder said
     one thing and the announcement another. */
  el.panel.setAttribute('aria-label', OVERLAY_LABEL[mode] || 'Quick switcher')
  el.panelFoot.innerHTML = mode === 'themes' || FONT_MODES[mode]
    ? '<span><kbd>↑↓</kbd> preview</span><span><kbd>↵</kbd> keep</span><span><kbd>esc</kbd> cancel</span>'
    : mode === 'search'
        ? '<span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span>' +
          '<span class="panel-syntax"><kbd>type:</kbd> <kbd>tag:</kbd> <kbd>path:</kbd> <kbd>file:</kbd> <kbd>prop:</kbd> <kbd>"phrase"</kbd></span>'
        : '<span><kbd>↑↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>'

  // Only the vault search has switches to qualify, and only it can rewrite.
  const searching = mode === 'search'
  el.panelChips.hidden = !searching
  el.panelSaveSearch.hidden = !searching
  el.panelReplace.hidden = !(searching && replacing)
  el.panel.classList.toggle('is-search', searching)
  // A pattern left half-typed dimmed the field; the panel opening again is a
  // fresh query, so it must not open already looking wrong.
  el.panel.classList.remove('is-bad')
  paintSearchChips()

  /* The specimen belongs to the two font pickers and to nothing else, and
     which role is being chosen is which property the card is set in. */
  const fontRole = FONT_MODES[mode]
  el.fontSample.hidden = !fontRole
  el.fontSample.classList.toggle('is-ui', fontRole === 'ui')

  runOverlayQuery(el.panelInput.value)
  el.panelInput.focus()
}

/**
 * Put back whatever a picker was previewing over.
 *
 * A preview is a look, not a decision, so anything left on screen by one has
 * to go when the picker does — and "when the picker does" is not only Escape.
 * ⌘P over an open font picker replaces the overlay without closing it, and
 * without this that font would simply stay. The pending frame is dropped
 * first, or it would land after the revert and repaint the thing just undone.
 */
function revertPreview (mode) {
  dropPreview()
  if (mode === 'themes') paintTheme(state.theme)
  else if (FONT_MODES[mode]) paintFont(FONT_MODES[mode], state.fonts[FONT_MODES[mode]])
}

function closeOverlay () {
  clearTimeout(queryTimer)
  revertPreview(state.overlay?.mode)
  state.overlay = null
  el.overlay.hidden = true
  el.panel.classList.remove('is-search')
  if (viewingWhiteboard()) whiteboardInstance?.focus()
  if (viewingData()) dataInstance?.focus()
  else if (viewingNotebook()) notebookInstance?.focus()
  else if (!reading() && state.current) editor?.focus()
}

/* ------------------------------------------------------------ search opts

   The same three switches the in-note find panel carries, and for the same
   reason: `Aa`, `.*` and `ab|` are marks a reader learns once. Module-level
   rather than stored, exactly as `showReplace` is in find.js — within a
   session, reopening the panel should give back the one you were last using;
   across sessions, a regex switch left on is a search that finds nothing and
   no way to see why.
   ================================================================== */

const searchOpts = { caseSensitive: false, word: false, regex: false }
let replacing = false

/* Which chip drives which switch, so the pair is stated once. */
const CHIPS = [
  ['opt-case', 'caseSensitive'],
  ['opt-word', 'word'],
  ['opt-regex', 'regex']
]

function paintSearchChips () {
  for (const [id, key] of CHIPS) $(id).setAttribute('aria-pressed', String(searchOpts[key]))
  // Whole word and a hand-written pattern do not compose: the lookarounds
  // would argue with the pattern's own anchors, so main ignores the switch —
  // and a switch that does nothing has to look like it does nothing.
  $('opt-word').disabled = searchOpts.regex
  $('opt-replace').setAttribute('aria-pressed', String(replacing))
  $('opt-replace').setAttribute('aria-expanded', String(replacing))
}

for (const [id, key] of CHIPS) {
  $(id).addEventListener('click', () => {
    searchOpts[key] = !searchOpts[key]
    paintSearchChips()
    runOverlayQuery(el.panelInput.value)
    el.panelInput.focus()
  })
}

$('opt-replace').addEventListener('click', () => {
  replacing = !replacing
  el.panelReplace.hidden = !replacing
  paintSearchChips()
  ;(replacing ? el.panelReplaceInput : el.panelInput).focus()
})

el.panelSaveSearch.addEventListener('click', () => {
  const query = el.panelInput.value.trim()
  if (!query) return
  toast(savedSearches.save(query) ? 'Saved as a smart folder' : 'That search is already saved')
  el.panelInput.focus()
})

/** Subsequence match; consecutive hits and word starts score higher. */
/**
 * How well `text` answers `query`, or null if it does not answer it at all.
 *
 * Whole runs, not scattered letters. A subsequence matcher — every letter of
 * the query somewhere in the text, in order — finds "gre" in "Guernsey" and in
 * "Singapore", and a list where four real answers sit among a dozen
 * coincidences is a list that has to be read rather than glanced at. Every
 * term has to appear whole.
 *
 * The looseness that is kept is the useful kind: the query is split on spaces
 * and the terms may appear in any order and anywhere apart, so "index reading"
 * still finds "Reading Index" and "gre" finds "St. Vincent & Grenadines".
 *
 * Where a term lands is most of the score — the start of the name beats the
 * start of a word beats the middle of one — because that is the difference
 * between the thing you meant and the thing that merely contains it.
 */
const WORD_EDGE = /[\s/\\_\-–—.,:;([{&]/

function fuzzy (query, text) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return { score: 0, hits: [] }
  const t = String(text || '').toLowerCase()

  const hits = []
  let score = 0

  for (const term of terms) {
    const at = t.indexOf(term)
    if (at === -1) return null

    const wordStart = at === 0 || WORD_EDGE.test(t[at - 1])
    score += 10 + (at === 0 ? 8 : wordStart ? 4 : 0)
    // Earlier is better, but only ever as a tie-break between equals — and it
    // stops counting past a point, so one long name does not outrank another
    // purely for being longer.
    score -= Math.min(at, 40) * 0.05

    for (let i = at; i < at + term.length; i++) hits.push(i)
  }

  // A short name that matches is a better answer than a long one carrying the
  // same run somewhere inside it.
  score -= Math.max(0, t.length - query.length) * 0.02
  return { score, hits }
}

/**
 * An item against the query: its own label, or failing that the short code
 * shown beside it.
 *
 * The codes are on screen — GR, GD, VC down the right-hand side of the country
 * list — so they are a thing people type, and a list that displays a key it
 * refuses to match on is a list that lies about itself. A code match scores
 * below every label match and marks nothing, because the letters it matched
 * are not in the text being shown.
 */
function matchItem (query, item) {
  const code = item.code?.toLowerCase()
  /* Typed in full, a code is not a guess. Someone entering "GD" at a list whose
     right-hand column is codes means Grenada, and should not be answered first
     with the United Kin(gd)om — which is a real match on the label, just not
     the one they asked for. */
  if (code && code === query.trim().toLowerCase()) return { score: 1000, hits: [] }

  const onLabel = fuzzy(query, item.label)
  if (onLabel) return onLabel
  if (!code) return null
  const onCode = fuzzy(query, item.code)
  return onCode ? { score: onCode.score - 100, hits: [] } : null
}

function markHits (text, hits) {
  const set = new Set(hits)
  const frag = document.createDocumentFragment()
  let buf = ''
  let marking = false

  const flush = () => {
    if (!buf) return
    if (marking) {
      const m = document.createElement('mark')
      m.textContent = buf
      frag.append(m)
    } else frag.append(document.createTextNode(buf))
    buf = ''
  }

  for (let i = 0; i < text.length; i++) {
    const on = set.has(i)
    if (on !== marking) { flush(); marking = on }
    buf += text[i]
  }
  flush()
  return frag
}

let searchToken = 0

async function runOverlayQuery (query) {
  if (!state.overlay) return
  const { mode } = state.overlay

  /* `#` turns the switcher into a heading jump for the note on screen — the
     same character that writes a heading is the one that finds it, and it
     saves a second shortcut for what is really the same act of navigating. */
  if (mode === 'switcher' && query.startsWith('#')) {
    const wanted = query.slice(1)
    const scored = []
    for (const heading of headings(noteText())) {
      const match = wanted ? fuzzy(wanted, heading.text) : { score: 0, hits: [] }
      if (match) scored.push({ item: { ...heading, label: heading.text }, ...match })
    }
    if (wanted) scored.sort((a, b) => b.score - a.score)
    state.overlay.items = scored.slice(0, 60)
    state.overlay.index = 0
    renderOverlayList(state.current ? 'No heading matches.' : 'No note is open.')
    return
  }

  if (mode === 'switcher' || mode === 'commands' || mode === 'new-files' ||
      mode === 'new-source' || mode === 'tags' ||
      mode === 'themes' || mode === 'countries' || mode === 'move-to' ||
      mode === 'templates' || mode === 'vaults' || FONT_MODES[mode]) {
    const source = mode === 'vaults'
      ? (state.overlay.vaults || [])
      : mode === 'tags'
      /* Fetched once when the browser opened — see `browse-tags` — and
         filtered here like any list already in memory. */
      ? (state.overlay.tags || []).map((t) => ({ ...t, label: `#${t.tag}` }))
      : mode === 'move-to'
      ? moveDestinations(state.overlay.paths || [])
      : mode === 'templates'
      ? templateItems()
      : mode === 'switcher'
      ? state.files.map((f) => ({ ...f, label: f.name }))
      : mode === 'themes'
        ? themeItems()
        : FONT_MODES[mode]
          ? fontItems(FONT_MODES[mode])
          : mode === 'countries'
            ? COUNTRIES.map((country) => ({
                ...country,
                label: `${country.flag} ${country.name}`
              }))
            : mode === 'new-source'
              ? SOURCE_CHOICES.map((choice) => ({ ...choice, label: choice.label }))
              : (mode === 'new-files' ? NEW_FILE_COMMANDS : commandList())
                  .map((c) => ({ ...c, label: c.title }))

    const scored = []
    for (const item of source) {
      const match = query ? matchItem(query, item) : { score: 0, hits: [] }
      if (match) scored.push({ item, ...match })
    }
    /* Commands and themes are alphabetized in their source lists. Fonts retain
       their curated serif, sans, mono grouping, and tags arrive most-used
       first, which is the order worth keeping. Filtering is a different
       matter: once there is a query, the best answer goes first. */
    const curated = mode === 'themes' || mode === 'tags' || FONT_MODES[mode]
    if (!curated || query) {
      scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    }
    state.overlay.items = scored.slice(0, 60)
    state.overlay.index = curated && !query
      ? Math.max(0, state.overlay.items.findIndex(({ item }) => item.id === state.theme))
      : 0
    renderOverlayList()
    // Previewing pickers start with the current choice, or the first match.
    if (curated) syncSelection()
    return
  }

  /* Finding inside the open PDF was a mode here once, answering with the same
     list of rows the vault search answers with. It is a bar along the foot of
     the document now — see src/pdf-find.js for why a list was the wrong shape
     for a question asked inside one document. */

  if (mode === 'search') {
    const token = ++searchToken
    setSearchCaveats()
    if (!query.trim()) {
      state.overlay.items = []
      state.overlay.index = 0
      renderOverlayList('Type to search, or filter with type:pdf, type:highlight, tag:, path:, file:, or prop:.')
      return
    }

    const { results, truncated, unsearched, unsearchedPaths = [], error } = await api.search(query, searchOpts)
    if (token !== searchToken || !state.overlay) return

    /* A half-typed pattern is the ordinary state of a regex being written, so
       it says so in the field rather than reading as "nothing matches". */
    el.panel.classList.toggle('is-bad', !!error)
    state.overlay.truncated = !!truncated
    state.overlay.items = results.flatMap((r) =>
      r.hits.map((h) => ({ item: { ...r, hit: h, label: r.name }, hits: [] }))
    )
    state.overlay.index = 0
    renderOverlayList(error ||
      (query.trim().length < 2 ? 'Type at least two characters.' : `Nothing matches “${query.trim()}”.`))
    /* A cap nobody is told about reads as "that is all there is", and so does
       a note skipped for its size — which is why the skipped ones are named:
       hover shows which. */
    setSearchCaveats(
      truncated && `first ${results.length} notes`,
      unsearched && {
        text: `${unsearched} ${unsearched === 1 ? 'document' : 'documents'} not searchable yet`,
        title: unsearchedPaths.join('\n')
      }
    )
  }
}

/**
 * What qualifies the results now — replaced on every pass, never stacked, so
 * a query that has nothing to say clears what the last one said. A note may
 * carry a `title`, for the caveat that can explain itself.
 */
function setSearchCaveats (...notes) {
  el.panelFoot.querySelectorAll('.panel-capped').forEach((n) => n.remove())
  for (const note of notes.filter(Boolean)) {
    const span = node('span', 'panel-capped', typeof note === 'string' ? note : note.text)
    if (typeof note === 'object' && note.title) span.title = note.title
    el.panelFoot.append(span)
  }
}

/* How many of a preview's files are named before it stops naming them. Enough
   to recognise a pattern that has gone wrong — a replace that was meant for
   three notes and found ninety is obvious from the first few — and short
   enough that the dialog stays something a person reads rather than scrolls. */
const PREVIEW_FILES = 12

/**
 * What a replace is about to do, written out.
 *
 * The counts come first because they are what a mistake shows up in, then one
 * changed line per note: seeing “vault” standing where “workspace” stood is
 * the check nobody can do against a number.
 */
function replacePreviewText (plan) {
  const hits = `${plan.hits} match${plan.hits === 1 ? '' : 'es'}`
  const notes = `${plan.notes} note${plan.notes === 1 ? '' : 's'}`
  const lines = [`${hits} in ${notes} will be rewritten on disk.`, '']
  for (const file of plan.files.slice(0, PREVIEW_FILES)) {
    lines.push(`${file.path}  (${file.hits})`)
    if (file.sample) lines.push(`    ${file.sample.before}`, `  → ${file.sample.after}`)
  }
  const rest = plan.files.length - PREVIEW_FILES
  if (rest > 0) lines.push('', `…and ${rest} more note${rest === 1 ? '' : 's'}.`)
  /* The undo that does exist, named. A replace is recorded in the note history
     as one batch, which is the only way back for the notes that are not open —
     "this cannot be undone" was never quite true and sent people looking for a
     safety net in the wrong place. */
  lines.push('', 'Reversible from Note history, as one batch.')
  return lines.join('\n')
}

/**
 * Rewrite every match in the vault.
 *
 * Shown before it is done, and shown from a real run rather than from the
 * result list: main matches and rewrites the whole index with `preview` set
 * and writes nothing, so the counts are exact and the lines are the actual
 * lines. What the reader then approves is applied to exactly the paths that
 * were on screen. This is the only edit in the app that touches notes nobody
 * has open, so the buffer's undo stack does not cover it; the note history's
 * batch entry does, and the dialog says so.
 */
async function replaceEverywhere () {
  const query = el.panelInput.value.trim()
  if (!query) return

  const into = el.panelReplaceInput.value

  /* The buffer goes to disk first — before the preview and not just before the
     write. Main rewrites notes from its own index, the last text it was told
     about, so an unsaved edit in the open note is invisible to the replace and
     the autosave that lands afterwards would put the pre-replace buffer back
     over the rewritten file. The replace would be undone in the one note the
     reader was looking at, silently, under a toast saying it had worked. It
     also means the preview counts the note as it is rather than as it was.
     Every other flow that rewrites notes underneath the buffer — rename, move
     — flushes for the same reason. */
  if (state.dirty) await saveNow()

  /* What it would do, before it does it. The overlay's own counts cannot
     answer this: the result list is capped at 200 notes and a replace is not,
     so the number in the dialog used to be a floor with "at least" in front of
     it. This runs the real matching over the whole index and writes nothing. */
  const plan = await api.replaceAll(query, into, { ...searchOpts, preview: true })
  if (plan.error) { toast(plan.error); return }
  if (!plan.notes) { toast('Nothing to replace — the query matches no text.'); return }

  const planPlural = plan.notes === 1 ? 'note' : 'notes'
  const go = await ask({
    title: into
      ? `Replace “${query}” with “${into}” in ${plan.notes} ${planPlural}?`
      : `Delete “${query}” from ${plan.notes} ${planPlural}?`,
    detail: replacePreviewText(plan),
    go: 'Replace all'
  })
  if (!go) { el.panelInput.focus(); return }

  /* Exactly the notes that were on screen when the reader said yes. A note
     that grew a match while the dialog was open is not swept in with them. */
  const result = await api.replaceAll(query, into, {
    ...searchOpts,
    only: plan.files.map((f) => f.path)
  })
  if (result.error) { toast(result.error); return }

  /* The open note may be one of them: its own writes no longer come back
     through the watcher, so the buffer would otherwise be older than the disk
     and win at the next autosave. */
  if (result.rewritten?.includes(state.current?.path)) await reloadCurrent()

  toast(`Replaced ${result.hits} in ${result.notes} ${result.notes === 1 ? 'note' : 'notes'}`)
  runOverlayQuery(el.panelInput.value)
  el.panelInput.focus()
}

el.panelReplaceGo.addEventListener('click', replaceEverywhere)
el.panelReplaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); replaceEverywhere() }
  if (e.key === 'Escape') { e.preventDefault(); closeOverlay() }
})

/* Hovering a row selects it, which is right for a mouse being moved and wrong
   for every other reason a row can arrive under the pointer. An arrow key
   scrolls the list, a keystroke rebuilds it — and either one slides a
   different row beneath a mouse that has not moved at all, which fires
   `mouseenter` and takes the selection away from the key that just set it.
   That is what made ↑ from the top of the palette land on whatever happened to
   be under the cursor. So hover is muted until the pointer genuinely moves:
   the keyboard sets this, and a real `mousemove` clears it. */
let overlayHoverMuted = false

function renderOverlayList (emptyMessage = 'Nothing matches.') {
  const { items, index, mode } = state.overlay
  // The rows about to appear under the pointer were not moved to by anyone.
  overlayHoverMuted = true
  el.panelList.replaceChildren()

  if (!items.length) {
    const li = document.createElement('li')
    li.className = 'empty-hint'
    li.textContent = emptyMessage
    el.panelList.append(li)
    return
  }

  /* A screenful now, the rest a frame at a time. A vault search can answer
     with hundreds of rows — 200 notes at up to four hits each — and every row
     carries a cloned SVG icon; built in one pass they were a visible stall on
     each debounced keystroke, for rows below the fold that mostly get thrown
     away by the next keystroke. The token retires a fill the moment a newer
     list starts painting. */
  const fill = ++overlayFillToken
  const CHUNK = 80
  const paint = (from) => {
    const stop = Math.min(items.length, from + CHUNK)
    const frag = document.createDocumentFragment()
    for (let i = from; i < stop; i++) frag.append(overlayRow(items[i], i, mode, index))
    el.panelList.append(frag)
    if (stop < items.length) {
      requestAnimationFrame(() => {
        if (fill === overlayFillToken && state.overlay) paint(stop)
      })
    }
  }
  paint(0)
}

let overlayFillToken = 0

/** One overlay row, exactly as the single-pass loop built it. */
function overlayRow ({ item, hits }, i, mode, index) {
  {
    const li = document.createElement('li')
    li.setAttribute('role', 'option')
    li.setAttribute('aria-selected', String(i === index))
    li.dataset.index = String(i)

    /* File rows use the same marks as the explorer. The extension remains the
       source of truth for existing files, so a language table found by search
       cannot be mistaken for an ordinary Markdown note. New-file choices say
       their intended kind directly because they do not have a path yet. */
    const fileKind = mode === 'new-files'
      ? item.kind
      : ((mode === 'switcher' || mode === 'search') && item.path
          /* Tree and search rows already carry the main process's kind;
             deriving it again per row would re-run noteRef's regex walk on
             every repaint of the overlay. */
          ? (item.kind || noteRef(item.path).kind)
          : '')
    if (fileKind) {
      li.classList.add('has-file-icon')
      li.append(docIcon(fileKind, item.path))
    }

    const title = document.createElement('span')
    title.className = 'title'
    title.append(hits.length ? markHits(item.label, hits) : document.createTextNode(item.label))
    li.append(title)

    if (mode === 'search' && item.hit) {
      const snippet = document.createElement('span')
      snippet.className = 'snippet'
      snippet.textContent = item.hit.text
      title.append(snippet)
    }

    /* A typeface names itself in its own letters. It is the only honest way to
       show one — "Baskerville" set in the interface sans tells you nothing you
       could not have guessed — and it means the list is a specimen sheet you
       read rather than a menu you try one item of at a time. */
    if (FONT_MODES[mode]) {
      title.style.fontFamily = item.stack
      title.classList.add('is-specimen')
    }

    const right = document.createElement('span')
    right.className = 'dir'
    if (mode === 'themes') {
      right.append(swatch(item))
    } else if (FONT_MODES[mode]) {
      right.textContent = item.kind
    } else if (mode === 'countries') {
      right.textContent = item.code
    } else if (mode === 'new-source') {
      // The extension the file will actually get, so the choice is not a guess.
      right.textContent = item.ext
    } else if (mode === 'tags') {
      right.textContent = `${item.notes} ${item.notes === 1 ? 'note' : 'notes'}`
    } else if (item.level) {
      // A heading, from the switcher's `#` mode: its depth is what tells one
      // "Notes" from another.
      right.textContent = `H${item.level}`
    } else {
      right.textContent = mode === 'commands' || mode === 'new-files'
        ? (item.key || '')
        : (item.dir || (mode === 'search'
            ? (item.kind === 'note'
                ? `line ${item.hit.line}`
                : item.kind === 'whiteboard'
                    ? 'whiteboard'
                    : `${item.kind === 'highlight' ? 'highlight' : 'PDF'} · p. ${item.hit.page}`)
            : ''))
    }
    li.append(right)

    li.addEventListener('mouseenter', () => {
      if (overlayHoverMuted) return
      state.overlay.index = i
      syncSelection()
    })
    li.addEventListener('click', () => chooseOverlayItem(i))
    return li
  }
}

function syncSelection () {
  const { index, mode, items } = state.overlay
  for (const li of el.panelList.children) {
    const on = Number(li.dataset.index) === index
    li.setAttribute('aria-selected', String(on))
    if (on) li.scrollIntoView({ block: 'nearest' })
  }
  // The whole window is painted from the same custom properties, so previewing
  // is nothing more than pointing the root at another palette — or another
  // typeface. Both go through `preview`, which holds it to one repaint a frame.
  const chosen = items[index]?.item
  if (!chosen) return
  if (mode === 'themes') preview(() => paintTheme(chosen.id))
  // The specimen card is painted from the same custom property, so pointing
  // the root at the new stack is the whole of what previewing a font is.
  else if (FONT_MODES[mode]) preview(() => paintFont(FONT_MODES[mode], chosen.id))
}

async function chooseOverlayItem (i) {
  const entry = state.overlay?.items[i]
  if (!entry) return
  const { mode, dir, paths } = state.overlay
  const { item } = entry
  closeOverlay()

  if (mode === 'move-to') { await moveInto(item.path, paths); return }
  if (mode === 'vaults') { await openVaultAt(item.path); return }
  if (mode === 'templates') { await insertTemplate(item.path); return }
  if (mode === 'themes') { commitTheme(item.id); return }
  if (FONT_MODES[mode]) { commitFont(FONT_MODES[mode], item.id); return }
  if (mode === 'commands') { runCommand(item.id); return }
  if (mode === 'new-files') { runCommand(item.id, dir); return }
  // A tag is a question, and the vault search is where it gets answered.
  if (mode === 'tags') { openTag(item.tag); return }
  if (mode === 'countries') {
    await createLanguageFor(dir, item)
    return
  }
  if (mode === 'new-source') {
    await createSource(dir, item.ext)
    return
  }
  // A heading is a place in the note already open, so nothing is opened.
  if (item.level && !item.path) { jumpToHeading(item.slug); return }
  await openNote(item.path)
  revealInTree(item.path)

  if (mode === 'search' && item.hit) {
    if (item.kind === 'highlight' && item.hit.mark) {
      pdf.goToMark(item.hit.mark)
      return
    }
    if (item.kind === 'pdf') {
      pdf.goToPage(item.hit.page || 1)
      return
    }
    if (item.kind === 'whiteboard') {
      whiteboardInstance?.find()
      return
    }
    // Through the door both views share: dispatching into the editor alone
    // moved a caret nobody could see while the reading view was up.
    goToLine(Math.min(item.hit.line, editor.state.doc.lines), item.hit.col || 0)
  }
}

/* Vault search reaches the main process; the other modes are a filter over a
   list already in memory and answer on the keystroke. Even against the index,
   coalescing a burst of typing into one query keeps a long note from being
   scanned six times for prefixes nobody wanted results for. */
let queryTimer = null

function queueOverlayQuery (value) {
  clearTimeout(queryTimer)
  /* The vault search is the one mode that leaves this window to answer, so it
     is the one that waits for a pause in the typing rather than asking the main
     process about every note per keystroke. */
  const slow = state.overlay?.mode === 'search'
  if (!slow) { runOverlayQuery(value); return }
  queryTimer = setTimeout(() => runOverlayQuery(value), 90)
}

el.panelInput.addEventListener('input', (e) => queueOverlayQuery(e.target.value))

el.panelInput.addEventListener('keydown', (e) => {
  if (!state.overlay) return
  const count = state.overlay.items.length

  /* The ends are ends. A list that wraps moves the selection the length of
     itself for one keystroke, which is never what the key meant — at the last
     row, ↓ means "further down", and there is nothing further down. */
  const step = (by) => {
    if (!count) return
    overlayHoverMuted = true
    state.overlay.index = Math.max(0, Math.min(count - 1, state.overlay.index + by))
    syncSelection()
  }

  if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
    e.preventDefault()
    step(1)
  } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
    e.preventDefault()
    step(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    chooseOverlayItem(state.overlay.index)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeOverlay()
  }
})

/* The pointer moving is the only thing that puts hover back in charge. On the
   list rather than on each row, because a row that scrolls under a still mouse
   must not be able to claim the move for itself. */
el.panelList.addEventListener('mousemove', () => { overlayHoverMuted = false })

el.overlay.addEventListener('mousedown', (e) => {
  if (e.target === el.overlay) closeOverlay()
})

/* --------------------------------------------------------- context menu */

/**
 * Creation commands shared by the explorer background and folder rows.
 *
 * The empty part of the explorer represents the vault root. A folder row
 * represents that folder, so its labels make the destination explicit.
 */
function explorerCreateItems (dir = '', insideFolder = false) {
  const suffix = insideFolder ? ' here' : ''
  return [
    { label: `New file${suffix}`, run: () => createNote(dir) },
    { label: `New whiteboard${suffix}`, run: () => createWhiteboard(dir) },
    { label: `New website${suffix}`, run: () => createWebsite(dir) },
    { label: `New folder${suffix}`, run: () => createFolder(dir) },
    { label: `New language${suffix}`, run: () => createLanguage(dir) },
    { label: `New table${suffix}`, run: () => createTable(dir) }
  ]
}

/**
 * The path the rest of the machine knows a file by.
 *
 * Everything inside the app names a note by its path *within* the vault, which
 * is what makes a vault portable — but that is not a path you can paste into a
 * terminal, hand to another app, or open with `cd`. This is the one place that
 * puts the vault's own location back in front of it.
 */
const systemPath = (p) => [state.vault?.path, p].filter(Boolean).join('/')

/** Those paths on the clipboard, one per line. */
function copyPaths (paths) {
  api.copy(paths.map(systemPath).join('\n'))
  setStatusRight(paths.length === 1 ? 'Path copied' : `${paths.length} paths copied`)
}

function showContextMenu (event, node) {
  const items = []

  /* Right-clicking inside a multi-selection acts on the whole selection, the
     way a file manager does. Right-clicking outside it selects that one row
     first, so the menu never operates on something out of view. */
  const inSelection = state.picked.has(node.path)
  if (!inSelection) {
    state.picked = new Set([node.path])
    state.pickAnchor = node.path
    markPicked()
  }

  if (inSelection && state.picked.size > 1) {
    /* "Items", not "notes": a selection reaches across folders now, and a
       folder is not a note. Pruned, because trashing a folder already takes
       what is inside it. */
    const paths = topLevelOnly(state.picked)
    items.push({
      label: `Reveal ${paths.length} items in Finder`,
      run: () => paths.forEach((p) => api.file.reveal(p))
    })
    items.push({ label: `Copy ${paths.length} paths`, run: () => copyPaths(paths) })
    items.push({ label: `Move ${paths.length} items to…`, run: () => openMovePicker(paths) })
    items.push({ sep: true })
    items.push({
      label: `Move ${paths.length} items to Trash`,
      danger: true,
      run: () => removeMany(paths)
    })
    renderContextMenu(items, event)
    return
  }

  if (node.type === 'folder') {
    items.push(...explorerCreateItems(node.path, true))
    items.push({ sep: true })
  }
  if (node.type !== 'folder' && canShowBeside(node.path)) {
    items.push({ label: 'Open to the side', run: () => openToSide(node.path) })
  }
  if (node.type !== 'folder') {
    items.push({ label: 'Open in new window', run: () => openInNewWindow(node.path) })
  }
  items.push({ label: 'Rename…', key: '↵', run: () => beginRename(node) })
  if (node.type !== 'folder' && isEditableTextPath(node.path)) {
    items.push({ label: 'Show history…', run: () => noteHistory.show(node.path) })
  }
  items.push({ label: 'Move to…', run: () => openMovePicker([node.path]) })
  items.push({ label: 'Reveal in Finder', run: () => api.file.reveal(node.path) })
  items.push({ label: 'Copy path', run: () => copyPaths([node.path]) })
  items.push({ sep: true })
  items.push({
    label: node.type === 'folder' ? 'Move folder to Trash' : 'Move note to Trash',
    danger: true,
    run: () => removeNode(node)
  })

  renderContextMenu(items, event)
}

/* The rows handle their own menus above. Everything else in the Files pane is
   the vault root, including the useful empty space below a short file list. */
el.tree.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.row')) return
  event.preventDefault()
  clearPicked()
  renderContextMenu(explorerCreateItems(), event)
})

function renderContextMenu (items, event) {
  el.ctx.replaceChildren()
  for (const item of items) {
    if (item.sep) { el.ctx.append(document.createElement('hr')); continue }
    const btn = document.createElement('button')
    btn.textContent = item.label
    btn.setAttribute('role', 'menuitem')
    if (item.danger) btn.className = 'danger'
    if (item.disabled) btn.disabled = true
    // A setting the menu turns on and off says which it is now, the way a
    // native menu does — the row is the switch, so it carries the state.
    if (item.checked != null) {
      btn.classList.add('check')
      btn.classList.toggle('is-on', !!item.checked)
      btn.setAttribute('role', 'menuitemcheckbox')
      btn.setAttribute('aria-checked', String(!!item.checked))
    }
    if (item.key) {
      const k = document.createElement('span')
      k.className = 'key'
      k.textContent = item.key
      btn.append(k)
    }
    btn.addEventListener('click', () => { hideContextMenu(); item.run() })
    el.ctx.append(btn)
  }

  el.ctx.hidden = false
  const { innerWidth, innerHeight } = window
  const rect = el.ctx.getBoundingClientRect()
  el.ctx.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 8)}px`
  el.ctx.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 8)}px`

  /* Opened from the keyboard, the menu takes the focus — otherwise there is no
     way to reach what it is offering. Opened from the mouse it does not: the
     pointer is already the way in, and stealing focus from the editor mid-
     sentence to do nothing with it is worse than leaving it alone. */
  if (event.keyboard) {
    ctxReturn = document.activeElement
    el.ctx.querySelector('button:not([disabled])')?.focus()
  }
}

/** Move a rendered local image to the system Trash and remove every reference
 *  to that file from the open note. Multiple appearances cannot remain useful
 *  once their shared file is gone, so they leave together. */
async function removeEmbeddedImage (path) {
  if (!state.current || !path) return
  const name = path.split('/').pop() || 'image'
  const yes = await ask({
    title: `Move “${name}” to the Trash and remove it from this note?`,
    go: 'Move to Trash'
  })
  if (!yes) return

  const matches = findEmbeds(noteText()).filter((embed) =>
    embedSpec(embed.src, { resolve: resolveHere }).path === path
  )

  try {
    await api.file.remove(path)
  } catch (err) {
    toast(err.message || 'That image could not be moved to the Trash.')
    return
  }

  if (matches.length) {
    /* The picture is already in the Trash, so taking the embed out of the note
       is not optional — an editor is asked for rather than the change being
       quietly dropped when a reader did this from the reading view. */
    const view = await ensureEditor()
    view.dispatch({
      changes: matches.map(({ from, to }) => ({ from, to, insert: '' })),
      userEvent: viewingLanguageTable() ? 'input.table' : 'input'
    })
    await saveNow()
  }

  await loadAssets()
  if (reading()) rerenderReading()
  toast(`Moved “${name}” to the Trash`)
}

/** One confirmation for the whole batch, then one refresh at the end. */
async function removeMany (paths) {
  /* A folder among them takes everything under it, which is worth saying
     before it happens rather than after — the count alone reads as that many
     files. */
  const folders = paths.filter((p) => !state.files.some((f) => f.path === p)).length
  const yes = await ask({
    title: `Move ${paths.length} items to the Trash?`,
    detail: folders
      ? `${folders === 1 ? 'One of them is a folder' : `${folders} of them are folders`}, and everything inside goes too.`
      : '',
    go: 'Move to Trash'
  })
  if (!yes) return

  disarmSaves(paths)
  const failed = []
  for (const path of paths) {
    try {
      await api.file.remove(path)
    } catch {
      failed.push(path)
    }
  }

  await dropTabsFor(paths)
  clearPicked()
  await loadTree()

  if (failed.length) toast(`${failed.length} of ${paths.length} could not be moved to the Trash.`)
  else toast(`Moved ${paths.length} items to the Trash`)
}

/* Where the focus was when the menu opened, so closing it puts the keyboard
   back where it came from rather than at the top of the document. */
let ctxReturn = null

function hideContextMenu () {
  if (el.ctx.hidden) return
  el.ctx.hidden = true
  const back = ctxReturn
  ctxReturn = null
  if (back?.isConnected) back.focus()
}

/* The menu, once it is up, behaves like a menu: the arrows walk it, Escape
   leaves it, and Tab is not a way out — a menu that Tab escapes leaves the
   reader somewhere behind an overlay they cannot see past. */
el.ctx.addEventListener('keydown', (event) => {
  const items = [...el.ctx.querySelectorAll('button:not([disabled])')]
  if (!items.length) return
  const at = items.indexOf(document.activeElement)

  if (event.key === 'Escape') { event.preventDefault(); hideContextMenu(); return }
  if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
    event.preventDefault()
    items[(at + 1 + items.length) % items.length].focus()
    return
  }
  if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
    event.preventDefault()
    items[(at - 1 + items.length) % items.length].focus()
    return
  }
  if (event.key === 'Home') { event.preventDefault(); items[0].focus(); return }
  if (event.key === 'End') { event.preventDefault(); items[items.length - 1].focus() }
})
window.addEventListener('mousedown', (e) => {
  if (!el.ctx.hidden && !el.ctx.contains(e.target)) hideContextMenu()
})
window.addEventListener('blur', hideContextMenu)

/* ------------------------------------------------------ create / rename */

async function createNote (dir = '') {
  if (!state.vault) return connectVault()
  const path = await api.file.create(dir, 'Untitled')
  await loadTree()
  await openNote(path)
  // A note you have just made is a note you are about to write, and reading
  // view — where the app now opens — would show you a blank page with no way
  // to type on it.
  if (reading()) setView('edit')
  revealInTree(path)
  const row = el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
  if (row) beginRename({ type: 'file', path, name: 'Untitled' }, row)
}

/**
 * A new website file: created empty, opened, and left with the caret in its
 * address bar.
 *
 * No dialog asking where it should point. The tab it opens into is already a
 * browser with an address bar at the top, and typing into that is both how the
 * file is pointed somewhere and how it is re-pointed later — one gesture that
 * has to be learnt once rather than a modal for the first time and a toolbar
 * for every time after.
 *
 * Nor is the name asked for first, which is the one place this parts company
 * with a new note. A note is named and then written; a bookmark is not really
 * anything until it points somewhere, and being asked to name it beforehand is
 * being asked to describe a page you have not chosen yet. It arrives as
 * "Untitled" in the tree and is renamed there, the way any file is, once there
 * is something to name.
 */
async function createWebsite (dir = '') {
  if (!state.vault) return connectVault()
  const path = await api.site.create(dir)
  await loadTree()
  await openNote(path)
  revealInTree(path)
  // openSite has already put the caret here for a file with no address; this
  // is for the case where opening it went another way.
  el.siteAddress.focus()
}

async function createWhiteboard (dir = '') {
  if (!state.vault) return connectVault()
  const path = await api.whiteboard.create(dir)
  if (dir) state.expanded.add(dir)
  await loadTree()
  await openNote(path)
  revealInTree(path)
  const row = el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
  if (row) beginRename({ type: 'file', kind: 'whiteboard', path, name: 'Untitled' }, row)
}

async function createTex (dir = '') {
  if (!state.vault) return connectVault()
  const path = await api.tex.create(dir)
  if (dir) state.expanded.add(dir)
  await loadTree()
  await openNote(path)
  revealInTree(path)
  const row = el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
  if (row) beginRename({ type: 'file', kind: 'tex', path, name: 'Untitled' }, row)
}

function createLanguage (dir = '') {
  if (!state.vault) return connectVault()
  openOverlay('countries', { dir })
}

/**
 * A new source or data file, created empty and opened.
 *
 * The inline rename is started on it the way it is for a new note, and it is
 * the one kind where the name being edited carries its extension — so `.py`
 * is on screen while the name is typed, and typing a different known one over
 * it changes the file's kind rather than being ignored. See `renameDocument`.
 */
async function createSource (dir = '', ext = '.txt') {
  if (!state.vault) return connectVault()
  let path
  try {
    path = await api.source.create(dir, 'Untitled', ext)
  } catch (err) {
    toast(err.message || 'That file could not be created.')
    return
  }
  if (dir) state.expanded.add(dir)
  await loadTree()
  await openNote(path)
  /* A source file has no reading view to be caught in, but the preference is
     shared with notes and a file just made is one about to be written. */
  if (reading()) setView('edit')
  revealInTree(path)
  const row = el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
  if (row) beginRename({ type: 'file', kind: noteRef(path).kind, path, name: `Untitled${ext}` }, row)
}

/** A table-only document with generic, editable headers. */
async function createTable (dir = '') {
  if (!state.vault) return connectVault()
  const path = await api.table.create(dir, 'Untitled')
  if (dir) state.expanded.add(dir)
  await loadTree()
  await openNote(path)
  // Same as a new note: a table just made is one about to be filled in, and
  // reading view has nowhere to type.
  if (reading()) setView('edit')
  revealInTree(path)
  // A table starts as Untitled. Put the new document's filename in the
  // reader's hands immediately, in the title field they will use later too.
  editor?.focusTitle()
}

async function createLanguageFor (dir = '', country) {
  const created = await api.language.create(dir, `${country.flag} ${country.name}`)
  state.expanded.add(created.folder)
  await loadTree()
  await openNote(created.vocabulary)
  // Like a new ordinary note, a language just created is something the user is
  // about to fill in. Existing language files preserve the shared view mode;
  // only this creation path deliberately enters their editable grid.
  if (reading()) setView('edit')
  revealInTree(created.vocabulary)
}

async function createFolder (dir = '') {
  if (!state.vault) return connectVault()
  const path = await api.folder.create(dir, 'New folder')
  state.expanded.add(path)
  await loadTree()
  const row = el.tree.querySelector(`.row[data-path="${cssEscape(path)}"]`)
  if (row) beginRename({ type: 'folder', path, name: path.split('/').pop() }, row)
}

/**
 * Renames a note, wherever the new name was typed.
 *
 * The sidebar's row and the editor's title are two ways into the same edit, and
 * both have to leave the app agreeing with the disk: the open tab, the title
 * widget, the rendered page, the tree, and the history that may still be
 * pointing at the old path.
 *
 * @param {{path:string,name:string}} node  the note as it is now
 * @param {string} next                     the name asked for
 */
async function renameNote (node, next) {
  const name = String(next || '').trim()
  if (!name || name === node.name) return false
  try {
    // Whatever is unsaved goes to disk first: the rename rewrites linking
    // notes from their files, and a stale buffer would win the race back.
    if (state.dirty) await saveNow()
    const { path, links, rewritten = [] } = await api.file.rename(node.path, name)
    await loadTree()
    if (state.current?.path === node.path) {
      state.current = noteRef(path)
      // The inline title is the note's name, so a rename has to reach both
      // the editor's widget and the rendered page.
      editor?.refresh()
      if (reading()) renderReading()
      /* The rest is what every other way of putting a document on screen does,
         and a renamed note is a document arriving under a new path: the tab,
         the tree, the outline, the remembered session — and the copilot's
         transcript, which is filed under the path and would otherwise stay
         with the name the file no longer has. */
      settleDoc(path)
    }
    retraceHistory(node.path, path)
    /* The open note may be one of the rewritten: its own writes no longer come
       back through the watcher, so the buffer is told to catch up here. */
    if (rewritten.includes(state.current?.path)) await reloadCurrent()
    // Silence when nothing else pointed at it; otherwise say what was
    // changed, because notes the user never opened were just edited.
    if (links) toast(linkNote(links))
    return true
  } catch (err) {
    toast(err.message || 'That name is already taken.')
    // The title field is showing a name the vault refused; put the real one
    // back. The caller puts the tree row back, which is the only other place
    // the refused name is on screen.
    editor?.refresh()
    return false
  }
}

function beginRename (node, row) {
  row = row || el.tree.querySelector(`.row[data-path="${cssEscape(node.path)}"]`)
  if (!row) return
  const label = row.querySelector('.label')
  if (!label) return

  const input = document.createElement('input')
  input.className = 'row-input'
  input.value = node.name
  label.replaceWith(input)
  input.focus()
  /* Source and data files are the one kind whose name carries its extension,
     so selecting all of it would put `.py` under the first thing typed. The
     stem alone is selected instead — the extension stays visible, and stays
     the file's, unless it is deliberately typed over. */
  const stem = (isCodePath(node.path) || isDataPath(node.path))
    ? node.name.lastIndexOf('.')
    : -1
  if (stem > 0) input.setSelectionRange(0, stem)
  else input.select()

  let done = false
  /* What counts as a non-rename — blank, unchanged, refused by the vault — is
     renameNote's to decide, and it says so by answering false. Anything it did
     not carry out leaves a row showing a name that is not the file's, so the
     tree is drawn again to put the real one back. */
  const finish = async (commit) => {
    if (done) return
    done = true
    if (!commit || !(await renameNote(node, input.value))) renderTree()
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
}

/**
 * The landing page stands in front of everything until a vault is connected,
 * and goes away for good the moment one is — there is no route back to it
 * inside a session, because connecting another vault replaces the one open
 * rather than leaving the app with none.
 */
function paintLanding () {
  el.landing.hidden = Boolean(state.vault)
}

/* The rows are commands, so they run as commands — the same four ids the menu
   and the command palette reach, rather than a second set of call sites. */
el.emptyActions.addEventListener('click', (e) => {
  const button = e.target.closest('[data-command]')
  if (button) runCommand(button.dataset.command)
})

/** Return the pane to its empty state after the open document goes away. */
function closeCurrentNote () {
  if (viewingTex()) {
    clearTimeout(texCompileTimer)
    texCompileGeneration++
    texPdf.close()
  }
  if (viewingPdf()) pdf.close()
  if (viewingSite()) site.close()
  if (viewingWhiteboard()) whiteboardInstance?.close()
  if (viewingData()) dataInstance?.close()
  if (viewingNotebook()) notebookInstance?.close()
  pdfContents = []
  state.current = null
  state.dirty = false
  applyPanes()
  setDocEmpty()
  el.stage.classList.remove('has-doc')
  el.empty.hidden = false
  renderTabs()
  // Nothing is open, so no row is active; the tree's shape has not moved.
  markActiveRow()
  renderOutline()
  renderSpelling()
  renderInfo()
  updateStatus()
}

async function removeNode (node) {
  const yes = await ask({
    title: node.type === 'folder'
      ? `Move “${node.name}” and everything in it to the Trash?`
      : `Move “${node.name}” to the Trash?`,
    go: 'Move to Trash'
  })
  if (!yes) return

  disarmSaves([node.path])
  try {
    await api.file.remove(node.path)
  } catch (err) {
    toast(err.message || 'That item could not be moved to the Trash.')
    return
  }

  // A folder takes every note under it with it, and every tab showing one.
  await dropTabsFor([node.path])
  state.picked.delete(node.path)
  await loadTree()
  toast(`Moved “${node.name}” to the Trash`)
}

/* ------------------------------------------------------------- commands */

/**
 * Every runnable fenced block in the open note, in the order it is written.
 *
 * Parsed with the same markdown-it the reading view renders through, rather
 * than scanned by hand: the run states are keyed by the language and the exact
 * body (see runcode.js), and those keys are minted from these tokens in the
 * reading view and from CommonMark's own indentation rule in the editing view.
 * A scan of my own would have to reproduce that rule to agree with either, and
 * a block whose key was one space out would run a second copy of itself into a
 * panel nothing on screen is showing.
 *
 * Blocks that draw rather than run — mermaid, tikz, a scene, an html page — are
 * not here: `isRunnable` is the same membership test the Run button is drawn
 * from, so a block this offers to run is a block that has a Run button.
 *
 * Deduplicated, because the same snippet twice in a note is one run: the second
 * copy would otherwise start the identical program again the moment the first
 * finished, and paint it into both panels either way.
 */
function noteCodeBlocks () {
  const blocks = []
  const seen = new Set()

  for (const token of md.parse(noteText(), {})) {
    if (token.type !== 'fence') continue
    const lang = (token.info || '').trim().split(/\s+/)[0].toLowerCase()
    // markdown-it keeps the newline the closing fence sits on; the key does not.
    const code = token.content.replace(/\n$/, '')
    if (!isRunnable(lang) || !code.trim()) continue
    const key = `${lang}\n${code}`
    if (seen.has(key)) continue
    seen.add(key)
    blocks.push({ lang, code })
  }

  return blocks
}

/* One sweep at a time in this window. A second press would start the same
   blocks underneath the first sweep, which is then reporting on runs it did not
   start and waiting on runs it cannot see. */
let sweepingBlocks = false

/** The note's blocks, top to bottom, one at a time — see runBlocksInOrder. */
async function runAllCodeBlocks () {
  if (sweepingBlocks) { toast('Already running this note’s blocks.'); return }

  const blocks = noteCodeBlocks()
  if (!blocks.length) { toast('Nothing to run — this note has no runnable code blocks.'); return }

  sweepingBlocks = true
  toast(blocks.length === 1 ? 'Running the note’s one code block…' : `Running ${blocks.length} code blocks…`)
  try {
    const { ran, failed, stopped } = await runBlocksInOrder(blocks, (done, total) => {
      setStatusRight(`Running block ${done + 1} of ${total}…`)
    })
    setStatusRight('')
    /* What the sweep did, not what it was asked to do: a stopped sweep ran
       fewer blocks than the note has, and saying "ran 12" over a note of 20 is
       the one number that would be read as everything having happened. */
    if (stopped) {
      toast(`Stopped after ${ran} of ${blocks.length} blocks.`)
    } else if (failed) {
      toast(`Ran ${ran} blocks — ${failed} did not exit cleanly.`)
    } else {
      toast(ran === 1 ? 'The block ran cleanly.' : `All ${ran} blocks ran cleanly.`)
    }
  } finally {
    sweepingBlocks = false
  }
}

/**
 * Empty every output panel in the note.
 *
 * Only the panels: the note itself never held the output (see the head of
 * runcode.js), so there is nothing here to write to disk and nothing to undo.
 */
function clearAllCodeBlockOutputs () {
  const { cleared, running } = clearBlockOutputs(noteCodeBlocks())
  if (cleared) {
    toast(running
      ? `Cleared ${cleared} outputs — ${running} still running.`
      : `Cleared ${cleared} output${cleared === 1 ? '' : 's'}.`)
    return
  }
  toast(running ? 'Nothing to clear — those blocks are still running.' : 'No output to clear.')
}

/** Keep the reading view's disclosure buttons in step with the editor folds. */
function setReadingHeadingFolds (folded) {
  for (const button of el.reading.querySelectorAll('.heading-fold')) {
    const isFolded = button.getAttribute('aria-expanded') === 'false'
    if (isFolded !== folded) button.click()
  }
}

function runCommand (id, dir = state.current?.dir || '') {
  switch (id) {
    case 'new-file': openOverlay('new-files', { dir }); break
    case 'new-note': createNote(dir); break
    // A language first, then a file: see the note beside NEW_FILE_COMMANDS.
    case 'new-source': openOverlay('new-source', { dir }); break
    case 'new-csv': createSource(dir, '.csv'); break
    case 'new-notebook': createSource(dir, '.ipynb'); break
    case 'new-tex': createTex(dir); break
    case 'new-whiteboard': createWhiteboard(dir); break
    case 'new-website': createWebsite(dir); break
    case 'new-language': createLanguage(dir); break
    case 'new-folder': createFolder(dir); break
    case 'new-table': createTable(dir); break
    case 'back': goHistory(-1); break
    case 'forward': goHistory(1); break
    case 'new-tab': newTab(); break
    case 'close-tab': closeTab(state.tabIndex); break
    case 'reopen-tab': reopenTab(); break
    case 'next-tab': cycleTab(1); break
    case 'prev-tab': cycleTab(-1); break
    /* Whatever the tree has selected, or — when it has nothing — the note on
       screen, which is what "this file" means from the palette. */
    case 'move-file':
      openMovePicker(state.picked.size ? topLevelOnly(state.picked) : [state.current?.path])
      break
    case 'switcher': openOverlay('switcher'); break
    // The heading jump is the switcher with its query already started.
    case 'headings':
      openOverlay('switcher')
      el.panelInput.value = '#'
      runOverlayQuery('#')
      break
    case 'fold-all-headings':
      editor?.foldAllHeadings()
      if (reading()) setReadingHeadingFolds(true)
      break
    case 'unfold-all-headings':
      editor?.unfoldAllHeadings()
      if (reading()) setReadingHeadingFolds(false)
      break
    /* The same switch the Markdown settings tab carries, so the palette and
       the pane cannot disagree about which way it points. */
    case 'center-headings': {
      const on = state.cfg.centerHeadings !== true
      setSetting('centerHeadings', on)
      toast(on ? 'Headings centered.' : 'Headings left aligned.')
      break
    }
    /* Same setting the Editor settings tab writes, so the two cannot disagree
       about which way it points. `applySettings` is what actually clears the
       underlines or asks for a fresh pass. */
    case 'toggle-spellcheck': {
      const on = state.cfg.spellcheck === false
      setSetting('spellcheck', on)
      toast(on ? 'Spellcheck on.' : 'Spellcheck off.')
      break
    }
    case 'fit-columns':
      toast((viewingData() ? dataInstance?.fitColumns() : editor?.fitAllColumns())
        ? 'Columns fit their content again.'
        : 'These columns already fit their content.')
      break
    case 'filter-column': dataInstance?.filter(); break
    case 'clear-filters':
      toast(dataInstance?.clearFilters()
        ? 'Every row is showing again.'
        : 'Nothing was being filtered.')
      break
    case 'outline': toggleOutline(); break
    case 'links': togglePane('links'); break
    case 'info': togglePane('info'); break
    case 'search': openOverlay('search'); break
    case 'lint-file': lintFile(); break
    case 'run-all-blocks': runAllCodeBlocks(); break
    case 'clear-block-outputs': clearAllCodeBlockOutputs(); break
    case 'open-recent-vault': openRecentVault(); break
    case 'check-for-updates': checkForUpdate(); break
    case 'reveal-crash-log':
      api.revealLog()
        .then((found) => { if (!found) toast('No crash log yet — nothing has gone wrong.') })
        .catch(() => toast('Could not reach the crash log.'))
      break
    case 'copy-diagnostics':
      api.diagnostics()
        .then(({ text }) => api.copy(text))
        .then(() => toast('Diagnostics copied.'))
        .catch(() => toast('Could not gather diagnostics.'))
      break
    case 'new-window': api.window.open(); break
    case 'open-in-new-window': openInNewWindow(state.current?.path); break
    case 'review-stats': loadReviewStats().then((panel) => panel.show()); break
    case 'import-cards': importLanguageCsv(); break
    case 'insert-template': {
      /* An empty templates folder is the ordinary state of a vault that has
         never used one, so it explains itself rather than opening a picker
         with nothing in it. */
      if (!templateItems().length) {
        toast(`No templates yet — add notes to a “${TEMPLATE_DIR}” folder.`)
        break
      }
      // Inserting needs a caret, and the reading view has none.
      if (reading()) setView('editing')
      openOverlay('templates')
      break
    }
    case 'orphaned-images': showOrphanedImages(); break
    case 'note-history':
      if (!state.current || !isEditableTextPath(state.current.path)) {
        toast('Open a text document to see its history.')
        break
      }
      noteHistory.show(state.current.path)
      break
    case 'commands': openOverlay('commands'); break
    /* Both spellings run the same command: the palette shows one of them, and
       which one it is is the file's current state rather than two behaviours. */
    case 'lock-file':
    case 'unlock-file': toggleLock(); break
    case 'reading': setView(reading() ? 'edit' : 'read'); break
    case 'view-edit': setView('edit'); break
    case 'view-read': setView('read'); break
    case 'view-raw': setView('raw'); break
    case 'sidebar': toggleSidebar(); break
    case 'copilot':
      if (!state.primary) { setStatusRight('The copilot runs in the main window'); break }
      copilot.toggle()
      break
    case 'themes': openOverlay('themes'); break
    case 'font-body': openOverlay('font-body'); break
    case 'font-ui': openOverlay('font-ui'); break
    case 'theme': cycleTheme(); break
    case 'save': saveNow(); break
    case 'find':
      /* A PDF has its own find: the editor's panel searches a buffer, and the
         document on screen is not in one. The words come from the viewer, which
         has already read them to lay the selectable text over each page. */
      if (viewingPdf()) { pdfFind.open(); break }
      // Nor inside a page, which is a guest and keeps its own text out of reach.
      if (viewingSite()) { setStatusRight('Find does not reach inside a web page'); break }
      if (viewingWhiteboard()) { whiteboardInstance?.find(); break }
      /* A table's find is its own: the grid searches cells and can hide the
         rows without a match, neither of which a text panel over a buffer of
         quoted source could do. */
      if (viewingData()) { dataInstance?.find(); break }
      /* A notebook's find is its own too, and for the same reason: what is
         searched is the cells, and the pane holds no buffer for a text panel
         to search. */
      if (viewingNotebook()) { notebookInstance?.find(); break }
      // The find panel lives in the editor, so reading view steps across to the
      // editing view first — at the same place in the note, which setView keeps.
      // Asking to find something is asking to be taken to it, and that is a
      // stronger claim on the screen than the view the reader happened to be in.
      if (reading()) setView('edit')
      editor?.focus()
      openSearchPanel(editor)
      break
    case 'reveal':
      if (state.current) api.file.reveal(state.current.path)
      break
    /* The notebook's own menu. Every one of these is about a running kernel or
       about the file as something other than a notebook, so all of them are
       silent unless a notebook is what is open — ⌘⏎ over a note has always
       meant nothing and still does. */
    case 'nb-run-cell': if (viewingNotebook()) notebookInstance?.run.cell(); break
    case 'nb-run-all': if (viewingNotebook()) notebookInstance?.run.all(); break
    case 'nb-run-above': if (viewingNotebook()) notebookInstance?.run.above(); break
    case 'nb-run-below': if (viewingNotebook()) notebookInstance?.run.below(); break
    case 'nb-interrupt': if (viewingNotebook()) notebookInstance?.run.interrupt(); break
    case 'nb-restart': if (viewingNotebook()) notebookInstance?.run.restart(); break
    case 'nb-restart-all': if (viewingNotebook()) notebookInstance?.run.restartAll(); break
    case 'export-notebook-script':
      if (viewingNotebook()) notebookInstance?.exportAs('script')
      else toast('Only a notebook can be exported as a script.')
      break
    case 'export-notebook-html':
      if (viewingNotebook()) notebookInstance?.exportAs('html')
      else toast('Only a notebook can be exported as HTML.')
      break
    /* The window's zoom keys, handed over while a PDF is open: the document is
       what resizes, and the toolbar says so. See zoomCommand in main.js. */
    case 'zoom-in': zoomDoc(1); break
    case 'zoom-out': zoomDoc(-1); break
    case 'zoom-reset': zoomDoc('fit'); break
    case 'undo': stepHistory(false); break
    case 'redo': stepHistory(true); break
    case 'open-vault': connectVault(); break
    case 'settings': settings.open(); break
    case 'export-pdf': exportPdf(); break
    case 'export-html': exportHtml(); break
    case 'export-markdown': exportMarkdown(); break
    case 'print-note': printNote(); break
    case 'browse-tags': api.tags().then((tags) => openOverlay('tags', { tags })); break
    case 'export-whiteboard-png':
      if (viewingWhiteboard()) whiteboardInstance?.export('png')
      else toast('Open a whiteboard to export it.')
      break
    case 'export-whiteboard-svg':
      if (viewingWhiteboard()) whiteboardInstance?.export('svg')
      else toast('Open a whiteboard to export it.')
      break
    case 'whiteboard-add-note': whiteboardInstance?.promptNote(); break
    case 'whiteboard-template-mind-map': whiteboardInstance?.insertTemplate('mind-map'); break
    case 'whiteboard-template-study-plan': whiteboardInstance?.insertTemplate('study-plan'); break
    case 'whiteboard-template-research': whiteboardInstance?.insertTemplate('research'); break
  }
}

/* ------------------------------------------------------------ export

   A note, printed to a PDF. The page the print stack paginates is the one it
   renders, and a diagram is baked in the palette that was up when it was
   drawn, so a dark-theme note would come out grey on white. The note is
   therefore taken to the light palette and rendered again behind a curtain,
   printed, and put back — the curtain means the reader watches none of the
   churn, only the line saying what is happening.
   ================================================================== */

let exporting = false

function exportCurtain (saying) {
  const curtain = node('div', 'export-curtain')
  curtain.setAttribute('role', 'status')
  const line = node('p')
  line.textContent = saying || 'Preparing PDF…'
  curtain.append(line)
  el.app.append(curtain)
  return curtain
}

/* Print shows the whole article at once, and some of it only exists after it
   has been looked at: diagram stages fill in after a parse, pictures finish
   loading, and a fenced scene draws when it scrolls into sight. Walking the
   column through its own length wakes the last of them, then the wait is for
   every stage and image to report itself done — bounded, because a broken
   block should not hold an export hostage. */
async function settleReadingForExport () {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  const box = el.reading
  const top = box.scrollTop
  for (let y = 0; y <= box.scrollHeight; y += 600) { box.scrollTop = y; await wait(40) }
  box.scrollTop = top

  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const stages = [...box.querySelectorAll('.diagram-stage')].filter((s) => !s.childElementCount)
    const images = [...box.querySelectorAll('img')].filter((img) => !img.complete)
    if (!stages.length && !images.length) return
    await wait(120)
  }
}

/* Export and print share everything up to the last step: the note taken to
   the light palette in the reading view, settled, and put back afterwards.
   Only what happens to the prepared page differs — a PDF written, or the
   system's print dialog. */
async function renderOnPaper (saying, action) {
  if (exporting) return
  if (!state.current || viewingPdf() || viewingSite() || !NOTE_EXT.test(state.current.path)) {
    toast('Open a note first.')
    return
  }
  if (state.dirty) await saveNow()

  const prevView = state.view
  const prevTheme = document.documentElement.dataset.theme
  const curtain = exportCurtain(saying)
  exporting = true

  try {
    if (!reading()) setView('read')
    document.documentElement.dataset.theme = 'light'
    rerenderReading()
    await settleReadingForExport()

    const name = state.current.path.replace(NOTE_EXT, '').split('/').pop()
    return await action(name)
  } finally {
    document.documentElement.dataset.theme = prevTheme
    redrawForTheme()
    if (prevView !== 'read' && state.view === 'read') setView(prevView)
    /* The curtain comes down only after the screen holds what it held before:
       restored palette, restored view, and a frame to paint them in. */
    requestAnimationFrame(() => requestAnimationFrame(() => curtain.remove()))
    exporting = false
  }
}

async function exportPdf (to) {
  return renderOnPaper('Preparing PDF…', async (name) => {
    const result = await api.exportPdf(name, to)
    if (result?.ok) toast(`Exported ${result.path.split('/').pop()}`)
    else if (!result?.canceled) toast(result?.error || 'The export did not finish.')
    return result
  })
}

async function printNote () {
  return renderOnPaper('Preparing to print…', async () => {
    const result = await api.printNote()
    if (result && !result.ok && !result.canceled) toast(result.error || 'Printing did not finish.')
    return result
  })
}

/** The open note as one self-contained HTML file — the settled reading view,
 *  with main folding in the stylesheet, fonts and images. */
async function exportHtml (to) {
  return renderOnPaper('Preparing HTML…', async (name) => {
    const result = await api.exportHtml(name, el.reading.outerHTML, to)
    if (result?.ok) toast(`Exported ${result.path.split('/').pop()}`)
    else if (!result?.canceled) toast(result?.error || 'The export did not finish.')
    return result
  })
}

/**
 * The open note as portable Markdown: the text with every resolvable embed
 * rewritten to a plain relative link, and those files copied into a folder
 * beside it — so the export opens in any Markdown app with its pictures.
 *
 * Wiki embeds become standard `![alt](…)` syntax on the way out, because the
 * destination is by definition somewhere that may not read `![[…]]`. Note
 * transclusions and remote URLs are left exactly as written.
 */
async function exportMarkdown (to) {
  if (!state.current || viewingPdf() || viewingSite() || !NOTE_EXT.test(state.current.path)) {
    toast('Open a note first.')
    return
  }
  if (state.dirty) await saveNow()

  const name = state.current.path.replace(NOTE_EXT, '').split('/').pop()
  const text = noteText()
  const dir = state.current.dir || ''
  const folder = `${name} files`

  const assigned = new Map()          // vault rel path -> basename in the folder
  const used = new Set()
  const nameFor = (rel) => {
    if (assigned.has(rel)) return assigned.get(rel)
    let base = rel.split('/').pop()
    if (used.has(base.toLowerCase())) {
      // Two different files with one name; the second gets a number.
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      let n = 2
      while (used.has(`${stem} ${n}${ext}`.toLowerCase())) n++
      base = `${stem} ${n}${ext}`
    }
    used.add(base.toLowerCase())
    assigned.set(rel, base)
    return base
  }

  let out = ''
  let scanned = 0
  for (const embed of findEmbeds(text)) {
    const rel = state.resolveAsset(embed.src, dir)
    if (!rel) continue                // a URL, a transclusion, a missing file
    const base = nameFor(rel)
    const target = `${folder}/${base}`.split('/').map(encodeURIComponent).join('/')
    out += text.slice(scanned, embed.from) + `![${embed.alt || ''}](${target})`
    scanned = embed.to
  }
  out += text.slice(scanned)

  const files = [...assigned].map(([rel, base]) => ({ rel, as: `${folder}/${base}` }))
  const result = await api.exportMarkdown(name, out, files, to)
  if (result?.ok) {
    toast(`Exported ${result.path.split('/').pop()}` +
      `${result.copied ? ` with ${result.copied} ${result.copied === 1 ? 'file' : 'files'}` : ''}`)
  } else if (!result?.canceled) {
    toast(result?.error || 'The export did not finish.')
  }
  return result
}

/**
 * A CSV or TSV of vocabulary, into the open language table.
 *
 * The parsing is the grid's own (src/csv.js, fetched on demand — it is
 * already a lazy chunk) and the append logic is the deck's own
 * (`importCards`), so a file lands exactly where a row typed by hand would.
 */
async function importLanguageCsv () {
  if (!state.current || !isLanguageTablePath(state.current.path)) {
    toast('Open a language table first.')
    return
  }
  let picked
  try {
    picked = await api.review.pickCsv()
  } catch (err) {
    toast(err?.message || 'The file could not be read.')
    return
  }
  if (!picked) return

  const { parseSeparated, sniffDelimiter } = await import('./csv.js')
  const rows = parseSeparated(picked.text, sniffDelimiter(picked.text))
  const view = await ensureEditor()
  const edit = importCards(view.state.doc.toString(), rows)
  if (!edit.added) {
    toast(edit.skipped
      ? 'Every card in that file is already in the table.'
      : `No cards found in ${picked.name}.`)
    return
  }
  view.dispatch({ changes: { from: edit.at, to: edit.at, insert: edit.insert } })
  toast(`Added ${edit.added} ${edit.added === 1 ? 'card' : 'cards'}` +
    `${edit.skipped ? ` — ${edit.skipped} already in the table` : ''}.`)
}

/**
 * ⌘Z, aimed at whichever history the reader is actually looking at.
 *
 * Three of them, and only one can be meant at a time: a plain text field keeps
 * its own and the browser walks it, a note's belongs to the editor, and a PDF —
 * which has no text to edit at all — can only mean the marking-up. The order
 * below is the order of specificity: the field you are typing in first, then
 * the document on screen.
 *
 * @param {boolean} redo  forwards rather than back
 */
function stepHistory (redo) {
  const focus = document.activeElement
  if (focus?.matches?.('input, textarea')) {
    ;(redo ? api.edit.redo : api.edit.undo)()
    return
  }

  if (viewingPdf()) {
    const what = redo ? pdf.redo() : pdf.undo()
    /* Said out loud, because a highlight coming back three pages up is a change
       the reader cannot see happen — unlike a letter reappearing under the
       cursor, which needs no announcement. */
    setStatusRight(what
      ? `${redo ? 'Redid' : 'Undid'} ${what}`
      : `Nothing to ${redo ? 'redo' : 'undo'}`)
    return
  }

  if (viewingWhiteboard()) {
    whiteboardInstance?.undo(redo)
    return
  }

  /* The grid keeps its own history — cell patches and, for the structural
     changes, snapshots of the row list — because the file underneath it is
     not a text buffer with an edit log. */
  if (viewingData()) {
    dataInstance?.history(redo)
    return
  }

  /* A notebook keeps two: the cell list, for the changes to its shape, and the
     browser's own for the cell being typed into. Which one a ⌘Z is about is
     decided there, from where the caret is. */
  if (viewingNotebook()) {
    notebookInstance?.history(redo)
    return
  }

  /* Reading view has no cursor to put anything back at, so undoing there steps
     across to the editing view first — the same move ⌘F makes, for the same
     reason: you are being shown the thing you asked to change. Focus is only
     taken if it was somewhere else entirely; a cell of a table is already
     inside the editor, and its edits are the editor's transactions. */
  /* Nothing to undo without an editor: it holds the history, and a session
     that has only ever read has made no edits for it to hold. */
  if (!editor) return
  if (!editor.dom.contains(document.activeElement)) {
    if (reading()) setView('edit')
    editor.focus()
  }
  if (redo) editor.redo()
  else editor.undo()
}

/* --------------------------------------------------------------- settings

   One place where a stored preference becomes a fact about the running app.
   The panel in src/settings.js only names keys and draws controls; everything
   a setting *does* is here, so there is one answer per key rather than one in
   the panel and another at boot.
   ================================================================== */

/* The writing column, as three named widths rather than a number. A measure is
   a typographic decision — somewhere near 65 characters — not a slider. */
const MEASURES = { narrow: '28rem', normal: '34rem', wide: '44rem' }

function applySettings (cfg) {
  state.cfg = cfg || {}

  /* Which files are held in reading view. Read here rather than at boot alone
     so a config written by the other window is picked up the same way every
     other setting is. */
  state.locked = new Set(Array.isArray(cfg.lockedFiles) ? cfg.lockedFiles : [])

  applyTheme(cfg.theme || 'light')
  applyFonts(cfg)
  /* Readable line length off means no measure at all: the column takes the
     window, the way a plain text editor does. The chosen width is remembered
     either way, so turning it back on returns to the same column. */
  document.documentElement.style.setProperty(
    '--measure',
    // 100% rather than none: the column is clamped with min(), which needs a
    // length on both sides. Full width is what "no measure" means anyway.
    cfg.readableWidth === false ? '100%' : (MEASURES[cfg.measure] || MEASURES.normal))

  // Both views number their code from the same switch; the CSS decides how.
  el.app.dataset.codeNumbers = cfg.codeNumbers === false ? 'off' : 'on'
  // Reading view headings sit left with the prose, or centred when asked.
  el.app.dataset.centerHeadings = cfg.centerHeadings === true ? 'on' : 'off'
  /* A `.csv` grid draws rules between its columns; this asks it for the rest
     of the lattice, so every cell is boxed. The grid is rebuilt from a virtual
     window as it scrolls, so this is a fact about the shell rather than a
     class the grid has to remember to put on each cell it makes. */
  el.app.dataset.csvBorders = cfg.csvBorders === true ? 'on' : 'off'
  /* Reading view only: the editing view's whole scroll-sync machinery for code
     (see codeblock.js) assumes lines that do not fold. */
  /* Read before it is overwritten: the attribute is where the previous answer
     lives, and the reset below is about the change and not about the value. */
  const wasWrappingCode = el.app.dataset.codeWrap === 'on'
  const wrapsCode = cfg.codeWrap === true
  el.app.dataset.codeWrap = wrapsCode ? 'on' : 'off'
  /* A pre can keep the horizontal position it had before wrapping was turned
     on. When wrapping is later turned off that dormant scroll offset becomes
     visible as code clipped at the left edge, so the newly scrollable blocks
     always reopen at the start of the line.

     Only on that transition, though. `applyConfig` runs for every setting and
     once at boot, and writing `scrollLeft` forces layout on the element it is
     written to — so with wrapping off, which is the default, this walked every
     code block on the page and laid each one out, every time. On a note with
     13,000 fenced blocks that stopped being slow and started being permanent:
     the window never answered again. (It is reached from `ensureEditor`, so it
     landed a moment after such a note opened and looked like the render.)
     Blocks made by a later render start at zero of their own accord, which is
     why the transition is the only case there ever was. */
  if (wasWrappingCode && !wrapsCode) {
    for (const pre of el.reading.querySelectorAll('pre.code-text')) pre.scrollLeft = 0
  }
  /* Switching it off takes the underlines with it inside the editor; switching
     it on can only ask for a fresh pass, since the words come from main. */
  editor?.setSpellcheck(cfg.spellcheck !== false)
  if (cfg.spellcheck !== false) queueSpelling()
  savedSearches?.set(cfg.savedSearches)

  /* Two older spellings of the same preference, read in the order they were
     invented: `outline` was a boolean back when the sidebar chose between two
     panes, `pane` a name back when it chose between five and the files were
     one of them. An install left on any of the four opens with it underneath
     the tree; one left on the files opens with just the tree, which is what it
     was already showing. */
  setPaneBelowHeight(Number(cfg.paneBelowHeight) || PANE_BELOW_DEFAULT, false)
  setPaneBelow(cfg.paneBelow || cfg.pane || (cfg.outline ? 'outline' : null), false)
}

/** Record one setting and put it into effect. */
function setSetting (key, value) {
  if (!key) return
  state.cfg = { ...state.cfg, [key]: value }

  // Zoom belongs to the window rather than the page, so it is asked for rather
  // than applied — the main process answers with what it settled on.
  if (key === 'zoom') { api.zoom.set(value); return }

  api.config.set({ [key]: value })
  applySettings(state.cfg)
  // The copilot keeps its own copy of these three, and its own controls for
  // them; telling it is what keeps the two places from disagreeing.
  if (key.startsWith('ai')) copilot.applyConfig(state.cfg)
}

/* Settings is a self-contained pane and is absent until somebody asks for it.
 * Keeping its controls, model catalogue and dropdown machinery off the startup
 * path saves parsing work on every launch while preserving the same public
 * `settings.open()` surface used by commands and the drive harness. */
let settingsLoading = null
const loadSettings = () => (settingsLoading ??= import('./settings.js').then(({ mountSettings }) =>
  mountSettings({
    el: {
      root: el.settings,
      rail: el.settingsRail,
      body: el.settingsBody,
      title: el.settingsTitle,
      close: el.settingsClose
    },
    api,
    values: () => state.cfg,
    onChange: setSetting
  })
))

const settings = {
  open: () => loadSettings().then((pane) => pane.open())
}

/* The review panel, fetched the first time it is asked for. It is a page about
   studying, and a vault that studies nothing should never pay for it — the
   same reasoning that keeps the editor, the copilot and the whiteboard off the
   startup path. */
let reviewStatsLoading = null
const loadReviewStats = () => (reviewStatsLoading ??= import('./review-panel.js')
  .then(({ mountReviewStats }) => mountReviewStats({
    api,
    toast,
    openNote: (path) => openNote(path)
  })))

const savedSearches = mountSavedSearches({
  root: el.savedSearches,
  onOpen: (query) => openOverlay('search', { query }),
  onChange: (items) => setSetting('savedSearches', items)
})

/* The toggle animates the grid's columns, which hands the document a new
   width on every frame of the slide — CodeMirror re-measuring, a PDF
   refitting, a <webview> resizing its process's surface, fifteen times for
   one keypress. That per-frame relayout is the whole of the lag. Pinning the
   stage at the wider of its two widths for the duration turns the slide into
   a translation of already-laid-out content: the main column clips the edge
   instead, and the one real reflow happens at a single moment — when a close
   begins, or when an open settles. */
let slideTimer = null
function freezeStage (opening) {
  const wide = el.stage.clientWidth + (opening ? 0 : el.sidebar.offsetWidth)
  el.stage.style.width = wide + 'px'
  el.stage.style.flex = 'none'
  el.main.classList.add('is-sliding')
  el.app.classList.add('is-sliding')
  clearTimeout(slideTimer)
  // The transitionend below is the real release; this is the net under it —
  // the event does not fire if the transition is interrupted or disabled.
  slideTimer = setTimeout(releaseStage, 320)
}

/* A long rendered note is ordinary DOM rather than CodeMirror's virtual
   viewport. Dragging the left divider used to hand that entire page a new
   width for every pointer event, while also remeasuring every ellipsised row
   in the file tree. In Reading view only, hold both at their starting widths
   while the divider follows the pointer; releasing it performs the one layout
   that matters. Editing stays live because its viewport is already bounded. */
let readingSidebarResizePinned = false
let readingSidebarResizeStart = 0
function freezeReadingSidebarResize () {
  clearTimeout(slideTimer)
  slideTimer = null
  readingSidebarResizePinned = true
  readingSidebarResizeStart = el.sidebar.offsetWidth
  el.stage.style.width = el.stage.clientWidth + 'px'
  el.stage.style.flex = 'none'
  el.sidebar.style.setProperty('--frozen-rail', readingSidebarResizeStart + 'px')
  el.main.classList.add('is-sliding')
  el.app.classList.add('is-sliding')
}
function releaseStage () {
  clearTimeout(slideTimer)
  slideTimer = null
  el.stage.style.width = ''
  el.stage.style.flex = ''
  el.sidebar.style.width = ''
  el.sidebar.style.removeProperty('--frozen-rail')
  el.main.style.transform = ''
  el.main.classList.remove('is-sliding')
  el.app.classList.remove('is-sliding')
}
el.app.addEventListener('transitionend', (e) => {
  if (e.target === el.app && e.propertyName === 'grid-template-columns') releaseStage()
})

function toggleSidebar (on = !sidebarOpen()) {
  const drawer = window.matchMedia('(max-width: 760px)').matches
  if (!drawer) freezeStage(on)
  el.app.dataset.sidebar = on ? 'open' : 'closed'
  api.config.set({ sidebar: on ? 'open' : 'closed' })
  /* Everything that draws the outline skips the work while the panel is out of
     sight, so a document opened behind a closed sidebar left the last one's
     map in the DOM — a note's headings, still there over a PDF. Opening the
     panel is therefore the moment to redraw it — but after the slide, not
     during: parsing the note and rebuilding the rows in the same frames as
     the animation is what made its start stutter. */
  if (on) setTimeout(renderPanes, 320)
}

function closeNarrowPanel () {
  if (window.innerWidth > 1040) return false
  if (el.app.dataset.ai === 'open') {
    copilot.close()
    return true
  }
  if (el.app.dataset.side === 'open') {
    closeSidePane()
    return true
  }
  if (window.innerWidth <= 760 && el.app.dataset.sidebar === 'open') {
    toggleSidebar(false)
    return true
  }
  return false
}

/* The drawer's own dismissal. There is no cross in the sidebar's header any
   more, so tapping beside the drawer is what closes it — along with the toggle
   that opened it. */
el.drawerScrim.addEventListener('click', closeNarrowPanel)

/* ------------------------------------------------------- panel widths */

/* The resizing itself is src/panels.js. Refitting can narrow the main column,
   which is one of the ways the tab strip starts to overflow. */
const { restorePanelWidths } = mountPanels({
  el,
  api,
  onResize: () => {
    markTabOverflow()
    if (viewingWhiteboard()) whiteboardInstance?.resize()
    if (viewingData()) dataInstance?.resize()
  },
  onResizeStart: (key) => {
    if (key !== 'railWidth' || !reading()) return false
    freezeReadingSidebarResize()
    return true
  },
  onResizePreview: (key, width) => {
    if (key !== 'railWidth' || !readingSidebarResizePinned) return
    /* The divider follows the pointer without moving the grid. Only the small
       tree is laid out; the document shifts as a composited surface. */
    el.sidebar.style.width = width + 'px'
    el.main.style.transform = `translateX(${width - readingSidebarResizeStart}px)`
  },
  onResizeEnd: (key) => {
    if (key !== 'railWidth' || !readingSidebarResizePinned) return
    readingSidebarResizePinned = false
    releaseStage()
  }
})

/** Paint only — the chosen theme is left alone, which is what makes a preview
 *  reversible. */
/* Cleared a frame after the swap, once the new colours are on screen. */
let swapDone = 0

/**
 * Point the window at a palette.
 *
 * Transitions are switched off across the whole document for the swap itself
 * and switched back on a frame later. Thirty-odd rules in the stylesheet ease
 * their own background or colour, which is right when one control changes
 * state and wrong when the ground moves: a theme change starts every one of
 * those crossfades at the same instant, hundreds of them, and arrowing through
 * the picker restarts the lot on each keypress. That is the whole of what made
 * it feel slow — the swap itself is one attribute.
 */
function paintTheme (id) {
  const root = document.documentElement
  root.dataset.swapping = ''
  root.dataset.theme = resolveTheme(id)
  cancelAnimationFrame(swapDone)
  // Two frames: the first is the one the new colours are painted in, and
  // allowing transitions back during it would animate them after all.
  swapDone = requestAnimationFrame(() => {
    swapDone = requestAnimationFrame(() => { delete root.dataset.swapping })
  })
}

/* ----------------------------------------------------------- previewing

   Moving through a picker paints the whole window on every keypress, and a
   held arrow key fires faster than the screen refreshes. Each preview is
   collapsed into the next frame, so a run down the list costs one repaint per
   frame rather than one per keystroke — and whatever is pending is dropped the
   moment the picker is closed or a choice is made, or it would land after the
   answer and paint over it.
   ================================================================== */

let previewFrame = 0

function preview (paint) {
  cancelAnimationFrame(previewFrame)
  previewFrame = requestAnimationFrame(paint)
}

const dropPreview = () => cancelAnimationFrame(previewFrame)

/* ---------------------------------------------------------------- fonts */

/** Put one role's typeface on the document. */
function paintFont (role, id) {
  document.documentElement.style.setProperty(FONT_ROLES[role].token, fontStack(id, role))
}

/** Both of them, from stored settings — the pair the window opens with. */
function applyFonts (cfg) {
  for (const [role, spec] of Object.entries(FONT_ROLES)) {
    const id = isFont(cfg[spec.key]) ? cfg[spec.key] : spec.fallback
    state.fonts[role] = id
    paintFont(role, id)
  }
}

/** The list the font picker shows: the one in use first. */
/* A picker opens on what is already chosen, so the current entry leads the
   list. Copied, because the caller's array is the module's own constant. */
function currentFirst (list, id) {
  const copy = list.map((item) => ({ ...item }))
  const i = copy.findIndex((item) => item.id === id)
  if (i > 0) copy.unshift(copy.splice(i, 1)[0])
  return copy
}

const fontItems = (role) => currentFirst(FONTS, state.fonts[role])

async function commitFont (role, id) {
  dropPreview()
  state.fonts[role] = isFont(id) ? id : FONT_ROLES[role].fallback
  paintFont(role, state.fonts[role])
  closeOverlay()

  const key = FONT_ROLES[role].key
  state.cfg = { ...state.cfg, [key]: state.fonts[role] }
  /* The editor measures a character to lay out its lines, and that measurement
     was taken in the old face. Without this the note keeps the previous
     font's metrics — wrong wrapping, and a caret that sits beside the letter
     it is supposed to be in. */
  editor?.requestMeasure()
  if (reading()) rerenderReading()
  toast(`${FONT_ROLES[role].label}: ${fontLabel(state.fonts[role])}`)
  await api.config.set({ [key]: state.fonts[role] })
}

function applyTheme (id) {
  state.theme = isTheme(id) ? id : 'light'
  paintTheme(state.theme)
}

/**
 * Anything drawn *in* the palette rather than painted by it has to be made
 * again when the palette moves. Diagrams are the only such thing so far: they
 * are SVG generated against the theme's colours, not styled by them.
 *
 * Called on a settled choice, never on a preview — stepping through the theme
 * picker would otherwise re-render every diagram in the note per keystroke.
 *
 * Held back two frames rather than run on the spot. Changing the palette is an
 * attribute flip and costs nothing; redrawing the diagrams is a note's worth of
 * work, and in the same task the browser paints neither until both are done —
 * which is why the theme used to arrive long after it was chosen. Waiting for
 * the palette's own paint puts the colour first and the diagrams after it, and
 * cancelling the pending pass coalesces a run of quick theme changes into one.
 */
let themeRedraw = 0
function redrawForTheme () {
  cancelAnimationFrame(themeRedraw)
  themeRedraw = requestAnimationFrame(() => {
    themeRedraw = requestAnimationFrame(() => {
      if (viewingWhiteboard()) whiteboardInstance?.theme()
      else if (reading()) rerenderReading()
      /* The editing view is up, so the editor — and with it the module holding
         this effect — is already built. Imported here rather than at the top of
         the file because `refreshDiagrams` is a CodeMirror StateEffect, and
         naming it up there would put the whole editing stack back on the
         startup path. The import resolves from cache. */
      else if (editor) {
        import('./mermaid-editor.js')
          .then(({ refreshDiagrams }) => editor?.dispatch({ effects: refreshDiagrams.of(null) }))
          .catch(() => {})
      }
    })
  })
}

async function commitTheme (id) {
  dropPreview()
  applyTheme(id)
  closeOverlay()
  state.cfg = { ...state.cfg, theme: state.theme }
  redrawForTheme()
  toast(THEMES.find((t) => t.id === state.theme)?.label || state.theme)
  await api.config.set({ theme: state.theme })
}

/** Keep the palette alphabetic even when a theme is added out of order. */
const themeItems = () => THEMES
  .map((theme) => ({ ...theme }))
  .sort((a, b) => a.label.localeCompare(b.label))

function swatch (theme) {
  const wrap = document.createElement('span')
  wrap.className = 'swatch'
  for (const colour of theme.swatch) {
    const dot = document.createElement('i')
    dot.style.setProperty('--dot', colour)
    wrap.append(dot)
  }
  return wrap
}

async function cycleTheme () {
  const next = state.theme === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  state.cfg = { ...state.cfg, theme: next }
  redrawForTheme()
  toast(next === 'dark' ? 'Ink' : 'Paper')
  await api.config.set({ theme: next })
}

/* ---------------------------------------------------------- attachments */

/**
 * Files pasted or dropped into the editor are written into the vault and
 * referred to by name, so a note stays a plain-text file that happens to point
 * at a picture — nothing is embedded as base64 and nothing lives only in the
 * app. The main process decides where they land; see `asset:write`.
 */
async function attachFiles (files, insertIntoTable = null) {
  if (!state.current) { toast('Open a note first.'); return }

  const inserts = []
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const ext = extensionFor(file)
      const { name } = await api.asset.write(state.current.name, ext, bytes)
      inserts.push(`![[${name}]]`)
    } catch (err) {
      toast(err.message || 'That file could not be saved into the vault.')
    }
  }
  if (!inserts.length) return

  // The list has to be refreshed before the text goes in, or the embed renders
  // as missing for the moment between the two.
  await loadAssets()

  if (insertIntoTable) {
    insertIntoTable(inserts.join(' '))
    toast(inserts.length === 1 ? 'Image added to cell' : `${inserts.length} images added to cell`)
    return
  }

  /* Dropping a picture onto a note being read is an edit to it, so this is
     where a reading-only session stops being one. */
  const view = await ensureEditor()
  const { from, to } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  // An embed is a block-ish thing; dropping one into the middle of a sentence
  // is almost never what was meant, so it starts on its own line.
  const lead = line.from === from || !line.text.trim() ? '' : '\n'
  const insert = `${lead}${inserts.join('\n')}\n`

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
    userEvent: 'input'
  })
  editor?.focus()
  toast(inserts.length === 1 ? 'Image added' : `${inserts.length} images added`)
}

/** The MIME type is authoritative — a clipboard image is always called
 *  `image.png` whatever it actually is — and the name is the fallback for the
 *  types the browser has no opinion about. */
function extensionFor (file) {
  const mime = /^(?:image|video|audio)\/([a-z0-9.+-]+)$/i.exec(file.type || '')
  if (mime) return `.${mime[1].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`
  const named = /\.[a-z0-9]+$/i.exec(file.name || '')
  return named ? named[0].toLowerCase() : '.png'
}

/* What the vault will actually take. Asking assets.js rather than re-listing
   the formats keeps this from drifting out of step with what can be rendered. */
const attachable = (list) => [...list].filter((f) => isAsset(f.name || ''))

/**
 * Every image in the vault that no note refers to any more.
 *
 * Pictures accumulate silently — a paste into a note that was later deleted,
 * an embed edited away — and nothing lists the attachments, so there is
 * nowhere to notice them. The sweep reads every note and resolves every
 * reference through the same resolver the renderers use, so what it calls
 * orphaned is exactly what no view would show.
 */
async function showOrphanedImages () {
  const { assets } = await api.vault.snapshot()
  // Chat attachments are deliberately referred to by no note.
  const images = assets.filter((path) => isImageAsset(path) && !isChatAttachment(path))
  if (!images.length) { toast('The vault holds no images.'); return }

  setStatusRight('Looking for orphaned images…')
  const resolve = assetIndex(assets)
  const referenced = new Set()
  const claim = (src, dir) => {
    // The way the embeds resolve, then once more without a heading anchor.
    const hit = resolve(src, dir) ||
      (src.includes('#') ? resolve(src.split('#')[0], dir) : null)
    if (hit) referenced.add(hit)
  }

  /* Every note in one call. Main is holding all of this text in the index it
     answers searches and backlinks from, so reading them back one at a time —
     an IPC round trip and a disk read per note — was asking it to fetch what it
     already had, a couple of thousand times over. The scanning stays here: what
     counts as a reference is the resolver the views themselves use. */
  for (const note of await api.vault.notes()) {
    if (!NOTE_EXT.test(note.path)) continue
    const { text } = note
    const dir = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : ''

    for (const embed of findEmbeds(text)) claim(embed.src, dir)
    /* A plain link holds on to a picture as surely as an embed shows one —
       the three non-embed ways a note can point at a file: a wikilink, a
       markdown link, and a src attribute in raw HTML. */
    for (const m of text.matchAll(/(?<!!)\[\[([^[\]|]+)/g)) claim(m[1].trim(), dir)
    for (const m of text.matchAll(/(?<!!)\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g)) claim(m[1].trim(), dir)
    for (const m of text.matchAll(/\bsrc=["']([^"']+)["']/g)) claim(m[1].trim(), dir)
  }
  setStatusRight('')

  const orphans = images.filter((path) => !referenced.has(path))
  if (!orphans.length) { toast('No orphaned images — every picture is referred to.'); return }

  openOrphansDialog(orphans)
}

/* ------------------------------------------------------ orphans dialog

   The list as a judgement, not a filter: each picture is shown, and each can
   be revealed in Finder or moved to the Trash — one at a time, or all at
   once behind a question. Deletes go to the Trash the way every delete in
   the app does, so a wrong call here is a drag back out, not a loss.
   ================================================================== */

let orphansOpen = null   // { returnTo } while the dialog is up

function closeOrphansDialog () {
  if (!orphansOpen) return
  el.orphans.hidden = true
  el.orphansList.replaceChildren()
  const { returnTo } = orphansOpen
  orphansOpen = null
  if (returnTo instanceof HTMLElement) returnTo.focus?.()
}

function paintOrphanCount () {
  const left = el.orphansList.querySelectorAll('.orphan-row:not(.is-going)').length
  el.orphansCount.textContent = left === 1 ? '1 image' : `${left} images`
  el.orphansAll.disabled = !left
  // The work is done: the list emptying is the dialog's own answer.
  if (!left) {
    toast('All orphaned images moved to the Trash.')
    closeOrphansDialog()
  }
}

/**
 * Move one orphan to the Trash, letting its row say so. The row fades before
 * the IPC answers so a run of deletes reads as motion, and comes back — with
 * a word — if the file would not go.
 */
async function trashOrphan (row) {
  row.classList.add('is-going')
  try {
    await api.file.remove(row.dataset.path)
  } catch {
    row.classList.remove('is-going')
    toast(`Couldn’t move “${row.dataset.path.split('/').pop()}” to the Trash.`)
    return false
  }
  row.remove()
  paintOrphanCount()
  return true
}

function openOrphansDialog (paths) {
  const rows = paths.map((path) => {
    const row = document.createElement('div')
    row.className = 'orphan-row'
    row.dataset.path = path

    const thumb = document.createElement('img')
    thumb.className = 'orphan-thumb'
    thumb.src = assetUrl(path)
    thumb.alt = ''
    thumb.loading = 'lazy'

    const name = document.createElement('span')
    name.className = 'orphan-name'
    name.textContent = path.split('/').pop()
    name.title = path
    const dir = path.split('/').slice(0, -1).join('/')
    const where = document.createElement('span')
    where.className = 'orphan-dir'
    where.textContent = dir || 'vault root'
    name.append(where)

    const acts = document.createElement('span')
    acts.className = 'orphan-acts'
    const reveal = document.createElement('button')
    reveal.className = 'orphan-act'
    reveal.textContent = 'Reveal'
    reveal.title = 'Show in Finder'
    reveal.addEventListener('click', () => api.file.reveal(path))
    const trash = document.createElement('button')
    trash.className = 'orphan-act is-trash'
    trash.textContent = 'Trash'
    trash.title = 'Move to the Trash'
    trash.addEventListener('click', () => trashOrphan(row))
    acts.append(reveal, trash)

    row.append(thumb, name, acts)
    return row
  })

  el.orphansList.replaceChildren(...rows)
  orphansOpen = { returnTo: document.activeElement }
  el.orphans.hidden = false
  paintOrphanCount()
  el.orphansClose.focus()
}

el.orphansClose.addEventListener('click', closeOrphansDialog)
el.orphans.addEventListener('mousedown', (e) => {
  if (e.target === el.orphans) closeOrphansDialog()
})
el.orphansAll.addEventListener('click', async () => {
  const rows = [...el.orphansList.querySelectorAll('.orphan-row:not(.is-going)')]
  if (!rows.length) return
  const sure = await ask({
    title: rows.length === 1
      ? 'Move this image to the Trash?'
      : `Move all ${rows.length} images to the Trash?`,
    detail: 'They can be put back from the Trash.',
    go: 'Move to Trash'
  })
  if (!sure || !orphansOpen) return
  // One at a time rather than all at once: each row reports its own fate, and
  // a failure part-way leaves the survivors listed instead of guessed at.
  for (const row of rows) {
    if (!orphansOpen) return
    await trashOrphan(row)
  }
})
/* Capture, so the dialog's Escape is not also somebody else's — but never
   while the Trash-all question is up: that Escape belongs to the question. */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !orphansOpen || !el.ask.hidden) return
  e.preventDefault()
  e.stopPropagation()
  closeOrphansDialog()
}, { capture: true })

function tableAttachmentInsertion (target) {
  if (!(target instanceof HTMLElement)) return null
  const cell = target.closest(
    '.tk-table [data-row][data-col][contenteditable="plaintext-only"]'
  )
  if (!cell) return null
  const detail = { insert: null }
  cell.dispatchEvent(new CustomEvent('tulip:table-attachment-paste', {
    bubbles: true,
    detail
  }))
  return typeof detail.insert === 'function' ? detail.insert : null
}

el.editorHost.addEventListener('paste', (e) => {
  const files = attachable(e.clipboardData?.files || [])
  if (!files.length) return
  // Only when there is nothing else on the clipboard: copying a region of a
  // web page carries both an image and its HTML, and the text is the useful
  // half of that.
  if ([...(e.clipboardData.types || [])].some((t) => t === 'text/plain')) return
  const insertIntoTable = tableAttachmentInsertion(e.target)
  e.preventDefault()
  e.stopPropagation()
  attachFiles(files, insertIntoTable)
}, true)

el.editorHost.addEventListener('drop', (e) => {
  const files = attachable(e.dataTransfer?.files || [])
  if (!files.length) return
  const insertIntoTable = tableAttachmentInsertion(e.target)
  e.preventDefault()
  e.stopPropagation()
  attachFiles(files, insertIntoTable)
}, true)

/* A file dropped anywhere else would make the window navigate to it, replacing
   the app with the file. There is nothing to drop onto outside the editor and
   the tree, and both of those have already handled it by the time this runs. */
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => { if (carriesFiles(e)) e.preventDefault() })
}

/* ---------------------------------------------------------------- toast */

let toastTimer = null
function toast (message) {
  el.toast.textContent = message
  el.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.toast.hidden = true }, 2600)
}

/* ----------------------------------------------------------------- boot */

/* There is no loading screen. The window stays off-screen until one of the two
   below has run — see the reveal in electron/main.js — so what a launch shows
   is the note, and nothing before it. All this does is put the half-built page
   out of sight for the one case where the window is already up: a boot retried
   from the error card. */
function paintBootLoading () {
  el.app.dataset.booting = ''
  el.bootScreen.hidden = true
  el.bootScreen.dataset.state = 'loading'
  el.bootDetail.hidden = true
  el.bootDetail.textContent = ''
  el.bootRetry.hidden = true
  el.bootConnect.hidden = true
}

function paintBootReady () {
  delete el.app.dataset.booting
  el.bootScreen.hidden = true
  el.bootScreen.dataset.state = 'ready'
  el.bootScreen.setAttribute('aria-busy', 'false')
  api.painted()
}

function paintBootError (error) {
  el.app.dataset.booting = ''
  el.bootScreen.hidden = false
  el.bootScreen.dataset.state = 'error'
  el.bootScreen.setAttribute('aria-busy', 'false')
  el.bootTitle.textContent = 'Tulip could not open'
  el.bootMessage.textContent = 'Your workspace is safe. Try again or choose another vault.'
  el.bootDetail.textContent = error?.message || 'Tulip could not finish opening the workspace.'
  el.bootDetail.hidden = false
  el.bootRetry.hidden = false
  el.bootConnect.hidden = false
  // The launch failed, so nothing else will ask for the window: this card is
  // what there is to show, and a window that never appears is worse than it.
  api.painted()
}

/* Connecting a vault is the same act whether it is the first one or the fifth:
   main remembers the folder and announces it, and the `vault:opened` handler
   below repoints the whole window at it — it has to, because the File menu can
   do this too. What is left here is the one thing that only follows from a
   folder chosen by hand: an empty vault is given a note to start writing in,
   rather than opening onto nothing. */
/**
 * The vaults Tulip has opened before, as a picker.
 *
 * Until now the only route between two vaults was the native folder dialog:
 * every switch meant navigating a file browser to somewhere you had already
 * been. The config held two scalar paths and no history, so nothing could
 * offer a list even in principle.
 *
 * A folder that has gone away — an unmounted drive, a synced vault not yet
 * downloaded — stays on the list and says so rather than disappearing from
 * it, because a missing vault is nearly always a temporarily missing one.
 */
async function openRecentVault () {
  const vaults = await api.vault.recent().catch(() => [])
  if (!vaults.length) {
    // Nothing to choose between yet, so offer the thing they would choose next.
    connectVault()
    return
  }
  openOverlay('vaults', {
    vaults: [
      /* First, because it is the one entry that is always right: a list of
         places you have been is not much use the moment you want somewhere
         new, and this used to be the only thing the button did. */
      { path: null, label: 'Choose a folder…' },
      ...vaults.map((vault) => ({
        ...vault,
        label: vault.missing ? `${vault.name} — not found` : vault.name,
        // The full path, because two vaults are often two folders of one name.
        detail: vault.path
      }))
    ]
  })
}

async function openVaultAt (dir) {
  // The picker's first row, which is the native dialog rather than a recent.
  if (!dir) { connectVault(); return }
  const answer = await api.vault.open(dir).catch(() => null)
  /* Main refuses a folder that has gone rather than opening an empty vault
     over the one that was working; the reason it gives is the useful half. */
  if (!answer?.ok) {
    toast(`That vault could not be opened — ${answer?.reason || 'the request failed'}.`)
    return
  }
  // The rest follows from `vault:opened`, which main sends and the app obeys.
}

async function connectVault () {
  const recovering = !el.bootScreen.hidden
  if (recovering) paintBootLoading()
  try {
    const picked = await api.vault.pick()
    if (!picked) {
      if (recovering) paintBootError(new Error('No vault was selected.'))
      return
    }
    await loadTree()
    if (!state.files.length) await createNote('')
  } catch (error) {
    console.error('vault connection failed', error)
    if (recovering) paintBootError(error)
    else toast(error?.message || 'That vault could not be opened.')
  }
}

el.connectVault.addEventListener('click', connectVault)
el.bootConnect.addEventListener('click', connectVault)
el.bootRetry.addEventListener('click', () => boot())
$('vault-name').addEventListener('click', openRecentVault)
$('btn-new-note').addEventListener('click', () => createNote(state.current?.dir || ''))
$('btn-new-folder').addEventListener('click', () => createFolder(state.current?.dir || ''))
$('btn-search').addEventListener('click', () => openOverlay('search'))
el.foldAll.addEventListener('click', toggleAllFolders)
el.viewSwitch.addEventListener('click', (event) => {
  const button = event.target.closest('.view-option')
  if (button && !button.disabled) setView(button.dataset.view)
})

function showImageContextMenu (path, event) {
  if (!path) return
  renderContextMenu([
    { label: 'Reveal in Finder', run: () => api.file.reveal(path) },
    { sep: true },
    {
      label: 'Move image to Trash',
      danger: true,
      run: () => removeEmbeddedImage(path)
    }
  ], event)
}

/**
 * The menu over a word the app has underlined: what it might have been, and
 * the way to say it was right all along.
 *
 * The app's menu rather than the platform's, because the underline is the
 * app's — Chromium has no suggestions for a word it never marked. The word is
 * replaced through a normal transaction, so ⌘Z takes the correction back.
 */
async function showSpellingMenu (at, event) {
  // The menu is opened where the click was; the click is over by the time the
  // suggestions arrive, so the position is kept rather than the event.
  const where = { clientX: event.clientX, clientY: event.clientY }
  const suggestions = await api.spell.suggest(at.word).catch(() => [])
  // The document moved while the dictionary was thinking — a menu offering to
  // rewrite a range that has shifted would rewrite the wrong words.
  if (editor.state.sliceDoc(at.from, at.to) !== at.word) return

  const items = suggestions.length
    ? suggestions.map((to) => ({
        label: to,
        run: () => {
          editor?.dispatch({
            changes: { from: at.from, to: at.to, insert: to },
            selection: { anchor: at.from + to.length },
            userEvent: 'input.spelling'
          })
          editor?.focus()
        }
      }))
    : [{ label: 'No suggestions', disabled: true, run: () => {} }]

  items.push({ sep: true }, {
    label: `Add “${at.word}” to Dictionary`,
    // Main tells everyone the dictionary changed, and the note is read again
    // — so this word's underline goes here and its row leaves the pane.
    run: () => api.dictionary.add(at.word)
  })

  renderContextMenu(items, where)
}

/* The note's own menu. Right-clicking the page is where a reader reaches for
   how the page is set, so the measure is offered here rather than only in
   settings — the one setting you change while looking at the thing it changes.
   Inside a text field the system menu is the right one, so it is left alone. */
el.stage.addEventListener('contextmenu', (e) => {
  const image = e.target.closest('.embed-img[data-vault-image]')
  if (image) {
    e.preventDefault()
    showImageContextMenu(image.dataset.vaultImage, e)
    return
  }

  /* A word the app has underlined, before the native menu is left to it below:
     the platform's checker is off over the note (see setSpellcheck in
     src/editor.js), so its menu would offer nothing here. */
  if (e.target.closest?.('.cm-misspelled')) {
    const pos = editor.posAtCoords({ x: e.clientX, y: e.clientY })
    const at = pos == null ? null : editor.misspellingAt(pos)
    if (at) {
      e.preventDefault()
      showSpellingMenu(at, e)
      return
    }
  }

  // Inside anything that takes typing, the native menu is the right one: the
  // fields on the page (a table's cells, the search panel's boxes) and the
  // editor's own text, whose menu is where spelling suggestions and "Add to
  // Dictionary" live — see the context-menu handler in electron/main.js. The
  // measure menu keeps the rest of the page: the margins and everything the
  // editor draws that is not text.
  if (e.target.closest('input, textarea, [contenteditable="plaintext-only"], .cm-content')) return

  /* Every other kind shares this stage but not this menu. The measure sets the
     writing column — it is `--measure` on the reading view and on the editor,
     and nothing else in the app reads it — so over a PDF, a table, a board, a
     page or a picture this was a switch that did nothing to what was on
     screen, offered in the one place a reader would expect it to. */
  if (!viewingText()) return

  e.preventDefault()

  const readable = state.cfg.readableWidth !== false
  renderContextMenu([
    {
      label: 'Readable line length',
      checked: readable,
      run: () => setSetting('readableWidth', !readable)
    }
  ], e)
})

/* Table widgets relay their image gesture explicitly because their nested
   contenteditable/CodeMirror event path can consume the native contextmenu
   before it reaches the stage. */
el.stage.addEventListener('tulip:image-contextmenu', (event) => {
  event.stopPropagation()
  showImageContextMenu(event.detail?.path, {
    clientX: event.detail?.x ?? 0,
    clientY: event.detail?.y ?? 0
  })
})

/* Table cells own their editing gestures in table.js, but the app owns the one
   context-menu surface. The custom event keeps those responsibilities apart
   while still making table actions look and dismiss like every other menu. */
el.stage.addEventListener('tulip:table-contextmenu', (event) => {
  event.stopPropagation()
  const detail = event.detail
  const items = []
  if (detail.selectedCount > 1) {
    items.push({
      label: `Clear ${detail.selectedCount} cells`,
      run: detail.clearSelected
    })
    items.push({ sep: true })
  }
  items.push(
    { label: 'Select row', run: detail.selectRow },
    { label: 'Select column', run: detail.selectColumn },
    { sep: true }
  )
  /* Sorting is a property of the column the click landed in, so it says which
     one — a table of six columns is six different sorts from the same menu. */
  if (detail.canSort) {
    items.push(
      { label: `Sort by ${detail.columnName} (A→Z)`, run: detail.sortAscending },
      { label: `Sort by ${detail.columnName} (Z→A)`, run: detail.sortDescending },
      { sep: true }
    )
  }
  items.push(
    {
      label: 'Add row before',
      disabled: !detail.canAddRowBefore,
      run: detail.addRowBefore
    },
    {
      label: 'Add row after',
      run: detail.addRowAfter
    }
  )
  if (detail.canAddColumn) {
    items.push(
      {
        label: 'Add column before',
        run: detail.addColumnBefore
      },
      {
        label: 'Add column after',
        run: detail.addColumnAfter
      }
    )
  }
  /* Reordering, which is a move rather than an edit: the row or column keeps
     everything it holds, and a column takes its alignment and width with it. */
  items.push(
    { sep: true },
    { label: 'Move row up', disabled: !detail.canMoveRowUp, run: detail.moveRowUp },
    { label: 'Move row down', disabled: !detail.canMoveRowDown, run: detail.moveRowDown }
  )
  if (detail.canAddColumn) {
    items.push(
      {
        label: 'Move column left',
        disabled: !detail.canMoveColumnLeft,
        run: detail.moveColumnLeft
      },
      {
        label: 'Move column right',
        disabled: !detail.canMoveColumnRight,
        run: detail.moveColumnRight
      }
    )
  }
  /* How the column reads, which in markdown is a property of the column and
     not of the cell that was right-clicked — the delimiter row carries it. The
     ticked entry is the one in force; choosing it again clears the column back
     to the default, so the three behave as one switch with an off position. */
  items.push(
    { sep: true },
    {
      label: 'Align left',
      checked: detail.align === 'left',
      run: () => detail.setAlign('left')
    },
    {
      label: 'Center',
      checked: detail.align === 'center',
      run: () => detail.setAlign('center')
    },
    {
      label: 'Align right',
      checked: detail.align === 'right',
      run: () => detail.setAlign('right')
    }
  )
  items.push(
    { sep: true },
    {
      label: detail.deleteRowCount > 1 ? `Delete ${detail.deleteRowCount} rows` : 'Delete row',
      disabled: !detail.canDeleteRow,
      run: detail.deleteRow
    }
  )
  if (detail.canDeleteColumn) {
    items.push({
      label: 'Delete column',
      run: detail.deleteColumn
    })
  }
  renderContextMenu(items, { clientX: detail.x, clientY: detail.y })
})

/* Transclusion and the hover preview render other notes with this module's
   own machinery — the one markdown-it instance, the one asset resolver, the
   one way of opening things — handed over here rather than imported, because
   assets.js dispatches into transclude.js and importing back would close the
   ring. See the header of src/transclude.js. */
initTransclusion({
  md,
  read: (path) => api.file.read(path),
  write: (path, text) => api.file.write(path, text),
  equationIndex,
  dressCitations,
  resolveAsset: (src, dir) => state.resolveAsset(src, dir),
  resolveNote: noteFromName,
  currentPath: () => state.current?.path || '',
  specForEmbed,
  renderEmbed,
  fileChip,
  open: async (path, anchor, opts) => {
    if (!await openNote(path, opts)) return
    revealInTree(path)
    if (anchor) jumpToHeading(anchor)
  },
  ...fragmentRouting
})
installNotePreview()

/* The side pane renders through the same frames transclusion does, so it is
   wired the same way — after initTransclusion, whose machinery it borrows. */
initSidePane({
  el: { app: el.app, body: el.sidepaneBody },
  isPdf: isPdfPath,
  label: docLabel,
  remember: (path) => sessionOnly({ sideDoc: path }),
  ...fragmentRouting
})
el.sidepaneClose.addEventListener('click', () => closeSidePane())

api.on('menu', runCommand)
api.on('zoom', showZoom)
/* A word was taught from the editor's own context menu, or taken back out in
   Settings. Either way the note in front of you is underlined by a dictionary
   that has just changed its mind, so it is read again. */
api.on('dictionary:changed', () => {
  spellingKeys = ''
  renderSpelling()
})
el.zoom?.addEventListener('click', () => api.resetZoom())
api.on('vault:changed', async ({ paths = [] } = {}) => {
  const open = state.current?.path
  /* *This* file moved under a buffer that has edits of its own. What was kept
     used to be decided here, in a toast; now the two are merged — a sync
     client's change and the edits in the buffer fold together where they do
     not touch, and where they do, the merge panel asks. The message names the
     files that moved because "something in the vault changed" is not enough to
     say that — a sync client touching another folder, a PDF dropped into
     Finder, the copilot writing to a different note all arrive here too, and
     each of them used to accuse the note being typed into. */
  const touched = state.dirty && open && paths.includes(open)
  const conflict = touched && isEditableTextPath(open)
  /* The documents with no line-by-line merge to fall back on. A whiteboard is
     a scene, a grid is a table and a notebook is a tree of cells and recorded
     output; three-way merging any of them as text would produce a file none of
     the three viewers could open. They took the buffer silently until now —
     and a notebook is the one most likely to have a second writer, because
     running Jupyter beside Tulip is what the feature is for. */
  const structuredConflict = touched &&
    (isWhiteboardPath(open) || isDataPath(open) || isNotebookPath(open))
  const handled = conflict ? await handleDiskConflict(open) : false
  /* A conflict with no common version to merge from falls back to the old
     bargain: the buffer is what was kept. */
  if (conflict && !handled) await keepBufferOverDisk(open, 'note')
  if (structuredConflict) {
    await keepBufferOverDisk(
      open,
      isWhiteboardPath(open) ? 'whiteboard' : isNotebookPath(open) ? 'notebook' : 'file'
    )
  }
  await loadTree()
  /* Something moved on disk. If it was the open note — a link rewrite, an edit
     in another app, a sync client — the buffer is now stale, and at the next
     autosave the stale buffer would win. A note the merge just settled is
     already the file's own text, so it is left alone here. */
  if (!handled) await reloadCurrent()
  // What links here is a fact about the other notes, so it moved when they did.
  queueLinks()
  // And so is what stands transcluded here: the note on show in a frame may be
  // the very one that changed — and only those need redrawing.
  refreshTransclusions(paths)
})
api.on('vault:opened', async (vault) => {
  try {
    state.vault = vault
    state.cfg.vaultPath = vault.path
    /* Revisions and attachment indexes are relative to the open vault. Clear
       them before the first snapshot so two folders with the same shape cannot
       make this window accept the previous folder's `unchanged` answer. */
    state.revision = null
    state.assetsKey = ''
    state.assets = []
    state.resolveAsset = () => null
    el.vaultLabel.textContent = vault.name
    // The first vault is also the way off the landing page.
    paintLanding()

    /* Everything on screen belongs to the folder being left. A note's path is
       relative to its vault, so a tab left open here is a path that now means a
       different file — or, since `file:write` makes the directories it needs, a
       file that does not exist yet and is about to. The buffer has already gone
       to disk (main flushes before it repoints; see `pickVault` there), so there
       is nothing left to save and every reason not to try: the autosave is
       disarmed before the tabs go, in case a keystroke landed during the switch.
       What is dropped, and why each: a pane still showing the old vault's note,
       a stack of its closed tabs waiting to be reopened into a vault they are
       not in, and the strip itself. */
    clearTimeout(state.saveTimer)
    state.dirty = false
    closeSidePane()
    closedTabs.length = 0
    state.tabs = [blankTab()]
    state.tabIndex = 0
    await showBlank()
    renderTabs()
    await loadTree()
    paintBootReady()
  } catch (error) {
    console.error('vault open failed', error)
    paintBootError(error)
  }
})
window.addEventListener('keydown', (e) => {
  /* A question owns the keyboard while it is up: esc says no, return always
     takes the filled primary action, and nothing else in the app is reachable.
     This remains true after Tab moves focus to Cancel; the colour, not focus
     position, is the dialog's statement of which action Return will take. */
  if (!el.ask.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); answer(false) }
    if (e.key === 'Enter') { e.preventDefault(); answer(true) }
    if (e.key === 'Tab') {
      e.preventDefault()
      ;(document.activeElement === el.askGo ? el.askCancel : el.askGo).focus()
    }
    return
  }

  /* A context menu is the topmost transient thing on screen, so esc dismisses
     it and stops there: closing the overlay underneath it in the same keystroke
     would be two answers to one question. Until now it went when you clicked
     somewhere or when the window lost focus, and esc — the key people actually
     reach for to take a menu back — did nothing. */
  if (e.key === 'Escape' && !el.ctx.hidden) {
    e.preventDefault()
    hideContextMenu()
    return
  }

  if (e.key === 'Escape' && !el.overlay.hidden) {
    closeOverlay()
    return
  }
  if (e.key === 'Escape' && closeNarrowPanel()) {
    e.preventDefault()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'p' && !e.shiftKey) {
    e.preventDefault()
    openOverlay('commands')
  }

  /* ⌃Tab walks the strip, the way it does in a browser. The menu carries the
     rest of the tab shortcuts; this one cannot live there, because Tab inside
     an accelerator is swallowed before the menu ever sees it. */
  if (e.key === 'Tab' && e.ctrlKey) {
    e.preventDefault()
    cycleTab(e.shiftKey ? -1 : 1)
  }

  pdfKeys(e)
  siteKeys(e)
})

/**
 * The keys a website answers to.
 *
 * ⌥← and ⌥→ for the page's own history, on the same modifier the PDF uses for
 * its pages and for the same reason: bare ⌘[ and ⌘] already mean the *tab's*
 * history — the trail of documents that led here — and a page you clicked into
 * is a different question from a document you opened.
 *
 * These fire wherever the focus is except a text field, which is what keeps ⌘R
 * from reloading the page out from under a half-typed address.
 */
function siteKeys (e) {
  if (!viewingSite() || !el.overlay.hidden) return
  if (e.target.closest?.('input, textarea, [contenteditable]')) return

  if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    if (e.key === 'ArrowLeft') site.back()
    else site.forward()
    return
  }

  if ((e.metaKey || e.ctrlKey) && e.key === 'r' && !e.shiftKey) {
    e.preventDefault()
    site.reload()
    return
  }

  /* ⌘L, which is where every browser puts the address bar. Worth having even
     though the field is right there and clickable: it is the one key that says
     "take me somewhere else" without reaching for the mouse. */
  if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
    e.preventDefault()
    el.siteAddress.focus()
  }
}

/**
 * The keys a PDF answers to.
 *
 * Bare `+`, `-` and `0` rather than the usual ⌘ pair, which the window's own
 * zoom already owns — and which a PDF has no reason to fight over, since there
 * is no text field on the page to type them into.
 */
function pdfKeys (e) {
  if (!viewingPdf() || !el.overlay.hidden) return
  if (e.metaKey || e.ctrlKey) return
  if (e.target.closest?.('input, textarea, [contenteditable]')) return

  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    pdf.goToPage(pdf.page() + (e.key === 'ArrowDown' ? 1 : -1))
    return
  }
  if (e.altKey) return

  if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomDoc(1) }
  else if (e.key === '-') { e.preventDefault(); zoomDoc(-1) }
  else if (e.key === '0') { e.preventDefault(); zoomDoc('fit') }
  /* The two tools, on the letters the drawing apps use. Bare, like the zoom
     keys and for the same reason: there is nothing on a page to type into. */
  else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); pdf.setTool('mark') }
  else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); pdf.setTool('select') }
  // Escape puts the highlighter down, which is the way out of a mode people
  // reach for without being told.
  else if (e.key === 'Escape' && pdf.tool() === 'mark') { e.preventDefault(); pdf.setTool('select') }
}

/* The window is held open until this answers — `beforeunload` cannot wait for
   an async IPC write, so main asks first and closes after. The unload handler
   below stays as a second chance for reloads. */
api.on('app:flush', async () => {
  /* Main closes the window after a short silence. A notebook of recorded plots
     is tens of megabytes to serialise and write, which is slower than that and
     is not a wedged page — so say so, repeatedly, for as long as this takes. */
  const alive = setInterval(() => api.flushing(), 500)
  try {
    if (state.dirty) await saveNow()
    /* The transcripts too. A reply that landed in the last moment before ⌘Q is
       still sitting behind a debounce, and the copilot's own `beforeunload`
       write happens after main has already let the process go. */
    await copilot.flush()
    // These surfaces debounce reader-authored state independently of the note.
    // beforeunload cannot wait for either IPC call, so they belong in the same
    // close barrier as the editor and transcript.
    await languageStudy.flush()
    await pdf.flush()
  } finally { clearInterval(alive); api.flushed() }
})

window.addEventListener('beforeunload', () => { if (state.dirty) saveNow() })
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden) return
  if (state.dirty) await saveNow()
  await api.durability.flush()
})

// Handle for the DevTools console and the scripts/drive.mjs test harness.
window.__tulip = {
  state, editor, api, openNote, runCommand, openOverlay, showZoom,
  pdf, site, copilot, copilotContext,
  viewportLine, scrollToLine, goHistory,
  newTab, closeTab, selectTab, cycleTab, settings, toggleOutline, jumpToHeading,
  exportPdf
}

async function boot () {
  paintBootLoading()
  /* Before the first tree is drawn, and outside the try: the tree is redrawn
     from a dozen places and the listener is on the container, which outlives
     all of them. */
  wireTreeKeys()
  // Every panel that calls itself modal actually behaves like one — see
  // trapModalFocus, which reads the attribute rather than a list of panels.
  trapModalFocus()
  /* One listener for every surface that renders a note. The links are anchors
     without an href — see the wikilink rule in src/markdown.js — so nothing
     follows them on ↵ unless something says so. */
  document.addEventListener('keydown', activateFocusedWikilink)
  try {
  /* Asked together: neither needs the other, and main is at its busiest in
     exactly this moment — indexing the vault, chasing attachment moves,
     starting the file watcher. One round of waiting rather than two. (On the
     machine this was measured on the answers arrive in the same millisecond
     either way, because what the boot actually waits for is main's own
     startup; the point is that a slower main cannot make the window pay for
     it twice over.) */
  const [cfg, vault, role] = await Promise.all([
    api.config.get(),
    api.vault.current(),
    api.window.role()
  ])

  /* Which window this is, before anything that depends on it — the session's
     own window or a second one on the same vault. See `sessionOnly` for what
     hangs on it, and the account in main beside `createWindow` for why the
     difference exists at all. */
  state.primary = role.primary !== false
  if (!state.primary) el.app.dataset.window = 'secondary'

  // Every stored preference put into effect at once, so the first frame is
  // already the one the user left behind — see applySettings.
  applySettings(cfg)
  restorePanelWidths(cfg)
  restoreTexSplit(cfg)
  el.app.dataset.sidebar = cfg.sidebar || 'open'
  /* Closed unless it was left open: the copilot starts no process until the
     first message is sent, however the panel came to be showing.

     Started here and awaited below rather than awaited here. Its settings half
     is synchronous and has already run by the time this returns a promise, so
     the panel is dressed at the same moment it was before; the half that waits
     is the read of the stored conversations, which has nothing to do with the
     vault walk it now runs beside. The note opened further down still finds its
     own conversation in hand, because the barrier is above it. */
  const restoringCopilot = state.primary ? copilot.restoreAtBoot(cfg) : Promise.resolve()
  // Nothing to toggle where there is no copilot; the palette entry and the
  // menu command are turned away in the same breath, where each is handled.
  el.aiToggle.hidden = !state.primary
  state.expanded = new Set(cfg.expanded || [])

  /* No vault: nothing below this line has a folder to run against, so the
     landing page takes the window and boot stops here. The app behind it is
     still assembled and still un-hidden — connecting a vault has to leave a
     working window behind, and `vault:opened` fills it in from here. */
  if (!vault) {
    el.vaultLabel.textContent = 'No vault'
    paintLanding()
    await restoringCopilot
    paintBootReady()
    return
  }

  state.vault = vault
  el.vaultLabel.textContent = vault.name
  paintLanding()
  await Promise.all([loadTree(), restoringCopilot])

  /* The strip comes back as it was left, minus any note that has since gone
     away — and each tab at the line it was left showing, which is what
     `tabPlaces` carries beside the paths. Each is seeded with a one-entry
     history so back and forward have somewhere to stand. */
  const known = new Set(state.files.map((f) => f.path))
  /* A second window starts with what it was opened for and nothing else. The
     strip in the config is the session's, and it belongs to the window that is
     already showing it — restoring it here would put a copy of every open note
     in front of somebody who asked for one, and two windows editing the same
     buffer is a merge nobody asked for either. */
  const session = state.primary ? cfg : { tabs: role.open ? [role.open] : [], tabIndex: 0 }
  const places = Array.isArray(session.tabPlaces) ? session.tabPlaces : []
  const pins = Array.isArray(session.tabPinned) ? session.tabPinned : []
  /* Paired with its path before the filter, not read back by position after
     it: a note deleted since the last session takes its own place out of the
     list, and every place after it would otherwise shift onto a tab it was
     never about. The same goes for which of them were pinned — a shifted pin
     holds open a note nobody asked to keep, and lets go of the one they did. */
  const stored = (Array.isArray(session.tabs) ? session.tabs : [])
    .map((path, at) => ({ path, line: Number(places[at]) || 1, pinned: !!pins[at] }))
    .filter(({ path }) => path === null || known.has(path))

  state.tabs = stored.map(({ path, line, pinned }) => ({
    path,
    history: path ? [{ path, at: 0, top: 0, line }] : [],
    historyAt: path ? 0 : -1,
    base: null,
    /* A blank tab is never pinned, whatever the file says: there is nothing in
       it to hold open, and one at the front of the strip would sit where the
       kept documents are meant to be. */
    pinned: pinned && !!path
  }))

  if (!state.tabs.length) {
    // Nothing stored: the note last open stands as the single tab, which is
    // what every earlier version of Tulip did.
    /* And in a second window, nothing at all: `lastNote` is the session's too,
       and a window opened from the Window menu opens on a blank tab. */
    const last = state.primary && cfg.lastNote && known.has(cfg.lastNote) ? cfg.lastNote : null
    state.tabs = [last
      ? { path: last, history: [{ path: last, at: 0, top: 0, line: 1 }], historyAt: 0, base: null, pinned: false }
      : blankTab()]
  }

  state.tabIndex = Math.min(Math.max(0, Number(session.tabIndex) || 0), state.tabs.length - 1)
  /* Only ever a settled strip is written out, so this normally moves nothing.
     It is here for the config that was edited by hand or written by a version
     that did not know about pins, where the alternative is a strip that breaks
     the invariant for the rest of the session. Settled AFTER the index is read,
     and the index re-found by identity, so a reordering cannot open a different
     note than the one the window was left showing. */
  const showing = state.tabs[state.tabIndex]
  state.tabs = settled(state.tabs)
  state.tabIndex = Math.max(0, state.tabs.indexOf(showing))
  renderTabs()

  const opening = state.tabs[state.tabIndex].path

  /* Establish the saved view before opening the note. Opening used to render
     the default Reading view first and then set the saved view, which rendered
     Reading twice on a normal launch and rendered it needlessly before an
     Editing or Raw launch. setView also paints the view control when no note is
     open, so no second call is needed after the document arrives.

     The view decides whether this launch pays for CodeMirror before it can show
     anything. Reading does not need an editor, so the note is drawn and the
     window revealed first and the editing stack fetched afterwards — see
     ensureEditor. A launch straight into Editing or Raw has no such choice and
     waits, which is the right way round: it is the view that was asked for. */
  const bootView = cfg.view || 'read'
  setView(bootView)
  if (bootView !== 'read') await ensureEditor()

  if (opening) {
    // At the line it was left showing, the same way selecting a tab reopens it.
    await openNote(opening, {
      focus: false,
      history: false,
      place: tabPlace(state.tabs[state.tabIndex])
    })
    revealInTree(opening)
  }

  /* The side pane comes back too — the reference being read is as much a part
     of how the window was left as the tabs are. */
  if (state.primary && cfg.sideDoc && known.has(cfg.sideDoc)) {
    openToSide(cfg.sideDoc, { persist: false })
  }

  paintBootReady()

  /* The window is up and the note is readable. Now fetch the editing stack, so
     that switching view — or typing — does not wait on a download. Deliberately
     after the paint and off the critical path: awaited here it would simply be
     the eager import again, wearing a different spelling. */
  requestIdleCallback(() => { ensureEditor().catch(() => {}) }, { timeout: 500 })

  // Last, and only if the previous session ended badly: see below. The app is
  // visible before this can ask its recovery question.
  await offerDraftRecovery()
  } catch (error) {
    console.error('Tulip boot failed', error)
    paintBootError(error)
  }
}

boot()

/**
 * Edits from a session that ended before they could be saved.
 *
 * Every draft still on disk at launch is one whose note was never written —
 * the ordinary path deletes each as soon as its save lands, so an empty folder
 * is what a clean shutdown leaves behind. Main has already dropped the ones
 * that match their file, so anything reaching here is a real difference
 * between what was typed and what survived.
 *
 * Asked rather than applied. The text is by definition unreviewed — it is
 * whatever the editor happened to be holding — and the note on disk may have
 * moved on since through a sync or the copilot. Declining keeps the file as it
 * is and drops the draft, so the question is asked once and not at every
 * launch thereafter.
 */
async function offerDraftRecovery () {
  const drafts = await api.draft.list().catch(() => [])
  if (!drafts.length) return

  for (const draft of drafts) {
    const name = docLabel(draft.path)
    const restore = await ask({
      title: `Restore unsaved edits to “${name}”?`,
      detail: draft.disk === null
        ? 'Tulip closed before these edits were saved, and the note is no longer in the vault. Restoring writes it back.'
        : 'Tulip closed before these edits were saved. The copy on disk is older than what was on screen.',
      go: 'Restore'
    })
    if (restore) {
      try {
        await api.file.write(draft.path, draft.text)
        toast(`Restored unsaved edits to “${name}”`)
      } catch (err) {
        toast(err.message || `“${name}” could not be restored.`)
        // Kept, so the next launch can try again rather than losing the text
        // to a failure that may be temporary.
        continue
      }
    }
    await api.draft.clear(draft.path).catch(() => {})
  }

  await loadTree()
  await reloadCurrent()
}
