/**
 * Packages Tulip into build/Tulip-linux-<arch>/, the Linux counterpart to
 * build-win.mjs and scripts/build-app.sh.
 *
 *   node scripts/build-linux.mjs              build it
 *   node scripts/build-linux.mjs --zip        and zip it for distribution
 *
 * Portable folder, not .deb/.AppImage: same bargain as Windows — no installer
 * machinery, no root, just an executable folder. Unsigned: Linux has no gate
 * to satisfy.
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, access, chmod } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '..')
const BUILD = path.join(ROOT, 'build')

const arch = process.env.TULIP_LINUX_ARCH || 'x64'
const APP = path.join(BUILD, `Tulip-linux-${arch}`)
const ELECTRON = process.env.TULIP_ELECTRON_DIST || path.join(ROOT, 'node_modules', 'electron', 'dist')

const step = (message) => console.log(`› ${message}`)

async function exists (target) {
  try { await access(target); return true } catch { return false }
}

if (!await exists(ELECTRON)) {
  console.error('electron is not installed — run npm install')
  process.exit(1)
}

if (!await exists(path.join(ELECTRON, 'electron'))) {
  console.error('node_modules holds the Electron build for this machine, not Linux.')
  console.error('Run this on Linux, or reinstall Electron for linux first:')
  console.error('  npm_config_platform=linux npm_config_arch=x64 npm install electron --no-save')
  process.exit(1)
}

step('bundling the renderer')
await run(process.execPath, [path.join(ROOT, 'build.mjs'), '--release'], { cwd: ROOT })

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

step(`assembling ${APP}`)
await rm(APP, { recursive: true, force: true })
await mkdir(APP, { recursive: true })
for (const file of ['electron', 'chrome-sandbox', 'libEGL.so', 'libGLESv2.so', 'libvk_swiftshader.so', 'libvulkan.so.1', 'resources', 'locales']) {
  const src = path.join(ELECTRON, file)
  if (await exists(src)) await cp(src, path.join(APP, file === 'electron' ? 'tulip' : file), { recursive: true })
}
await cp(path.join(ROOT, 'dist'), path.join(APP, 'resources', 'app', 'dist'), { recursive: true })
for (const file of ['package.json', 'electron']) {
  await cp(path.join(ROOT, file), path.join(APP, 'resources', 'app', file), { recursive: true })
}
await chmod(path.join(APP, 'tulip'), 0o755).catch(() => {})

if (process.argv.includes('--zip')) {
  step('zipping')
  const zip = `${APP}.zip`
  await rm(zip, { force: true })
  await run('zip', ['-qr', zip, path.basename(APP)], { cwd: BUILD })
  console.log(`  ${zip}`)
}

console.log(`Tulip ${version} staged at ${APP}`)
console.log('Run ./tulip inside it. No installer, no signing.')
