/**
 * Packages Tulip into build/Tulip-win32-<arch>/, the Windows counterpart to
 * build-app.sh.
 *
 *   node scripts/build-win.mjs              build it
 *   node scripts/build-win.mjs --zip        and zip it for distribution
 *
 * Node rather than PowerShell so it is the same language as the rest of the
 * build and can be run from any shell — including from macOS, to check the
 * packaging logic, though the result only runs on Windows.
 *
 * The output is a portable folder, not an installer. An installer means either
 * Squirrel (which is what the unused frameworks in the macOS bundle are for) or
 * MSIX, both of which want a signing certificate to be worth anything; a folder
 * with an .exe in it needs neither and is what most people do with a Windows
 * build they were handed. Code signing hooks in at the same place it does on
 * macOS — see TULIP_WIN_CERT below.
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.join(ROOT, 'build')

const arch = process.env.TULIP_WIN_ARCH || 'x64'
const APP = path.join(BUILD, `Tulip-win32-${arch}`)
/* Normally the Electron in node_modules. The override exists for cross-builds:
   a CI job (or a Mac) can download the win32 dist somewhere else and point this
   at it without disturbing the Electron the local app runs on. */
const ELECTRON = process.env.TULIP_ELECTRON_DIST || path.join(ROOT, 'node_modules', 'electron', 'dist')

const step = (message) => console.log(`› ${message}`)

async function exists (target) {
  try { await access(target); return true } catch { return false }
}

/* rcedit stamps the icon and the version strings into the .exe. It is a Windows
   binary, so this is skipped when packaging from another OS and when it is not
   installed — the app still runs, it just wears Electron's default icon and
   reports itself as Electron in Task Manager and in the file properties. */
async function brandExecutable (exe, version) {
  if (process.platform !== 'win32') {
    console.log('  (not on Windows — skipping icon and version stamping)')
    return
  }
  const rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  if (!await exists(rcedit)) {
    console.log('  (rcedit not installed — skipping icon and version stamping)')
    console.log('   npm i -D rcedit  to have the .exe carry Tulip\'s icon and name')
    return
  }
  await run(rcedit, [
    exe,
    '--set-icon', path.join(BUILD, 'icon.ico'),
    '--set-file-version', version,
    '--set-product-version', version,
    '--set-version-string', 'ProductName', 'Tulip',
    '--set-version-string', 'FileDescription', 'Tulip',
    '--set-version-string', 'CompanyName', 'Tulip',
    '--set-version-string', 'LegalCopyright', 'MIT',
    '--set-version-string', 'InternalName', 'Tulip',
    '--set-version-string', 'OriginalFilename', 'Tulip.exe'
  ])
}

/* SmartScreen warns on anything unsigned, and the warning gets more insistent
   the less the certificate has been seen — an EV certificate starts trusted, an
   OV one earns trust over downloads. Same shape as the macOS script: configured
   by environment, silently skipped when absent. */
async function signExecutable (exe) {
  const cert = process.env.TULIP_WIN_CERT
  if (!cert) {
    console.log('  (unsigned — set TULIP_WIN_CERT to sign; SmartScreen will warn)')
    return
  }
  if (process.platform !== 'win32') {
    console.log('  (not on Windows — cannot sign here)')
    return
  }
  const args = [
    'sign', '/fd', 'SHA256',
    '/tr', process.env.TULIP_WIN_TIMESTAMP || 'http://timestamp.digicert.com',
    '/td', 'SHA256', '/f', cert
  ]
  if (process.env.TULIP_WIN_CERT_PASSWORD) args.push('/p', process.env.TULIP_WIN_CERT_PASSWORD)
  await run('signtool', [...args, exe])
}

if (!await exists(ELECTRON)) {
  console.error('electron is not installed — run npm install')
  process.exit(1)
}

/* npm installs the Electron binary for the machine doing the installing, so a
   node_modules populated on macOS holds Electron.app and no electron.exe. This
   script assembles a Windows folder out of whatever is in node_modules; it
   cannot invent the Windows binary, so say so plainly rather than failing four
   steps later on a missing file. */
if (!await exists(path.join(ELECTRON, 'electron.exe'))) {
  console.error('node_modules holds the Electron build for this machine, not Windows.')
  console.error('Run this on Windows, or reinstall Electron for win32 first:')
  console.error('  npm_config_platform=win32 npm_config_arch=x64 npm install electron --no-save')
  process.exit(1)
}

/* A dist holding another platform's Electron as well as the Windows one is a
   node_modules that two installs have written to. Copying it wholesale doubles
   the output and ships a macOS app inside a Windows folder, which is the kind
   of thing nobody notices until the zip is twice the size it should be. */
for (const foreign of ['Electron.app', 'electron']) {
  if (await exists(path.join(ELECTRON, foreign))) {
    console.error(`${ELECTRON} holds ${foreign} as well as electron.exe.`)
    console.error('That is two platforms\' Electron in one directory — reinstall, or')
    console.error('point TULIP_ELECTRON_DIST at a clean win32 dist.')
    process.exit(1)
  }
}

step('bundling the renderer')
// `--release` for the same reason build-app.sh passes it: packaging is the
// release boundary, and nothing else should move the version.
await run(process.execPath, [path.join(ROOT, 'build.mjs'), '--release'], { cwd: ROOT })

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const { name, version, description, main, license } = pkg

step('drawing the icon')
const electronBin = path.join(
  ROOT, 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
)
await run(electronBin, [path.join(ROOT, 'scripts', 'make-icon.cjs')], { cwd: ROOT })

step('assembling the folder')
await rm(APP, { recursive: true, force: true })
await cp(ELECTRON, APP, { recursive: true })

// Electron's launcher is electron.exe; the name is what Task Manager, the
// taskbar and the firewall prompt all show, so it is renamed rather than left.
await cp(path.join(APP, 'electron.exe'), path.join(APP, 'Tulip.exe'))
await rm(path.join(APP, 'electron.exe'))
// The default app is the "no app loaded" placeholder window — with a payload
// present it is only dead weight, and it ships a copy of Electron's own docs.
await rm(path.join(APP, 'resources', 'default_app.asar'), { force: true })

// Same payload as the macOS bundle: electron/ and dist/ and a package.json
// naming the entry point. Nothing from node_modules travels — the renderer is
// already bundled by esbuild.
const payload = path.join(APP, 'resources', 'app')
await mkdir(payload, { recursive: true })
await cp(path.join(ROOT, 'electron'), path.join(payload, 'electron'), { recursive: true })
await cp(path.join(ROOT, 'dist'), path.join(payload, 'dist'), { recursive: true })
await writeFile(
  path.join(payload, 'package.json'),
  `${JSON.stringify({ name, version, description, main, license }, null, 2)}\n`
)
await cp(path.join(ROOT, 'LICENSE'), path.join(APP, 'LICENSE'))

step('branding the executable')
const exe = path.join(APP, 'Tulip.exe')
await brandExecutable(exe, version)

step('signing')
await signExecutable(exe)

if (process.argv.includes('--zip')) {
  step('zipping')
  const zip = path.join(BUILD, `Tulip-${version}-win32-${arch}.zip`)
  await rm(zip, { force: true })
  if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path "${APP}\\*" -DestinationPath "${zip}"`
    ])
  } else {
    await run('zip', ['-r', '-q', zip, path.basename(APP)], { cwd: BUILD })
  }
  console.log(`✓ ${zip}`)
}

console.log(`✓ ${APP} (${version})`)
