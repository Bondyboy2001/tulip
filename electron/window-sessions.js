'use strict'
const { randomUUID } = require('node:crypto')

const WINDOW_KEYS = new Set(['tabs', 'tabPlaces', 'tabHistories', 'tabPinned', 'tabIndex', 'lastNote', 'view', 'sideDoc', 'sideScroll', 'sideWidth', 'sidebar', 'paneBelow', 'paneBelowHeight', 'paneBelowHeights', 'railWidth', 'chatWidth', 'ai', 'expanded', 'texSourceRatio'])

// Preferences remain shared; document state and geometry belong to a window.
function makeWindowSessions ({ readConfig, writeConfig, getVault }) {
  const records = new Map()
  const current = () => [...records.values()].map((record) => ({ ...record, state: { ...record.state } }))
  const persist = () => writeConfig({ windowSessions: { ...readConfig().windowSessions, [getVault() || '']: current() } })
  return {
    saved: () => readConfig().windowSessions?.[getVault() || ''] || [],
    add (win, saved, first) {
      const config = readConfig()
      const state = saved?.state || (first ? Object.fromEntries([...WINDOW_KEYS].filter((key) => key in config).map((key) => [key, config[key]])) : { tabs: [], tabIndex: 0 })
      const record = { id: saved?.id || (first ? 'main' : randomUUID()), state, bounds: saved?.bounds || null }
      records.set(win.webContents.id, record)
      persist()
      return record
    },
    id: (sender) => records.get(sender)?.id || 'main',
    config (sender) { return { ...readConfig(), ...records.get(sender)?.state } },
    patch (sender, patch) {
      const record = records.get(sender)
      if (!record) return patch
      const shared = { ...patch }
      for (const key of WINDOW_KEYS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          record.state[key] = patch[key]
          delete shared[key]
        }
      }
      persist()
      return shared
    },
    bounds (win) {
      const record = records.get(win.webContents.id)
      if (!record || win.isMinimized() || win.isFullScreen()) return
      record.bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() }
      persist()
    },
    remove (sender, quitting) {
      if (quitting) return
      const last = records.size === 1
      records.delete(sender)
      if (!quitting && !last) persist()
    },
    switchVault () {
      for (const record of records.values()) record.state = { tabs: [], tabIndex: 0 }
      persist()
    },
    saveNamed (name) {
      name = String(name || '').trim().slice(0, 80)
      if (!name) return false
      const vault = getVault() || ''
      const all = readConfig().namedWorkspaces || {}
      const named = { ...all[vault], [name]: current() }
      writeConfig({ namedWorkspaces: { ...all, [vault]: named } })
      return true
    },
    named: () => readConfig().namedWorkspaces?.[getVault() || ''] || {},
    current
  }
}
module.exports = { makeWindowSessions }
