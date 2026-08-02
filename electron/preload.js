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
    snapshot: () => ipcRenderer.invoke('vault:snapshot'),
    notes: () => ipcRenderer.invoke('vault:notes')
  },
  file: {
    read: (p) => ipcRenderer.invoke('file:read', p),
    write: (p, content) => ipcRenderer.invoke('file:write', p, content),
    create: (dir, name) => ipcRenderer.invoke('file:create', dir, name),
    rename: (p, name) => ipcRenderer.invoke('file:rename', p, name),
    remove: (p) => ipcRenderer.invoke('file:delete', p),
    move: (p, destDir) => ipcRenderer.invoke('file:move', p, destDir),
    reveal: (p) => ipcRenderer.invoke('file:reveal', p),
    import: (destDir, sources) => ipcRenderer.invoke('file:import', destDir, sources)
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
  language: {
    create: (dir, name) => ipcRenderer.invoke('language:create', dir, name)
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

  /**
   * Executing a fenced block. The renderer sends the language and the code and
   * gets an id back; the process itself, and every decision about what may be
   * run, stays on the other side of this bridge.
   */
  run: {
    start: (lang, code) => ipcRenderer.invoke('run:start', lang, code),
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
    models: () => ipcRenderer.invoke('ai:models'),
    send: (text, context) => ipcRenderer.invoke('ai:send', text, context),
    stop: () => ipcRenderer.invoke('ai:stop'),
    // Transcripts, per note, kept with the app's state rather than the vault.
    history: {
      load: () => ipcRenderer.invoke('ai:history:load'),
      save: (history) => ipcRenderer.invoke('ai:history:save', history)
    }
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

  /* Which notes point at this one, and which say its name without pointing. */
  links: {
    to: (p) => ipcRenderer.invoke('links:to', p)
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch)
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
  systemTheme: () => ipcRenderer.invoke('theme:system'),

  // The answer to `app:flush`: the renderer has written what it had to write,
  // and the window may close. See the close handler in main.
  flushed: () => ipcRenderer.invoke('app:flushed'),

  on: (channel, fn) => {
    const allowed = [
      'vault:changed', 'vault:opened', 'menu', 'theme:system', 'zoom',
      'run:out', 'run:done', 'ai:event', 'app:flush'
    ]
    if (!allowed.includes(channel)) return () => {}
    const listener = (_e, payload) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
