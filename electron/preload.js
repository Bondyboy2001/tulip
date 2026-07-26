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
    tree: () => ipcRenderer.invoke('vault:tree'),
    assets: () => ipcRenderer.invoke('vault:assets')
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
  asset: {
    // `bytes` is a Uint8Array; the structured clone carries it across intact.
    // Main decides the filename and folder — see the handler.
    write: (noteName, ext, bytes) => ipcRenderer.invoke('asset:write', noteName, ext, bytes)
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
  search: (query) => ipcRenderer.invoke('search:vault', query),
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch)
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  resetZoom: () => ipcRenderer.invoke('zoom:reset'),
  systemTheme: () => ipcRenderer.invoke('theme:system'),

  on: (channel, fn) => {
    const allowed = [
      'vault:changed', 'vault:opened', 'menu', 'theme:system', 'zoom',
      'run:out', 'run:done'
    ]
    if (!allowed.includes(channel)) return () => {}
    const listener = (_e, payload) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
