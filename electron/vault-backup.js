'use strict'

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const MANIFEST = 'tulip-backup.json'
const VERSION = 1
const BACKUP_EXTENSION = '.tulip-backup'

/* Derived files and dependency folders are rebuilt by Tulip or by their own
   tools. User-owned state such as .tulip, .attachments and .annotations stays. */
const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', '__pycache__', '.trash'])

const validRelative = (value) => {
  const text = String(value || '')
  const parts = text.split('/')
  if (!text || text.startsWith('/') || text.includes('\\') ||
      parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' &&
    !path.isAbsolute(relative))
}

async function digest (file) {
  /* Streamed, not read whole: a GB video vault OOMed on `readFile`. */
  const hash = crypto.createHash('sha256')
  const stream = fsSync.createReadStream(file)
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

async function collectFiles (root) {
  const files = []

  async function walk (dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!prefix && entry.name === MANIFEST) continue
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Backups cannot include symbolic links: ${relative}`)
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative)
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute)
        files.push({ path: relative, size: stat.size, sha256: await digest(absolute) })
      }
    }
  }

  await walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function sameFiles (expected, actual) {
  if (expected.length !== actual.length) return false
  return expected.every((file, index) =>
    file.path === actual[index].path && file.size === actual[index].size &&
    file.sha256 === actual[index].sha256)
}

function manifestFiles (manifest) {
  if (!manifest || manifest.version !== VERSION || !Array.isArray(manifest.files)) {
    throw new Error('That folder is not a Tulip backup.')
  }
  const files = manifest.files.map((file) => {
    const relative = validRelative(file?.path)
    const size = Number(file?.size)
    const sha256 = String(file?.sha256 || '')
    if (!relative || !Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error('The backup manifest is invalid.')
    }
    return { path: relative, size, sha256: sha256.toLowerCase() }
  }).sort((a, b) => a.path.localeCompare(b.path))
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('The backup manifest contains duplicate files.')
  }
  return files
}

async function copyFiles (source, target, files) {
  for (const file of files) {
    const relative = validRelative(file.path)
    if (!relative) throw new Error('The backup contains an unsafe path.')
    const from = path.join(source, ...relative.split('/'))
    const to = path.join(target, ...relative.split('/'))
    if (!inside(source, from) || !inside(target, to)) {
      throw new Error('The backup contains a path outside its folder.')
    }
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(from, to)
    const mode = (await fs.stat(from)).mode & 0o777
    await fs.chmod(to, mode).catch(() => {})
  }
}

async function verifyBackup (source) {
  const root = path.resolve(source)
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8'))
  const files = manifestFiles(manifest)
  const actual = await collectFiles(root)
  if (!sameFiles(files, actual)) throw new Error('The backup failed its integrity check.')
  return { ...manifest, files }
}

async function backupVault (source, target) {
  const from = path.resolve(source)
  const to = path.resolve(target)
  if (inside(from, to)) throw new Error('The backup must be outside the vault.')
  const files = await collectFiles(from)
  await fs.mkdir(to)
  try {
    await copyFiles(from, to, files)
    const copied = await collectFiles(to)
    if (!sameFiles(files, copied)) throw new Error('The backup failed its integrity check.')
    const manifest = {
      version: VERSION,
      sourceName: path.basename(from),
      createdAt: new Date().toISOString(),
      files
    }
    await fs.writeFile(path.join(to, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    return manifest
  } catch (error) {
    await fs.rm(to, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function restoreVault (source, target) {
  const from = path.resolve(source)
  const to = path.resolve(target)
  if (inside(from, to)) throw new Error('The restored vault must be outside the backup.')
  const manifest = await verifyBackup(from)
  await fs.mkdir(to)
  try {
    await copyFiles(from, to, manifest.files)
    const copied = await collectFiles(to)
    if (!sameFiles(manifest.files, copied)) throw new Error('The restored vault failed its integrity check.')
    return manifest
  } catch (error) {
    await fs.rm(to, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

module.exports = { BACKUP_EXTENSION, MANIFEST, backupVault, restoreVault, verifyBackup }
