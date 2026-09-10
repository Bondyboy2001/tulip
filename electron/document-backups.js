'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

// Only backup folders already recorded for this vault can be inspected. File
// contents are checked when requested, rather than hashing a vault to open UI.
function documentBackups ({ settings, getVault, realSafeTargetPath }) {
  const copies = () => {
    const plan = settings()
    return [...new Map([...(plan.lastPath ? [{ path: plan.lastPath, at: plan.lastSuccess }] : []), ...(plan.copies || [])].map(copy => [copy.path, copy])).values()]
  }
  function relative (value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid document path.')
    return value
  }
  async function entry (id, rel) {
    relative(rel)
    if (!copies().some(copy => copy.path === id)) throw new Error('This backup is no longer recorded for the vault.')
    const root = await fs.realpath(id)
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'tulip-backup.json'), 'utf8'))
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid backup manifest.')
    const file = manifest.files.find(file => file.path === rel)
    if (!file) return null
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error('Invalid backup entry.')
    const target = await fs.realpath(path.join(root, rel))
    const within = path.relative(root, target)
    if (within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within)) throw new Error('The backup file points outside its folder.')
    return { file, target }
  }
  async function bytes (id, rel) {
    const found = await entry(id, rel)
    if (!found) throw new Error('This document is not in that backup.')
    // Preview and single-document recovery stay bounded; larger documents can
    // still be recovered through the streaming whole-vault restore.
    if (found.file.size > 32 * 1024 * 1024) throw new Error('Use Restore vault for documents larger than 32 MB.')
    const data = await fs.readFile(found.target)
    if (data.length !== found.file.size || crypto.createHash('sha256').update(data).digest('hex') !== found.file.sha256.toLowerCase()) throw new Error('This backup file failed its integrity check.')
    return data
  }
  return {
    async list (_event, rel) {
      relative(rel)
      return Promise.all(copies().map(async copy => {
        try { return { id: copy.path, at: copy.at, available: Boolean(await entry(copy.path, rel)) } }
        catch (error) { return { id: copy.path, at: copy.at, available: false, error: error.message } }
      }))
    },
    async preview (_event, id, rel) {
      const data = await bytes(id, rel)
      try { return new TextDecoder('utf-8', { fatal: true }).decode(data) }
      catch { throw new Error('Text comparison is unavailable for this encoding. Restore a separate copy to inspect it.') }
    },
    async restore (_event, id, rel) {
      const vault = getVault()
      const data = await bytes(id, rel)
      const ext = path.extname(rel)
      const name = path.basename(rel, ext)
      const recovered = path.posix.join(path.posix.dirname(rel), `${name} (backup ${crypto.randomUUID().slice(0, 8)})${ext}`)
      const target = await realSafeTargetPath(recovered)
      if (!vault || getVault() !== vault) throw new Error('The vault changed. Reopen recovery.')
      await fs.mkdir(path.dirname(target), { recursive: true })
      const handle = await fs.open(target, 'wx')
      let complete = false
      try { await handle.writeFile(data); await handle.sync(); complete = true }
      finally { await handle.close(); if (!complete) await fs.unlink(target).catch(() => {}) }
      return { path: recovered }
    }
  }
}
module.exports = { documentBackups }
