'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * The renderer's entire view of the outside world. Everything is a named,
 * argument-checked call — no generic `invoke` escape hatch, so the main process
 * stays the only thing that can touch the filesystem.
 */
contextBridge.exposeInMainWorld('tulip', {
  /* Which desktop this is. The page has no `process` of its own and had no way
     to ask, so every shortcut it printed was a ⌘ chord and every "reveal"
     button said Finder — on Windows, instructions to press keys that are not
     there. A string rather than an `isMac` flag: the page should be able to
     tell the third platform apart from the two it knows. */
  platform: process.platform,
  vault: {
    pick: () => ipcRenderer.invoke('vault:pick'),
    current: () => ipcRenderer.invoke('vault:current'),
    // `known` is the revision the caller already drew; passing it lets main
    // answer "still that one" instead of sending the whole tree back.
    snapshot: (known) => ipcRenderer.invoke('vault:snapshot', known),
    notes: () => ipcRenderer.invoke('vault:notes'),
    /* The vaults connected before this one, so switching between two of them
       is a pick from a list rather than a walk through a file dialog. Main
       keeps the list and will only open something already on it — choosing a
       vault it has never seen is `pick`, which is a native dialog. */
    recent: () => ipcRenderer.invoke('vault:recent'),
    open: (dir) => ipcRenderer.invoke('vault:open', dir),
    // The other names notes answer to, for resolving `[[Alias]]`.
    aliases: () => ipcRenderer.invoke('vault:aliases')
  },
  file: {
    read: (p) => ipcRenderer.invoke('file:read', p),
    // Size and dates, for the Info pane.
    info: (p) => ipcRenderer.invoke('file:info', p),
    write: (p, content, metadata) => ipcRenderer.invoke('file:write', p, content, metadata),
    /* Keep what is on disk before the buffer overwrites it. Called on the one
       path where the two cannot be reconciled — see `file:conflict-copy`. */
    conflictCopy: (p) => ipcRenderer.invoke('file:conflict-copy', p),
    create: (dir, name) => ipcRenderer.invoke('file:create', dir, name),
    rename: (p, name) => ipcRenderer.invoke('file:rename', p, name),
    remove: (p) => ipcRenderer.invoke('file:delete', p),
    move: (p, destDir) => ipcRenderer.invoke('file:move', p, destDir),
    reveal: (p) => ipcRenderer.invoke('file:reveal', p),
    // Is it text, and how big? Asked of the files the vault has no view of its
    // own for, because the extension is a claim and the bytes are the fact.
    probe: (p) => ipcRenderer.invoke('file:probe', p),
    // Handed to whatever the desktop opens it with.
    openDefault: (p) => ipcRenderer.invoke('file:open-default', p),
    import: (destDir, sources) => ipcRenderer.invoke('file:import', destDir, sources)
  },
  /* A Word document, read into blocks. One call: the main process owns the
     zip, the XML and the pictures inside it, and the renderer is handed a
     document — see electron/docx.js. */
  docx: {
    read: (p) => ipcRenderer.invoke('docx:read', p),
    /* The paragraphs that changed, and where the rest of the file still is.
       Answers with the document as it now reads — a save moves every offset in
       it, so the page is drawn again from what actually landed. */
    write: (p, edit) => ipcRenderer.invoke('docx:write', p, edit)
  },
  fileTags: {
    get: (p) => ipcRenderer.invoke('file-tags:get', p),
    set: (p, tags) => ipcRenderer.invoke('file-tags:set', p, tags)
  },
  /* The emoji a reader hung on a row of the file tree. Read as one map — the
     tree draws every row it has — and written one row at a time. */
  fileMarks: {
    all: () => ipcRenderer.invoke('file-marks:all'),
    set: (p, mark) => ipcRenderer.invoke('file-marks:set', p, mark)
  },
  /* How wide a table's columns were left. A `.csv` has nowhere inside it to
     record that, so it is filed against the path instead — see csv.js. */
  tableWidths: {
    get: (p) => ipcRenderer.invoke('table-widths:get', p),
    set: (p, widths) => ipcRenderer.invoke('table-widths:set', p, widths)
  },
  /**
   * The on-disk path of a dragged-in File. Electron stopped putting `.path` on
   * File objects, and the renderer has no other way to name something the OS
   * handed it — this is the one bridge from a drag to a real filesystem path.
   */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
  folder: {
    create: (dir, name) => ipcRenderer.invoke('folder:create', dir, name)
  },
  /* A website file is created empty and told where to point afterwards, from
     the address bar of the tab it opens into — so there is nothing to create
     it *with*. Its own call rather than an extension passed to `file.create`,
     which would make every extension in the vault the renderer's to choose. */
  site: {
    create: (dir) => ipcRenderer.invoke('site:create', dir)
  },
  whiteboard: {
    create: (dir) => ipcRenderer.invoke('whiteboard:create', dir),
    export: (name, ext, bytes, to) =>
      ipcRenderer.invoke('whiteboard:export', name, ext, bytes, to)
  },
  /* A focused table document with editable generic headers. */
  table: {
    create: (dir, name) => ipcRenderer.invoke('table:create', dir, name)
  },

  /* A source or data file. The extension goes over separately rather than on
     the end of the name: main checks it against the vault contract's lists,
     and a name and an extension that have already been joined cannot be
     checked without being taken apart again. */
  source: {
    create: (dir, name, ext) => ipcRenderer.invoke('source:create', dir, name, ext)
  },
  language: {
    create: (dir, name) => ipcRenderer.invoke('language:create', dir, name),
    /* Every vocabulary table in the vault, text and all — what a review of
       everything due is built from, rather than of whatever note is open. */
    decks: () => ipcRenderer.invoke('language:decks')
  },
  languageHistory: {
    rows: (path) => ipcRenderer.invoke('language-history:rows', path)
  },
  asset: {
    // `bytes` is a Uint8Array; the structured clone carries it across intact.
    // Main decides the filename and folder — see the handler.
    write: (noteName, ext, bytes) => ipcRenderer.invoke('asset:write', noteName, ext, bytes)
  },
  /**
   * Highlights drawn on a PDF. The whole set is written at once — the sidecar
   * is small and a partial one would be worse than none.
   */
  pdf: {
    source: (p) => ipcRenderer.invoke('pdf:source', p),
    marks: {
      load: (p) => ipcRenderer.invoke('pdf:marks:load', p),
      save: (p, highlights) => ipcRenderer.invoke('pdf:marks:save', p, highlights)
    }
  },
  tex: {
    create: (dir) => ipcRenderer.invoke('tex:create', dir),
    compile: (p) => ipcRenderer.invoke('tex:compile', p)
  },

  /* The open note as a PDF file. `to` is the scripted seam — the save dialog
     cannot be driven from a probe, so scripts hand a path and skip it. */
  exportPdf: (name, to) => ipcRenderer.invoke('pdf:export', name, to),

  /* The same page, to a printer through the system dialog. */
  printNote: () => ipcRenderer.invoke('pdf:print'),

  /* The reading view as one self-contained HTML file; the note and its
     attachments as a portable Markdown folder. `to` is the scripted seam. */
  exportHtml: (name, html, to) => ipcRenderer.invoke('note:export-html', name, html, to),
  exportMarkdown: (name, text, files, to) => ipcRenderer.invoke('note:export-markdown', name, text, files, to),

  /**
   * Executing a fenced block. The renderer sends the language and the code and
   * gets an id back; the process itself, and every decision about what may be
   * run, stays on the other side of this bridge.
   *
   * `note` is the block's note, as a vault-relative path — what a python block
   * gets its environment from, so the packages one note installs are not
   * quietly in scope for every other note in the vault. Null where a block has
   * no note behind it, which is a shared environment rather than an error.
   */
  run: {
    start: (lang, code, note) => ipcRenderer.invoke('run:start', lang, code, note ?? null),
    warm: (lang) => ipcRenderer.invoke('run:warm', lang),
    kill: (id) => ipcRenderer.invoke('run:kill', id)
  },

  /**
   * Running a notebook's cells.
   *
   * Unlike `run`, which is one program per block, these all name a notebook:
   * its cells share a kernel, so the notebook — not the cell — is the thing a
   * running process belongs to. Output arrives on `kernel:event` rather than
   * as the answer to `execute`, because a cell that prints for ten seconds
   * should be readable while it does.
   */
  kernel: {
    start: (path, wanted) => ipcRenderer.invoke('kernel:start', path, wanted),
    execute: (path, code) => ipcRenderer.invoke('kernel:execute', path, code),
    interrupt: (path) => ipcRenderer.invoke('kernel:interrupt', path),
    restart: (path) => ipcRenderer.invoke('kernel:restart', path),
    shutdown: (path) => ipcRenderer.invoke('kernel:shutdown', path),
    /* The notebook moved. A kernel is filed under its notebook's path, and one
       left under the old name is a process nothing can name again. */
    rename: (from, to) => ipcRenderer.invoke('kernel:rename', from, to),
    specs: () => ipcRenderer.invoke('kernel:specs'),
    /* The answer to an `input()`, and the two questions a cell asks about the
       code in it rather than about running it. These three are round trips
       rather than events: each has exactly one answer, and nothing is drawn
       until it lands. */
    input: (path, value) => ipcRenderer.invoke('kernel:input', path, value),
    complete: (path, code, cursorPos) =>
      ipcRenderer.invoke('kernel:complete', path, code, cursorPos),
    inspect: (path, code, cursorPos) =>
      ipcRenderer.invoke('kernel:inspect', path, code, cursorPos)
  },

  /* The Python environments a note's blocks run in — see electron/python-env.js.
     Listed for the settings panel, which is the only place they are visible;
     `prune` takes the ones whose note the vault no longer has. */
  python: {
    envs: () => ipcRenderer.invoke('python:envs'),
    removeEnv: (dir) => ipcRenderer.invoke('python:env-remove', dir),
    pruneEnvs: () => ipcRenderer.invoke('python:env-prune')
  },

  /* Manim renders to a real file in the vault rather than to the page, so it
     answers with a path. `lookup` asks whether a block has been rendered
     already without running anything. */
  manim: {
    lookup: (noteName, code, scene) => ipcRenderer.invoke('manim:lookup', noteName, code, scene),
    render: (noteName, code, scene) => ipcRenderer.invoke('manim:render', noteName, code, scene)
  },
  /* TikZ keeps its drawing in the vault for the same reason, and answers the
     same two questions: is there one already, and make me one. */
  tikz: {
    lookup: (noteName, code) => ipcRenderer.invoke('tikz:lookup', noteName, code),
    render: (noteName, code) => ipcRenderer.invoke('tikz:render', noteName, code)
  },
  /**
   * The copilot. It is a CLI subprocess with the vault as its working
   * directory, so the renderer never passes it a file — only what to do and
   * which note is open. Everything it says comes back on `ai:event`.
   */
  ai: {
    /* `opts.key` names the conversation the copilot belongs to. One process per
       chat, so a turn about one note and a turn about another run side by
       side rather than one waiting on the other. */
    start: (opts) => ipcRenderer.invoke('ai:start', opts),
    /* `{ fresh: true }` asks the CLIs again rather than taking the answer main
       is holding — what the Refresh button in Settings is for, after installing
       a model or signing into a provider mid-session. */
    models: (opts) => ipcRenderer.invoke('ai:models', opts),
    doctor: () => ipcRenderer.invoke('ai:doctor'),
    send: (key, text, context, turnId) =>
      ipcRenderer.invoke('ai:send', key, text, context, turnId),
    stop: (key, turnId) => ipcRenderer.invoke('ai:stop', key, turnId),
    /* A picture pasted into the message box, filed in the vault so the agent —
       which reads files and takes no images over its message stream — can be
       pointed at it. `bytes` is a Uint8Array; the answer is a vault path. */
    attach: (ext, bytes) => ipcRenderer.invoke('ai:attach', ext, bytes),
    /* The main process owns the native picker and copies the chosen files into
       the vault. Keeping the bytes out of the renderer also makes large PDFs
       and archives no more expensive to attach than an ordinary file copy. */
    pickAttachments: () => ipcRenderer.invoke('ai:pick-attachments'),
    /* A long turn that has ended while the window is in the background. Main
       owns this rather than the renderer raising its own `Notification`,
       because the two things worth doing with it — checking that the window
       really is unfocused, and bouncing the dock — are the main process's to
       do. */
    announce: (info) => ipcRenderer.invoke('ai:announce', info),
    /* The turn's own before-copy of one file — what the review card is diffed
       against. Asked for instead of reading the disk, because a provider can
       announce a Write after the file has already changed; by then the disk is
       the copilot's version and the baseline is the only "before" left. */
    baseline: (turnId, path) => ipcRenderer.invoke('ai:baseline', turnId, path),
    // Transcripts, per note, kept with the app's state rather than the vault.
    history: {
      load: () => ipcRenderer.invoke('ai:history:load'),
      save: (history) => ipcRenderer.invoke('ai:history:save', history)
    }
  },

  /* When each card comes back. The schedule is worked out in the renderer
     (src/srs.js); this is only where the answers are kept — in the vault, so
     they are backed up and synced with the notes they are about. */
  review: {
    all: () => ipcRenderer.invoke('review:all'),
    record: (entries) => ipcRenderer.invoke('review:record', entries),
    unrecord: (entry) => ipcRenderer.invoke('review:unrecord', entry),
    pickCsv: () => ipcRenderer.invoke('review:pick-csv'),
    prune: (knownIds) => ipcRenderer.invoke('review:prune', knownIds),
    history: () => ipcRenderer.invoke('review:history')
  },

  /* What was typed but not yet saved, kept outside the vault so a crash cannot
     take it with the window. `list` answers with only the drafts that differ
     from the note on disk — see the handler in main. */
  draft: {
    save: (path, text) => ipcRenderer.invoke('draft:save', path, text),
    clear: (path) => ipcRenderer.invoke('draft:clear', path),
    list: () => ipcRenderer.invoke('draft:list')
  },

  trust: {
    list: () => ipcRenderer.invoke('trust:list'),
    operation: (id) => ipcRenderer.invoke('trust:operation', id),
    restore: (id, path) => ipcRenderer.invoke('trust:restore', id, path)
  },

  /* `opts` is the three switches the panel carries: `{ regex, caseSensitive,
     word }`. `replace` rewrites every note the same query finds, and answers
     with the paths it wrote so the renderer can reload anything it has open. */
  search: (query, opts) => ipcRenderer.invoke('search:vault', query, opts),
  replaceAll: (query, replacement, opts) =>
    ipcRenderer.invoke('search:replace', query, replacement, opts),

  /* Every tag in the vault with its note count — the inventory behind `#`
     completion and the search overlay's tag rows. */
  tags: () => ipcRenderer.invoke('tags:vault'),

  /* Which notes point at this one, and which say its name without pointing. */
  links: {
    to: (p) => ipcRenderer.invoke('links:to', p)
  },

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch)
  },
  /* The rebindable menu commands — id, label, menu, default key — for the
     Hotkeys section of Settings. Read-only; the bindings themselves travel
     back as the `hotkeys` config record. */
  hotkeys: {
    list: () => ipcRenderer.invoke('hotkeys:list')
  },
  /* The spellchecker's custom dictionary. Adding mostly happens from the
     native context menu over a misspelling, which main owns outright; these
     are for the Settings pane, which shows the list, takes words back out of
     it, and offers a way to type one in. */
  dictionary: {
    words: () => ipcRenderer.invoke('dictionary:words'),
    add: (word) => ipcRenderer.invoke('dictionary:add', word),
    remove: (word) => ipcRenderer.invoke('dictionary:remove', word)
  },
  /* Which of these words are not words. Chromium draws the red underlines and
     will not say what it underlined, so the sidebar's Spelling pane asks main,
     which keeps a dictionary of its own — and the custom words above, so the
     two answers agree. */
  spell: {
    check: (words) => ipcRenderer.invoke('spell:check', words),
    suggest: (word) => ipcRenderer.invoke('spell:suggest', word)
  },
  durability: {
    flush: () => ipcRenderer.invoke('durability:flush')
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  /* Text onto the system clipboard. Through here rather than through
     `navigator.clipboard`, which is refused whenever the window is not focused
     — see the handler in main. */
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  /* The undo a text field keeps for itself. The note's and the PDF's are the
     renderer's own; this is only for the inputs the browser already tracks. */
  edit: {
    undo: () => ipcRenderer.invoke('edit:undo'),
    redo: () => ipcRenderer.invoke('edit:redo')
  },
  resetZoom: () => ipcRenderer.invoke('zoom:reset'),
  zoom: {
    set: (factor) => ipcRenderer.invoke('zoom:set', factor),
    /* Says who owns a pinch. A PDF zooms itself, and the window must not zoom
       underneath it at the same time — see the zoom-changed handler in main. */
    claim: (on) => ipcRenderer.invoke('zoom:claim', on)
  },
  version: () => ipcRenderer.invoke('app:version'),

  window: {
    /* Which window this is: whether it restores and remembers the session's
       tab strip, and whether it may hold the copilot. Asked once, in boot. */
    role: () => ipcRenderer.invoke('window:role'),
    /* Another window on the same vault, optionally opening a note in it. The
       path is only ever handed on to the new window, which reads it the way it
       reads anything else — see the handler in main. */
    open: (open = null) => ipcRenderer.invoke('window:new', open),

    /* A tab being carried from one window's strip to another's. The drag itself
       cannot hold this — it becomes an OS drag on the way across, and a custom
       flavour does not survive that — so main holds the claim and both strips
       ask it. See the account beside the handlers. */
    tabDragStart: (path) => ipcRenderer.send('tab:drag-start', path),
    tabDragEnd: () => ipcRenderer.send('tab:drag-end'),
    /* Null unless ANOTHER window is dragging: a reorder inside one strip must
       never look like a handoff. */
    tabDragging: () => ipcRenderer.invoke('tab:dragging'),
    /* Takes it, once. A second drop gets null. */
    tabClaim: () => ipcRenderer.invoke('tab:claim')
  },

  /* Which window is editing a document Tulip cannot merge — a Word document, a
     notebook, a whiteboard or a grid. Two buffers over one of those cannot be
     reconciled, so only one window holds one at a time; see the account beside
     the handlers in main. */
  document: {
    /** May this window edit it? `{ taken: true }` means another one is. */
    claim: (path) => ipcRenderer.invoke('document:claim', path),
    /** Given up, because it was closed or moved off. */
    release: (path) => ipcRenderer.invoke('document:release', path),
    /** Taken over. Resolves once the window that had it has saved. */
    take: (path) => ipcRenderer.invoke('document:take', path)
  },

  /* Said once, when the window is worth looking at: settings applied, tree
     drawn, the note that was open back on the page. The window is not shown
     until this arrives, so a launch is a dock bounce and then the text —
     rather than an empty frame with a splash card in it while the rest loads.
     Sent, not invoked: nothing here waits for an answer, and boot should not
     be able to stall on one. */
  painted: () => ipcRenderer.send('app:painted'),

  // The answer to `app:flush`: the renderer has written what it had to write,
  // and the window may close. See the close handler in main.
  flushed: () => ipcRenderer.invoke('app:flushed'),

  /* "Still writing." Main gives a closing window a short quiet period and no
     more; this is how a genuinely slow save — a large notebook, a long grid —
     says the page is working rather than wedged, and buys another one. */
  flushing: () => ipcRenderer.send('app:flushing'),

  /* Is there a newer Tulip? Asked only when somebody asks — see the account
     beside the handler in main. There is no updater behind this and nothing
     that installs anything; the answer is a version number and a link. */
  checkForUpdate: () => ipcRenderer.invoke('app:update-check'),

  /* An exception nobody caught, on its way to main's crash log — the renderer
     has no log of its own, and a DevTools console nobody has open is not a
     place where failures get noticed. Sent rather than invoked: the caller is
     an error handler, and it must not be given a promise it could reject. */
  reportError: (kind, detail) => ipcRenderer.send('app:error', String(kind), String(detail)),

  /* The other half of `reportError`: where the reader goes once they have been
     told there is something to read. `revealLog` answers false when there is no
     log yet, which is the ordinary state of a healthy install and worth saying
     rather than silently opening an empty folder. */
  revealLog: () => ipcRenderer.invoke('app:reveal-log'),
  diagnostics: () => ipcRenderer.invoke('app:diagnostics'),

  on: (channel, fn) => {
    const allowed = [
      'vault:changed', 'vault:opened', 'menu', 'zoom',
      'run:out', 'run:done', 'ai:event', 'app:flush', 'kernel:event',
      // A word was taught or untaught — the open note's spelling is one word
      // out of date, wherever the asking happened.
      'dictionary:changed',
      // Another window has taken a tab this one was dragging: let go of it.
      'tab:claimed',
      // Another window has taken over a document this one was editing. Its
      // edits are already on disk by the time this arrives.
      'document:yielded',
      // Nobody is editing that document any more — the window that had it
      // closed, or moved off it.
      'document:free',
      // A document this window is editing was renamed or moved; its claim
      // now answers to the new name.
      'document:relocated'
    ]
    if (!allowed.includes(channel)) return () => {}
    const listener = (_e, payload) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
