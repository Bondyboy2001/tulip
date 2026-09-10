'use strict'

const assert = require('node:assert/strict')
const { checkForUpdate, downloadAsset, isNewer } = require('../electron/update-check')
const { installAsset } = require('../electron/update-install')

assert.equal(isNewer('v0.2.0', '0.1.99'), true)
assert.equal(isNewer('0.1.270', '0.1.270'), false)
assert.equal(isNewer('0.1.9', '0.1.10'), false)

const release = {
  tag_name: 'v0.1.271',
  html_url: 'https://example.test/release',
  body: 'A useful release.',
  assets: [
    { name: 'Tulip-0.1.271-win32-x64.zip', browser_download_url: 'https://example.test/windows.zip' },
    { name: 'Tulip-macos.zip', browser_download_url: 'https://example.test/macos.zip' },
    { name: 'Tulip-macos.dmg', browser_download_url: 'https://example.test/Tulip.dmg' }
  ]
}

assert.equal(downloadAsset(release, 'darwin', 'arm64').name, 'Tulip-macos.dmg')
assert.equal(downloadAsset(release, 'win32', 'x64').name, 'Tulip-0.1.271-win32-x64.zip')
assert.equal(downloadAsset(release, 'linux', 'x64'), null)

/* An install is offered only where all three facts hold: the platform's own
   artifact name, a published digest, and the project's own download URL. */
const digest = `sha256:${'a'.repeat(64)}`
const downloadable = (name) => ({
  name,
  digest,
  browser_download_url: `https://github.com/Bondyboy2001/tulip/releases/download/v0.1.271/${name}`
})
const installable = { tag_name: 'v0.1.271', assets: [downloadable('Tulip-macos.zip'), downloadable('Tulip-0.1.271-win32-x64.zip')] }
assert.equal(installAsset(installable, 'darwin').name, 'Tulip-macos.zip')
assert.equal(installAsset(installable, 'win32').name, 'Tulip-0.1.271-win32-x64.zip')
assert.equal(installAsset(installable, 'linux'), null)
assert.equal(installAsset({ assets: [{ ...downloadable('Tulip-macos.zip'), digest: '' }] }, 'darwin'), null)
assert.equal(installAsset({ assets: [downloadable('Tulip-macos.zip')] }, 'darwin').name, 'Tulip-macos.zip')
assert.equal(installAsset({ assets: [{ ...downloadable('Tulip-macos.zip'), browser_download_url: 'https://evil.test/x.zip' }] }, 'darwin'), null)

const response = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value
})

async function run () {
  const newer = await checkForUpdate({
    current: '0.1.270',
    platform: 'darwin',
    arch: 'arm64',
    fetch: async () => response(release)
  })
  assert.equal(newer.newer, true)
  assert.equal(newer.downloadUrl, 'https://example.test/Tulip.dmg')
  assert.equal(newer.downloadName, 'Tulip-macos.dmg')
  assert.equal(newer.notes, 'A useful release.')

  assert.deepEqual(await checkForUpdate({
    current: '0.1.270', fetch: async () => response({}, 404)
  }), { ok: true, current: '0.1.270', latest: null, newer: false })

  const windows = await checkForUpdate({
    current: '0.1.270',
    platform: 'win32',
    arch: 'x64',
    fetch: async () => response(installable)
  })
  assert.equal(windows.canInstall, true, 'a digest-verified Windows zip offers Install and restart')
  assert.equal(windows.downloadUrl, installable.assets[1].browser_download_url)

  const failed = await checkForUpdate({
    current: '0.1.270', fetch: async () => { throw new Error('offline') }
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'offline')
  console.log('update check: versions, platform assets and failures passed')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
