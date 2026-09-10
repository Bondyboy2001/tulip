'use strict'

const { app, ipcMain, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { randomUUID } = require('node:crypto')

// Drafts belong to a window and a launch, so two editors never replace each
// other's crash copy. All mutations in a vault share a queue, including clear.
function makeDraftDomain ({ getVaultPath, sha1, writeAtomic, safePath, realSafePath, realSafeTargetPath, changed }) {
  const launch = randomUUID()
  const queues = new Map()
  const owners = new Map()
  const directory = () => path.join(app.getPath('userData'), 'drafts', sha1(getVaultPath() || ''))
  const ownId = (event, rel) => `${sha1(rel)}-${sha1(`${launch}:${event.sender.id}`)}.json`
  function serial (dir, work) {
    const next = (queues.get(dir) || Promise.resolve()).catch(() => {}).then(work)
    queues.set(dir, next)
    return next.finally(() => { if (queues.get(dir) === next) queues.delete(dir) })
  }
  function notify () {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('recovery:changed')
  }
  function draftPath (dir, id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]+\.json$/.test(id)) throw new Error('Invalid recovery item.')
    return path.join(dir, id)
  }
  async function events (dir) {
    try { return JSON.parse(await fs.readFile(path.join(dir, 'recovery.json'), 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
  async function writeEvents (dir, items) {
    await fs.mkdir(dir, { recursive: true })
    await writeAtomic(path.join(dir, 'recovery.json'), JSON.stringify(items))
    notify()
  }
  function register () {
    ipcMain.handle('draft:save', (event, rel, text) => {
      if (!getVaultPath() || typeof rel !== 'string' || typeof text !== 'string') return { ok: false }
      safePath(rel)
      const dir = directory()
      const id = ownId(event, rel)
      owners.set(id, event.sender.id)
      return serial(dir, async () => {
        try {
          await fs.mkdir(dir, { recursive: true })
          await writeAtomic(draftPath(dir, id), JSON.stringify({ path: rel, text, at: Date.now() }), { durable: false })
          return { ok: true }
        } catch (error) {
          console.error('draft write failed', error)
          return { ok: false }
        }
      })
    })
    ipcMain.handle('draft:clear', (event, rel, id = null) => {
      if (!getVaultPath() || typeof rel !== 'string') return { ok: false }
      const dir = directory()
      const target = draftPath(dir, id || ownId(event, rel))
      return serial(dir, async () => {
        if (id) {
          const draft = JSON.parse(await fs.readFile(target, 'utf8'))
          if (draft.path !== rel) throw new Error('Recovery item changed.')
        }
        await fs.unlink(target).catch((error) => { if (error.code !== 'ENOENT') throw error })
        owners.delete(id || ownId(event, rel))
        if (id) notify()
        return { ok: true }
      })
    })
    ipcMain.handle('draft:list', (_event, recoveryOnly = false) => {
      if (!getVaultPath()) return []
      const dir = directory()
      return serial(dir, async () => {
        const live = new Set(BrowserWindow.getAllWindows().map((win) => win.webContents.id))
        const names = await fs.readdir(dir).catch(() => [])
        const out = []
        for (const id of names) {
          if (!/^[a-f0-9-]+\.json$/.test(id)) continue
          if (recoveryOnly && live.has(owners.get(id))) continue
          const file = draftPath(dir, id)
          let draft
          try { draft = JSON.parse(await fs.readFile(file, 'utf8')) } catch { continue }
          if (typeof draft?.path !== 'string' || typeof draft?.text !== 'string') continue
          let disk = /** @type {string | null} */ (null)
          try { disk = await fs.readFile(await realSafePath(draft.path), 'utf8') } catch { /* missing or inaccessible */ }
          if (disk === draft.text) { await fs.unlink(file); owners.delete(id); continue }
          out.push({ ...draft, id, disk })
        }
        return out
      })
    })
    ipcMain.handle('draft:restore', (_event, id) => {
      const dir = directory()
      const vault = getVaultPath()
      return serial(dir, async () => {
        if (!vault || getVaultPath() !== vault) throw new Error('The vault changed. Reopen recovery.')
        const draft = JSON.parse(await fs.readFile(draftPath(dir, id), 'utf8'))
        if (typeof draft.text !== 'string') throw new Error('Invalid draft.')
        const ext = path.extname(draft.path)
        const name = path.basename(draft.path, ext)
        // A separate, exclusively created file preserves both versions, even if
        // an external editor changes the original while this dialog is open.
        const relative = path.join(path.dirname(draft.path), `${name} (recovered ${randomUUID().slice(0, 8)})${ext}`)
        const target = await realSafeTargetPath(relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        const handle = await fs.open(target, 'wx')
        let complete = false
        try { await handle.writeFile(draft.text, 'utf8'); await handle.sync(); complete = true } finally {
          await handle.close()
          if (!complete) await fs.unlink(target).catch(() => {})
        }
        await fs.unlink(draftPath(dir, id))
        owners.delete(id)
        changed()
        notify()
        return { path: relative.replaceAll(path.sep, '/') }
      })
    })
    ipcMain.handle('recovery:list', () => {
      const dir = directory()
      return serial(dir, () => events(dir))
    })
    ipcMain.handle('recovery:record', (_event, item) => {
      if (!getVaultPath() || !['save', 'conflict'].includes(item?.kind) || typeof item.path !== 'string') throw new Error('Invalid recovery item.')
      safePath(item.path)
      if (item.copy) safePath(item.copy)
      const dir = directory()
      return serial(dir, async () => {
        const list = await events(dir)
        const id = `${item.kind}:${item.path}`
        const next = { id, kind: item.kind, path: item.path, copy: item.copy || null, at: Date.now() }
        const index = list.findIndex((entry) => entry.id === id)
        if (index < 0) list.push(next)
        else list[index] = next
        await writeEvents(dir, list)
      })
    })
    ipcMain.handle('recovery:dismiss', (_event, id) => {
      const dir = directory()
      return serial(dir, async () => {
        const list = await events(dir)
        if (list.some((item) => item.id === id)) await writeEvents(dir, list.filter((item) => item.id !== id))
      })
    })
  }
  return { register }
}
module.exports = { makeDraftDomain }
