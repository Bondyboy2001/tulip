'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)

/* The release artifact an automatic install may use, or null. Three facts have
   to hold together: the name names the platform, GitHub published a SHA-256
   digest for it, and the URL is the project's own release download — an asset
   that fails any of them is a download link, not an install. Windows releases
   are the portable folder, zipped with its contents at the archive root. */
const RELEASE_DOWNLOADS = 'https://github.com/Bondyboy2001/tulip/releases/download/'
function installAsset (release, platform) {
  const wanted = platform === 'darwin'
    ? (asset) => asset.name === 'Tulip-macos.zip'
    : platform === 'win32'
      ? (asset) => /^Tulip-[\d.]+-win32-x64\.zip$/i.test(String(asset.name || ''))
      : () => false
  return (release?.assets || []).find((asset) =>
    wanted(asset) && /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') &&
    String(asset.browser_download_url || '').startsWith(RELEASE_DOWNLOADS)) || null
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

/* Windows: the release is a zip whose root is the app folder, so unpacking it
   beside the install gives a complete replacement to move into place. The
   helper below does nothing but wait, swap and launch — every check that can
   refuse the update happens in the main process first, where a failure is a
   message in the window rather than half a folder.
 *
 * The archive is opened as a zip and every entry name vetted before
 * Expand-Archive runs: an entry with `..` or a rooted name is how an archive
 * writes outside the folder it was unpacked into. */
const EXPAND_SCRIPT = `param([string]$zip, [string]$stage)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName
    if ($name.StartsWith('/') -or $name -match '(^|[/\\])\\.\\.([/\\]|$)') { throw "unsafe path in update archive: $name" }
  }
} finally { $archive.Dispose() }
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $stage
`

const INSTALL_SCRIPT_WIN = `param([int]$pid, [string]$stage, [string]$target, [string]$old, [string]$exe, [string]$log)
$ErrorActionPreference = 'Stop'
Start-Transcript -Path $log -Append | Out-Null
try {
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Process -Id $pid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Id $pid -ErrorAction SilentlyContinue) { throw 'the app did not exit' }
  if (Test-Path $old) { Remove-Item -LiteralPath $old -Recurse -Force }
  Move-Item -LiteralPath $target -Destination $old
  try {
    Move-Item -LiteralPath $stage -Destination $target
  } catch {
    Move-Item -LiteralPath $old -Destination $target
    throw
  }
  Start-Process -FilePath (Join-Path $target $exe)
} catch {
  Write-Error $_
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
`

const powershell = (...args) =>
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args])

/**
 * The Authenticode status of an executable, or 'Unknown' where it cannot be
 * asked. Only ever used to decide whether the running copy is signed at all;
 * an ad-hoc/unsigned install cannot demand a signature its own release does
 * not carry, and its download digest remains the check either way.
 */
async function windowsSignatureStatus (exe) {
  try {
    const quoted = String(exe).replace(/'/g, "''")
    const { stdout } = await powershell('-Command', `(Get-AuthenticodeSignature -LiteralPath '${quoted}').Status`)
    return stdout.trim()
  } catch { return 'Unknown' }
}

/** Unpack, check, and hand the folder swap to a detached helper. */
async function installWindows ({ app, release, zip, work }) {
  const target = path.resolve(app.getAppPath(), '..', '..')
  if (path.basename(process.execPath).toLowerCase() !== 'tulip.exe') {
    throw new Error('The installed app location could not be identified.')
  }
  await fs.access(path.dirname(target), fs.constants.W_OK)

  const stage = path.join(work, 'incoming')
  const expand = path.join(work, 'expand.ps1')
  await fs.writeFile(expand, EXPAND_SCRIPT)
  await powershell('-File', expand, '-zip', zip, '-stage', stage)

  /* Windows builds zip the folder's contents; the cross-platform fallback
     (zip -r) keeps the folder itself. Find the exe one level either way. */
  let root = stage
  const hasExe = (dir) => fs.access(path.join(dir, 'Tulip.exe')).then(() => true, () => false)
  if (!await hasExe(root)) {
    const entries = await fs.readdir(stage, { withFileTypes: true })
    const dirs = entries.filter((entry) => entry.isDirectory())
    if (dirs.length === 1) root = path.join(stage, dirs[0].name)
  }
  const exe = path.join(root, 'Tulip.exe')
  if (!await hasExe(root)) throw new Error('The downloaded app has no Tulip.exe.')
  const packaged = JSON.parse(await fs.readFile(path.join(root, 'resources', 'app', 'package.json'), 'utf8'))
  if (String(packaged.version) !== String(release.tag_name).replace(/^v/, '')) {
    throw new Error('The downloaded app does not match this release.')
  }
  if (await windowsSignatureStatus(process.execPath) === 'Valid' &&
      await windowsSignatureStatus(exe) !== 'Valid') {
    throw new Error('The downloaded app is not signed the way this copy is.')
  }

  const helper = path.join(work, 'install.ps1')
  await fs.writeFile(helper, INSTALL_SCRIPT_WIN)
  const nonce = crypto.randomUUID()
  const old = path.join(path.dirname(target), `Tulip Previous ${nonce}`)
  const log = path.join(app.getPath('userData'), 'update-install.log')
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-pid', String(process.pid), '-stage', root, '-target', target,
    '-old', old, '-exe', 'Tulip.exe', '-log', log
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  setTimeout(() => app.quit(), 100)
}

function makeUpdateInstaller ({ app, fetch, flushAllWindows }) {
  let busy = false
  return async function install () {
    if (busy) return { ok: false, reason: 'An update is already being prepared.' }
    if (!app.isPackaged || (process.platform !== 'darwin' && process.platform !== 'win32')) {
      return { ok: false, reason: 'Automatic installation is available in the installed macOS and Windows apps.' }
    }
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
      if (process.platform === 'win32') {
        const flushed = await flushAllWindows()
        if (flushed.some((result) => result?.failed)) throw new Error('Save your open documents before installing the update.')
        await installWindows({ app, release, zip, work })
        handedOff = true
        return { ok: true }
      }
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
