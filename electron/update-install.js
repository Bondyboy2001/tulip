'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)

function installAsset (release, platform) {
  if (platform !== 'darwin') return null
  return (release?.assets || []).find((asset) =>
    asset.name === 'Tulip-macos.zip' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') &&
    String(asset.browser_download_url || '').startsWith('https://github.com/Bondyboy2001/tulip/releases/download/')) || null
}

// The helper waits for a successful app exit, stages beside the installed app
// on the same volume, and rolls back if the final move cannot be completed.
const INSTALL_SCRIPT = `#!/bin/sh
set -eu
pid="$1"; source="$2"; target="$3"; stage="$4"; old="$5"; log="$6"
exec >>"$log" 2>&1
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -lt 120 ] || exit 1
  sleep 1
done
/usr/bin/ditto "$source" "$stage"
/usr/bin/codesign --verify --deep --strict "$stage"
/bin/mv "$target" "$old"
if /bin/mv "$stage" "$target"; then
  /usr/bin/open "$target"
else
  /bin/mv "$old" "$target"
  /usr/bin/open "$target"
  exit 1
fi
`

function makeUpdateInstaller ({ app, fetch, flushAllWindows }) {
  let busy = false
  return async function install () {
    if (busy) return { ok: false, reason: 'An update is already being prepared.' }
    if (process.platform !== 'darwin' || !app.isPackaged) return { ok: false, reason: 'Automatic installation is available in the installed macOS app.' }
    busy = true
    let work = ''
    let handedOff = false
    try {
      const response = await fetch('https://api.github.com/repos/Bondyboy2001/tulip/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': `Tulip/${app.getVersion()}` } })
      if (!response.ok) throw new Error('The release could not be reached.')
      const release = await response.json()
      const { isNewer } = require('./update-check')
      if (!isNewer(release.tag_name, app.getVersion())) throw new Error('There is no newer release to install.')
      const asset = installAsset(release, process.platform)
      if (!asset) throw new Error('This release does not include a verified automatic-install package. Use the download link instead.')
      const target = path.resolve(app.getAppPath(), '../../..')
      if (path.basename(target) !== 'Tulip.app') throw new Error('The installed app location could not be identified.')
      await fs.access(path.dirname(target), fs.constants.W_OK)
      work = await fs.mkdtemp(path.join(app.getPath('temp'), 'tulip-update-'))
      const zip = path.join(work, 'release.zip')
      const download = await fetch(asset.browser_download_url)
      if (!download.ok || !download.body) throw new Error('The update download failed.')
      const handle = await fs.open(zip, 'wx')
      const hash = crypto.createHash('sha256')
      let size = 0
      try {
        for await (const chunk of download.body) {
          size += chunk.length
          if (size > 2 * 1024 ** 3) throw new Error('The update exceeds the maximum download size.')
          hash.update(chunk)
          await handle.writeFile(chunk)
        }
      } finally { await handle.close() }
      if (`sha256:${hash.digest('hex')}` !== asset.digest.toLowerCase()) throw new Error('The update failed its download integrity check.')
      const listing = await run('/usr/bin/unzip', ['-Z1', zip], { maxBuffer: 16 * 1024 ** 2 })
      if (listing.stdout.split('\n').filter(Boolean).some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('The update archive contains an unsafe path.')
      await run('/usr/bin/ditto', ['-x', '-k', zip, work])
      const incoming = path.join(work, 'Tulip.app')
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', incoming])
      await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', incoming])
      const plist = path.join(incoming, 'Contents/Info.plist')
      const identifier = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])
      const version = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])
      if (identifier.stdout.trim() !== 'com.hb.tulip' || version.stdout.trim() !== String(release.tag_name).replace(/^v/, '')) throw new Error('The downloaded app does not match this release.')
      const binary = await run('/usr/bin/lipo', ['-archs', path.join(incoming, 'Contents/MacOS/Tulip')])
      const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64'
      if (!binary.stdout.split(/\s+/).includes(architecture)) throw new Error('This release is not built for your Mac.')
      const flushed = await flushAllWindows()
      if (flushed.some((result) => result?.failed)) throw new Error('Save your open documents before installing the update.')
      const helper = path.join(work, 'install.sh')
      await fs.writeFile(helper, INSTALL_SCRIPT, { mode: 0o700 })
      const nonce = crypto.randomUUID()
      const old = path.join(path.dirname(target), `Tulip Previous ${nonce}.app`)
      const stage = path.join(path.dirname(target), `.Tulip-update-${nonce}.app`)
      const log = path.join(app.getPath('userData'), 'update-install.log')
      const child = spawn('/bin/sh', [helper, String(process.pid), incoming, target, stage, old, log], { detached: true, stdio: 'ignore' })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
      handedOff = true
      setTimeout(() => app.quit(), 100)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error.message || 'The update could not be installed.' }
    } finally {
      if (work && !handedOff) await fs.rm(work, { recursive: true, force: true }).catch(() => {})
      busy = false
    }
  }
}
module.exports = { makeUpdateInstaller, installAsset }
