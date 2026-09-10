'use strict'
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { BACKUP_EXTENSION, backupVault, restoreVault } = require('./vault-backup')

// A destination belongs to one vault. Scheduling never changes the source
// mid-copy, and retention only removes backups recorded by this scheduler.
function makeBackupDomain ({ app, dialog, shell, windowOf, getVault, flushAllWindows, openVault, readConfig, writeConfig, realSafeTargetPath }) {
  let running = false
  const key = () => crypto.createHash('sha256').update(getVault() || '').digest('hex')
  const settings = () => readConfig().backupPlans?.[key()] || {}
  const save = (patch, id = key()) => writeConfig({ backupPlans: { ...readConfig().backupPlans, [id]: { ...readConfig().backupPlans?.[id], ...patch } } })
  const recordSuccess = (target) => save({ lastSuccess: Date.now(), lastPath: target, error: '' })
async function backupCurrentVault (event) {
  if (!getVault()) return { ok: false, error: 'Open a vault before backing it up.' }
  const flushed = await flushAllWindows()
  if (flushed.some((result) => result?.failed)) {
    return { ok: false, error: 'The vault could not be saved before the backup.' }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const suggested = `${path.basename(getVault())}-${stamp}${BACKUP_EXTENSION}`
  const picked = await dialog.showSaveDialog(/** @type {any} */ (windowOf(event)), {
    title: 'Back up vault',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [{ name: 'Tulip backup folder', extensions: [BACKUP_EXTENSION.slice(1)] }]
  })
  if (picked.canceled || !picked.filePath) return { canceled: true }

  const target = picked.filePath.toLowerCase().endsWith(BACKUP_EXTENSION)
    ? picked.filePath
    : `${picked.filePath}${BACKUP_EXTENSION}`
  try {
    const manifest = await backupVault(getVault(), target)
    recordSuccess(target)
    return { ok: true, path: target, files: manifest.files.length }
  } catch (error) {
    return { ok: false, error: error?.message || 'The vault backup could not be created.' }
  }
}

async function restoreBackup (event) {
  const flushed = await flushAllWindows()
  if (flushed.some((result) => result?.failed)) {
    return { ok: false, error: 'The vault could not be saved before restoring.' }
  }

  const picked = await dialog.showOpenDialog(/** @type {any} */ (windowOf(event)), {
    title: 'Choose a Tulip backup folder',
    properties: ['openDirectory']
  })
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
  const source = picked.filePaths[0]

  let manifest
  try {
    const { verifyBackup } = require('./vault-backup')
    manifest = await verifyBackup(source)
  } catch (error) {
    return { ok: false, error: error?.message || 'That folder is not a valid Tulip backup.' }
  }

  const destination = await dialog.showOpenDialog(/** @type {any} */ (windowOf(event)), {
    title: 'Choose where to restore the vault',
    properties: ['openDirectory', 'createDirectory']
  })
  if (destination.canceled || !destination.filePaths[0]) return { canceled: true }

  const parent = destination.filePaths[0]
  const name = path.basename(String(manifest.sourceName || 'Vault')) || 'Vault'
  let target = path.join(parent, `${name} Restored`)
  for (let number = 2; fsSync.existsSync(target); number++) {
    target = path.join(parent, `${name} Restored ${number}`)
  }

  try {
    await restoreVault(source, target)
    await openVault(target)
    return { ok: true, path: target, files: manifest.files.length }
  } catch (error) {
    return { ok: false, error: error?.message || 'The backup could not be restored.' }
  }
}




  async function runScheduled (force = false) {
    const source = getVault()
    const id = key()
    const plan = settings()
    if (running || !source || !plan.destination || (!force && !plan.intervalDays)) return
    if (!force && Date.now() - (plan.lastAttempt || 0) < 15 * 60_000) return
    if (!force && Date.now() - (plan.lastSuccess || 0) < plan.intervalDays * 86400_000) return
    running = true
    save({ lastAttempt: Date.now() }, id)
    try {
      const flushed = await flushAllWindows()
      if (flushed.some((result) => result?.failed) || source !== getVault()) throw new Error('The vault could not be saved before backup.')
      const parent = await fs.realpath(plan.destination)
      const root = await fs.realpath(source)
      const relative = path.relative(root, parent)
      if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Choose a backup folder outside the vault.')
      const target = path.join(parent, `Tulip-${id.slice(0, 12)}-${Date.now()}${BACKUP_EXTENSION}`)
      await backupVault(root, target)
      const previous = Array.isArray(plan.copies) ? plan.copies : []
      const copies = [{ path: target, at: Date.now() }, ...previous]
      const keep = Math.max(1, Math.min(30, Number(plan.keep) || 7))
      const retained = copies.slice(0, keep)
      for (const old of copies.slice(keep)) {
        // Never follow symlinks or delete a folder the scheduler did not name.
        if (path.dirname(old.path) !== parent || !path.basename(old.path).startsWith(`Tulip-${id.slice(0, 12)}-`)) { retained.push(old); continue }
        try {
          if ((await fs.lstat(old.path)).isSymbolicLink()) { retained.push(old); continue }
          await fs.rm(old.path, { recursive: true })
        } catch { retained.push(old) }
      }
      save({ copies: retained, lastSuccess: Date.now(), lastPath: target, error: '' }, id)
    } catch (error) {
      save({ error: error.message || 'Backup failed.' }, id)
    } finally { running = false }
  }

  async function manage (event) {
    if (!getVault()) return { ok: false, error: 'Open a vault first.' }
    const win = windowOf(event)
    const plan = settings()
    const answer = await dialog.showMessageBox(win, {
      title: 'Backups and recovery', message: 'Protect this vault',
      detail: `${plan.lastSuccess ? 'Last successful backup: ' + new Date(plan.lastSuccess).toLocaleString() : 'No completed backup recorded for this vault.'}\n${plan.intervalDays ? 'Automatic backup every ' + plan.intervalDays + ' day(s), while Tulip is open.' : 'Automatic backups are off.'}\n${plan.destination || 'Choose a destination to enable automatic backups.'}\nKeeping ${plan.keep || 7} automatic backups.\n${running ? 'A backup is running.' : plan.error ? 'Last attempt failed: ' + plan.error : ''}`,
      buttons: ['Back up now', 'Configure…', 'Browse backups', 'Restore…', 'Done'], cancelId: 4, defaultId: 4
    })
    if (answer.response === 0) {
      if (plan.destination) await runScheduled(true)
      else await backupCurrentVault(event)
      return manage(event)
    }
    if (answer.response === 1) {
      const frequency = await dialog.showMessageBox(win, { title: 'Automatic backups', message: 'How often should Tulip back up this vault?', buttons: ['Daily', 'Weekly', 'Turn off', 'Cancel'], cancelId: 3 })
      if (frequency.response === 2) save({ intervalDays: 0 })
      else if (frequency.response < 2) {
        const picked = await dialog.showOpenDialog(win, { title: 'Choose a backup destination outside the vault', properties: ['openDirectory', 'createDirectory'] })
        if (!picked.canceled && picked.filePaths[0]) {
          const destination = await fs.realpath(picked.filePaths[0])
          const root = await fs.realpath(getVault())
          const relative = path.relative(root, destination)
          if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
            await dialog.showMessageBox(win, { message: 'Choose a folder outside this vault.', buttons: ['OK'] })
          } else {
            const retention = await dialog.showMessageBox(win, { title: 'Backup retention', message: 'How many automatic backups should Tulip keep?', buttons: ['7 backups', '14 backups', '30 backups', 'Cancel'], cancelId: 3 })
            if (retention.response < 3) save({ destination, intervalDays: frequency.response === 0 ? 1 : 7, keep: [7, 14, 30][retention.response] })
          }
        }
      }
      return manage(event)
    }
    if (answer.response === 2 && (plan.destination || plan.lastPath)) await shell.openPath(plan.destination || path.dirname(plan.lastPath))
    if (answer.response === 3) return restoreBackup(event)
    return { ok: true }
  }
  return { documents: require('./document-backups').documentBackups({ settings, getVault, realSafeTargetPath }), backup: backupCurrentVault, restore: restoreBackup, manage, tick: () => runScheduled(), busy: () => running }
}
module.exports = { makeBackupDomain }
