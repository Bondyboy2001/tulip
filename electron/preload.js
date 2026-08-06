'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * The renderer's entire view of the outside world. Everything is a named,
 * argument-checked call — no generic `invoke` escape hatch, so the main process
 * stays the only thing that can touch the filesystem.
 */
contextBridge.exposeInMainWorld('tulip', {
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
    create: (dir, name) => ipcRenderer.invoke('file:create', dir, name),
    rename: (p, name) => ipcRenderer.invoke('file:rename', p, name),
    remove: (p) => ipcRenderer.invoke('file:delete', p),
    move: (p, destDir) => ipcRenderer.invoke('file:move', p, destDir),
    reveal: (p) => ipcRenderer.invoke('file:reveal', p),
    import: (destDir, sources) => ipcRenderer.invoke('file:import', destDir, sources)
  },
  fileTags: {
    get: (p) => ipcRenderer.invoke('file-tags:get', p),
    set: (p, tags) => ipcRenderer.invoke('file-tags:set', p, tags)
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

  /**
   * Executing a fenced block. The renderer sends the language and the code and
   * gets an id back; the process itself, and every decision about what may be
   * run, stays on the other side of this bridge.
   */
  run: {
    start: (lang, code) => ipcRenderer.invoke('run:start', lang, code),
    warm: (lang) => ipcRenderer.invoke('run:warm', lang),
    kill: (id) => ipcRenderer.invoke('run:kill', id)
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
    start: (opts) => ipcRenderer.invoke('ai:start', opts),
    /* `{ fresh: true }` asks the CLIs again rather than taking the answer main
       is holding — what the Refresh button in Settings is for, after installing
       a model or signing into a provider mid-session. */
    models: (opts) => ipcRenderer.invoke('ai:models', opts),
    doctor: () => ipcRenderer.invoke('ai:doctor'),
    send: (text, context, turnId) => ipcRenderer.invoke('ai:send', text, context, turnId),
    stop: (turnId) => ipcRenderer.invoke('ai:stop', turnId),
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

  /* Is there a newer Tulip? Asked only when somebody asks — see the account
     beside the handler in main. There is no updater behind this and nothing
     that installs anything; the answer is a version number and a link. */
  checkForUpdate: () => ipcRenderer.invoke('app:update-check'),

  /* An exception nobody caught, on its way to main's crash log — the renderer
     has no log of its own, and a DevTools console nobody has open is not a
     place where failures get noticed. Sent rather than invoked: the caller is
     an error handler, and it must not be given a promise it could reject. */
  reportError: (kind, detail) => ipcRenderer.send('app:error', String(kind), String(detail)),

  on: (channel, fn) => {
    const allowed = [
      'vault:changed', 'vault:opened', 'menu', 'zoom',
      'run:out', 'run:done', 'ai:event', 'app:flush',
      // A word was taught or untaught — the open note's spelling is one word
      // out of date, wherever the asking happened.
      'dictionary:changed'
    ]
    if (!allowed.includes(channel)) return () => {}
    const listener = (_e, payload) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
