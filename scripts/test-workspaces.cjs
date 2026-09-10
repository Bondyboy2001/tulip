'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { makeWindowSessions } = require('../electron/window-sessions')
const { makeBackupDomain } = require('../electron/ipc-backups')
const { installAsset } = require('../electron/update-install')
const { verifyBackup } = require('../electron/vault-backup')

async function main () {
  let config = { tabs: ['Original.md'], tabIndex: 0 }
  let vault = '/vault'
  const session = makeWindowSessions({ readConfig: () => config, writeConfig: (patch) => { config = { ...config, ...patch }; return config }, getVault: () => vault })
  const win = (id) => ({ webContents: { id }, isMinimized: () => false, isFullScreen: () => false, isMaximized: () => false, getNormalBounds: () => ({ x: 0, y: 0, width: 800, height: 700 }) })
  session.add(win(1), null, true)
  session.add(win(2), null, false)
  session.patch(1, { tabs: ['One.md'], tabPlaces: [40], sideDoc: 'Paper.pdf', sideScroll: 250 })
  session.patch(2, { tabs: ['Two.md'], tabPlaces: [12] })
  assert.deepEqual(session.config(1).tabs, ['One.md'])
  assert.deepEqual(session.config(2).tabs, ['Two.md'])
  assert.notEqual(session.id(1), session.id(2))
  session.bounds(win(1))
  session.saveNamed('Research')
  session.patch(1, { tabs: ['Changed.md'] })
  assert.deepEqual(session.named().Research[0].state.tabs, ['One.md'])
  // Closing one window during quit must not erase it when another flushes.
  session.remove(1, true)
  session.patch(2, { tabPlaces: [15] })
  assert.equal(session.saved().length, 2)
  assert.equal(session.saved()[0].state.sideScroll, 250)
  vault = '/other'
  session.switchVault()
  assert.equal(Object.keys(session.named()).length, 0)
  assert.deepEqual(session.config(1).tabs, [])

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-backup-plan-'))
  try {
    const source = path.join(scratch, 'vault')
    const destination = path.join(scratch, 'backups')
    await fs.mkdir(source); await fs.mkdir(destination)
    await fs.writeFile(path.join(source, 'Note.md'), 'Original text')
    const crypto = require('node:crypto')
    const id = crypto.createHash('sha256').update(source).digest('hex')
    config = { backupPlans: { [id]: { destination, intervalDays: 1, keep: 1 } } }
    let fail = false
    const domain = makeBackupDomain({ app: {}, dialog: {}, shell: {}, windowOf: () => null, getVault: () => source,
      flushAllWindows: async () => [{ failed: fail }], openVault: async () => {}, readConfig: () => config,
      writeConfig: (patch) => { config = { ...config, ...patch } } })
    await domain.tick()
    const first = config.backupPlans[id].lastPath
    assert.equal((await verifyBackup(first)).files.length, 1)
    await domain.tick()
    assert.equal(config.backupPlans[id].lastPath, first, 'not due means no duplicate backup')
    fail = true
    config.backupPlans[id].lastSuccess = 0; config.backupPlans[id].lastAttempt = 0
    await domain.tick()
    assert.match(config.backupPlans[id].error, /saved/)
    assert.equal((await verifyBackup(first)).files.length, 1, 'failed backup keeps the previous copy')
    fail = false
    config.backupPlans[id].lastAttempt = 0
    await fs.writeFile(path.join(source, 'Note.md'), 'Updated text')
    await domain.tick()
    assert.notEqual(config.backupPlans[id].lastPath, first)
    assert.equal(config.backupPlans[id].copies.length, 1)
    await assert.rejects(fs.access(first))
    assert.equal((await verifyBackup(config.backupPlans[id].lastPath)).files.length, 1)
    config.backupPlans[id].destination = source
    config.backupPlans[id].lastSuccess = 0; config.backupPlans[id].lastAttempt = 0
    await domain.tick()
    assert.match(config.backupPlans[id].error, /outside/)
  } finally { await fs.rm(scratch, { recursive: true, force: true }) }
  const asset = { name: 'Tulip-macos.zip', digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/Bondyboy2001/tulip/releases/download/v1/Tulip-macos.zip' }
  assert.equal(installAsset({ assets: [asset] }, 'darwin'), asset)
  assert.equal(installAsset({ assets: [{ ...asset, digest: '' }] }, 'darwin'), null)
  assert.equal(installAsset({ assets: [{ ...asset, browser_download_url: 'https://elsewhere.test/release.zip' }] }, 'darwin'), null)
  assert.equal(installAsset({ assets: [asset] }, 'win32'), null)
  console.log('workspaces: independent windows, quit restoration, named snapshots, backup scheduling/failure/retention, installer eligibility passed')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
