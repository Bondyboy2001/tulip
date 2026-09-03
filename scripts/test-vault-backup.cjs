'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { backupVault, restoreVault, verifyBackup } = require('../electron/vault-backup')

;(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-backup-test-'))
  const source = path.join(root, 'vault')
  const backup = path.join(root, 'vault.tulip-backup')
  const restored = path.join(root, 'restored')

  try {
    await fs.mkdir(path.join(source, '.tulip'), { recursive: true })
    await fs.mkdir(path.join(source, '.attachments'), { recursive: true })
    await fs.writeFile(path.join(source, 'Note.md'), '# Note\n')
    await fs.writeFile(path.join(source, '.tulip', 'review.json'), '{}\n')
    await fs.writeFile(path.join(source, '.attachments', 'image.png'), 'bytes')
    await fs.mkdir(path.join(source, 'node_modules'))
    await fs.writeFile(path.join(source, 'node_modules', 'ignored'), 'no')

    const made = await backupVault(source, backup)
    assert.equal(made.files.length, 3)
    assert.deepEqual((await verifyBackup(backup)).files.map((file) => file.path), [
      '.attachments/image.png', '.tulip/review.json', 'Note.md'
    ])

    await restoreVault(backup, restored)
    assert.equal(await fs.readFile(path.join(restored, 'Note.md'), 'utf8'), '# Note\n')
    await assert.rejects(() => fs.access(path.join(restored, 'node_modules')))

    await fs.appendFile(path.join(backup, 'Note.md'), 'tampered\n')
    await assert.rejects(() => verifyBackup(backup), /integrity check/)
    console.log('vault backup: all checks passed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
