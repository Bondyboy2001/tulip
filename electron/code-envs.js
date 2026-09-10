'use strict'

// Generated projects and version records live outside the vault. Native package
// managers own resolution; a note owns its environment, never the whole machine.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { builtinModules } = require('node:module')
const { killTree } = require('./kill-tree')
const { missingPackage, hasInlineDeps, pythonIn } = require('./python-env')
const MANIFESTS = {
  python: ['requirements.txt'],
  rust: ['Cargo.toml', 'Cargo.lock'],
  node: ['package.json', 'package-lock.json'],
  go: ['go.mod', 'go.sum'],
  julia: ['Project.toml', 'Manifest.toml']
}
const LANGUAGES = Object.keys(MANIFESTS)
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24)
const writeChanged = async (file, text) => { if (await fs.readFile(file, 'utf8').catch(() => null) !== text) await fs.writeFile(file, text) }
const exists = (p) => fs.access(p).then(() => true, () => false)
const json = async (p, fallback) => JSON.parse(await fs.readFile(p, 'utf8').catch(() => JSON.stringify(fallback)))
const safe = (lang, name) => typeof name === 'string' && name.length < 200 && (lang === 'node'
  ? /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
  : lang === 'go' ? /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}\/[-\w./]+$/i.test(name) && !name.includes('..')
  : /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name))

function missingImport (lang, stderr, code) {
  let name
  if (lang === 'python') {
    const match = /ModuleNotFoundError: No module named '([^']+)'/g
    name = [...String(stderr).matchAll(match)].at(-1)?.[1]?.split('.')[0]
    if (!safe(lang, name) || !new RegExp(`(?:^|\\n)\\s*(?:from\\s+${name}\\b|import\\s+[^\\n]*\\b${name}\\b)`).test(code)) return null
  } else if (lang === 'rust') {
    name = /(?:unresolved import|unresolved module or unlinked crate|can't find crate for) [`']([\w]+)[`']/.exec(stderr)?.[1]
    if (!name || ['std', 'core', 'alloc', 'self', 'super', 'crate'].includes(name) || new RegExp(`\\bmod\\s+${name}\\b`).test(code)) return null
    if (!new RegExp(`\\b(?:use\\s+|extern\\s+crate\\s+)?${name}\\s*(?:::|;)`).test(code)) return null
  } else if (lang === 'node') {
    const spec = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(stderr)?.[1]
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null
    name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (builtinModules.includes(name) || !code.includes(`'${spec}'`) && !code.includes(`"${spec}"`)) return null
  } else if (lang === 'go') {
    name = /no required module provides package ([^;\s]+)/.exec(stderr)?.[1]
    if (!name || !code.includes(`"${name}"`)) return null
  } else if (lang === 'julia') {
    name = /Package (\w+) not found/.exec(stderr)?.[1]
    if (!name || !new RegExp(`\\b(?:using|import)\\s+[^\\n]*\\b${name}\\b`).test(code)) return null
  }
  return safe(lang, name) ? name : null
}

function makeCodeEnvs ({ root, vault, pathFor, pythonEnvs, autoInstall }) {
  const queues = new Map()
  const controllers = new Map()
  let rustVersion = null
  const directory = (note, lang) => {
    if (!LANGUAGES.includes(lang)) throw new Error('Package management is not available for this language.')
    return path.join(root(), 'code-envs', lang, hash(`${vault()}\n${note || ':scratch'}`))
  }
  async function locked (dir, fn) {
    const before = queues.get(dir) || Promise.resolve()
    const work = before.catch(() => {}).then(fn)
    queues.set(dir, work)
    try { return await work } finally { if (queues.get(dir) === work) queues.delete(dir) }
  }
  async function save (dir, record) {
    const text = JSON.stringify(record, null, 2) + '\n'
    if (await fs.readFile(path.join(dir, 'record.json'), 'utf8').catch(() => null) === text) return
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'record.json.tmp'), text)
    await fs.rename(path.join(dir, 'record.json.tmp'), path.join(dir, 'record.json'))
  }
  async function recordFor (dir, note, lang) {
    return json(path.join(dir, 'record.json'), { language: lang, note, vault: vault(), packages: {}, mappings: {}, created: new Date().toISOString() })
  }
  function command (cmd, args, { cwd, env, signal, output = () => {}, build = false, timeoutMs = 60000, quiet = false }) {
    if (signal?.aborted) return Promise.resolve({ code: null, signal: 'SIGTERM', ms: 0, buildMs: 0 })
    return new Promise((resolve) => {
      const from = Date.now()
      let errTail = '', stdout = '', timedOut = false, error = null
      const child = spawn(cmd, args, { cwd, env: { ...process.env, PATH: pathFor(), NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      const abort = () => killTree(child, 'SIGKILL')
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => { timedOut = true; abort() }, build ? 600000 : timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (text) => {
        if (quiet) stdout = (stdout + text).slice(-2000000)
        else output('stdout', text)
      })
      child.stderr.on('data', (text) => {
        errTail = (errTail + text).slice(-64000)
        if (!quiet) output('stderr', text)
      })
      child.on('error', (err) => { error = err.message })
      child.on('close', (code, killed) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        const ms = Date.now() - from
        resolve({ code, signal: signal?.aborted ? 'SIGTERM' : killed, error, timedOut, errTail, stdout, ms, buildMs: build ? ms : 0 })
      })
    })
  }
  const ok = (r) => r.code === 0 && !r.error && !r.signal && !r.timedOut
  async function requireCommand (cmd, args, how) {
    const result = await command(cmd, args, { ...how, build: true })
    if (!ok(result)) throw new Error(result.signal ? 'Stopped.' : result.error || result.errTail || 'Package operation failed.')
    return result
  }
  async function setup (dir, note, lang, how) {
    await fs.mkdir(dir, { recursive: true })
    const record = await recordFor(dir, note, lang)
    if (lang === 'python') {
      const pyDir = await pythonEnvs.dirFor(note)
      const python = pythonIn(pyDir)
      if (!await exists(python)) {
        const useUv = await pythonEnvs.usesUv()
        await requireCommand(useUv ? 'uv' : process.platform === 'win32' ? 'python' : 'python3', useUv ? ['venv', '--seed', pyDir] : ['-m', 'venv', pyDir], how)
        if (await exists(path.join(dir, 'requirements.txt'))) {
          await requireCommand(useUv ? 'uv' : python, useUv ? ['pip', 'install', '--python', python, '-r', path.join(dir, 'requirements.txt')] : ['-m', 'pip', 'install', '-r', path.join(dir, 'requirements.txt')], how)
        }
      }
      record.pythonDir = pyDir
      how.env = { ...pythonEnvs.activation(pyDir), PYTHONPATH: [path.resolve(how.cwd, path.dirname(note || '')), how.cwd].join(path.delimiter), PYTHONHOME: '', PYTHONNOUSERSITE: '1' }
      how.python = python
    }
    if (lang === 'node' && !await exists(path.join(dir, 'package.json'))) await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'tulip-note', private: true, version: '1.0.0' }))
    if (lang === 'node' && Object.keys(record.packages).length && !await exists(path.join(dir, 'node_modules'))) await requireCommand('npm', ['ci', '--prefix', dir, '--no-audit', '--no-fund'], { ...how, cwd: dir })
    if (lang === 'go' && !await exists(path.join(dir, 'go.mod'))) await requireCommand('go', ['mod', 'init', 'tulip.local/note'], { ...how, cwd: dir })
    await save(dir, record)
    return record
  }
  async function installCommand (dir, lang, name, action, python) {
    const remove = action === 'remove'
    const update = action === 'update'
    switch (lang) {
      case 'python':
        if (await pythonEnvs.usesUv()) return ['uv', ['pip', remove ? 'uninstall' : 'install', '--python', python, ...(update ? ['--upgrade'] : []), name]]
        return [python, ['-m', 'pip', remove ? 'uninstall' : 'install', ...(remove ? ['-y'] : update ? ['--upgrade'] : []), name]]
      case 'node':
        return ['npm', [remove ? 'uninstall' : 'install', '--prefix', dir, '--save-exact', '--no-audit', '--no-fund', name + (update ? '@latest' : '')]]
      case 'rust':
        return ['cargo', [remove ? 'remove' : update ? 'update' : 'add', ...(update ? ['-p'] : []), name, '--manifest-path', path.join(dir, 'Cargo.toml')]]
      case 'go':
        return ['go', ['get', name + (remove ? '@none' : update ? '@latest' : '')]]
      case 'julia':
        return ['julia', ['--startup-file=no', `--project=${dir}`, '-e', `using Pkg; Pkg.${remove ? 'rm' : update ? 'update' : 'add'}(${JSON.stringify(name)})`]]
    }
  }
  async function install (dir, record, name, action, how) {
    const lang = record.language
    if (!safe(lang, name)) throw new Error('Enter a package name, without command options or a URL.')
    const [cmd, args] = await installCommand(dir, lang, name, action, how.python)
    const manifests = MANIFESTS[lang]
    const before = new Map(await Promise.all(manifests.map(async (file) => [file, await fs.readFile(path.join(dir, file)).catch(() => null)])))
    try { await requireCommand(cmd, args, { ...how, cwd: dir }) } catch (error) {
      for (const [file, contents] of before) {
        if (contents === null) await fs.rm(path.join(dir, file), { force: true })
        else await fs.writeFile(path.join(dir, file), contents)
      }
      throw error
    }
    await snapshot(dir, record, how)
    await save(dir, record)
  }
  async function snapshot (dir, record, how) {
    if (record.language === 'python') {
      const result = await requireCommand(how.python, ['-c', 'import importlib.metadata as m, json; print(json.dumps([{"name": d.metadata["Name"], "version": d.version} for d in m.distributions()]))'], { ...how, quiet: true })
      const packages = JSON.parse(result.stdout)
      record.packages = Object.fromEntries(packages.filter((p) => !['pip', 'setuptools', 'wheel'].includes(p.name)).map((p) => [p.name, p.version]))
      record.packagesScanned = true
      await writeChanged(path.join(dir, 'requirements.txt'), Object.entries(record.packages).map(([n, v]) => `${n}==${v}`).join('\n') + '\n')
    } else if (record.language === 'node') {
      const lock = await json(path.join(dir, 'package-lock.json'), {})
      const manifest = await json(path.join(dir, 'package.json'), {})
      record.packages = Object.fromEntries(Object.keys(manifest.dependencies || {}).map((name) => [name, lock.packages?.[`node_modules/${name}`]?.version || manifest.dependencies[name]]))
    } else if (record.language === 'rust') {
      const result = await requireCommand('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', path.join(dir, 'Cargo.toml')], { ...how, cwd: dir, quiet: true })
      const lock = await fs.readFile(path.join(dir, 'Cargo.lock'), 'utf8').catch(() => '')
      const versions = new Map([...lock.matchAll(/\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"/g)].map((m) => [m[1], m[2]]))
      record.packages = Object.fromEntries(JSON.parse(result.stdout).packages[0].dependencies.map((d) => [d.name, versions.get(d.name) || d.req]))
    } else if (record.language === 'go') {
      const text = await fs.readFile(path.join(dir, 'go.mod'), 'utf8')
      record.packages = Object.fromEntries([...text.matchAll(/(?:^|\n)\s*(?:require\s+)?([^\s()]+)\s+(v[^\s]+)/g)].map((m) => [m[1], m[2]]))
    } else {
      const result = await requireCommand('julia', ['--startup-file=no', `--project=${dir}`, '-e', 'using Pkg; for (_, d) in Pkg.dependencies(); if d.is_direct_dep; println(d.name, "\t", d.version); end; end'], { ...how, quiet: true })
      record.packages = Object.fromEntries(result.stdout.trim().split('\n').filter((s) => s.includes('\t')).map((s) => s.split('\t')))
    }
  }
  async function rustManifest (dir, source) {
    const file = path.join(dir, 'Cargo.toml')
    if (!await exists(file)) await fs.writeFile(file, '[package]\nname = "tulip_note"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n\n[profile.dev]\nopt-level = 2\n\n[[bin]]\nname = "tulip_block"\npath = "main.rs"\n\n[dependencies]\n')
    await writeChanged(path.join(dir, 'main.rs'), source)
  }
  async function runBuilt (built, binary, how) {
    if (!ok(built)) return built
    const result = await command(binary, [], how)
    return { ...result, ms: built.ms + result.ms, buildMs: built.ms }
  }
  async function execute (dir, record, code, lang, how) {
    if (how.signal.aborted) return { code: null, signal: 'SIGTERM', ms: 0, buildMs: 0 }
    if (lang === 'rust') {
      await rustManifest(dir, code)
      if (!Object.keys(record.packages).length) {
        const binary = path.join(dir, `standalone${process.platform === 'win32' ? '.exe' : ''}`)
        if (!rustVersion) {
          const version = await command('rustc', ['--version'], { ...how, quiet: true })
          if (!ok(version)) return version
          rustVersion = version.stdout
        }
        const identity = hash(code + rustVersion)
        const stamp = path.join(dir, 'standalone-source')
        if (await fs.readFile(stamp, 'utf8').catch(() => '') === identity && await exists(binary)) return command(binary, [], how)
        const built = await command('rustc', ['-O', '--edition', '2021', '-A', 'dead_code', path.join(dir, 'main.rs'), '-o', binary], { ...how, cwd: dir, build: true })
        if (!ok(built)) return built
        await fs.writeFile(stamp, identity)
        return runBuilt(built, binary, how)
      }
      const binary = path.join(dir, 'target', 'debug', `tulip_block${process.platform === 'win32' ? '.exe' : ''}`)
      const built = await command('cargo', ['build', '--quiet', '--manifest-path', path.join(dir, 'Cargo.toml'), ...(await exists(path.join(dir, 'Cargo.lock')) ? ['--locked'] : [])], { ...how, cwd: dir, build: true })
      return runBuilt(built, binary, how)
    }
    const ext = lang === 'python' ? 'py' : lang === 'node' ? (how.typescript ? 'mts' : /^\s*(import\s|export\s)/m.test(code) ? 'mjs' : 'cjs') : lang === 'go' ? 'go' : 'jl'
    const file = path.join(dir, `block.${ext}`)
    await writeChanged(file, code)
    if (lang === 'go') {
      const binary = path.join(dir, `program${process.platform === 'win32' ? '.exe' : ''}`)
      const built = await command('go', ['build', '-o', binary, file], { ...how, cwd: dir, build: true })
      return runBuilt(built, binary, how)
    }
    return command(lang === 'python' ? how.python : lang === 'node' ? 'node' : 'julia', lang === 'python' ? ['-u', file] : lang === 'node' ? [file] : ['--startup-file=no', `--project=${dir}`, file], how)
  }
  async function run ({ id, note, lang, code, cwd, timeoutMs, output, typescript = false }) {
    const dir = directory(note, lang)
    const control = new AbortController()
    controllers.set(id, control)
    try {
      return await locked(dir, async () => {
        const how = { cwd, timeoutMs, output, signal: control.signal, typescript }
        if (control.signal.aborted) return { code: null, signal: 'SIGTERM', ms: 0, buildMs: 0 }
        const record = await setup(dir, note, lang, how)
        const tried = new Set()
        let total = 0, build = 0
        for (let pass = 0; ; pass++) {
          const result = await execute(dir, record, code, lang, how)
          total += result.ms || 0; build += result.buildMs || 0
          if (ok(result) && lang === 'python' && !record.packagesScanned && !Object.keys(record.packages).length) {
            await snapshot(dir, record, how)
            await save(dir, record)
          }
          if (ok(result) || result.error || result.signal || result.timedOut || !autoInstall() || pass >= 8) return { ...result, ms: total, buildMs: build }
          const imported = missingImport(lang, result.errTail, code)
          if (!imported || tried.has(imported)) return { ...result, ms: total, buildMs: build }
          tried.add(imported)
          // A missing local file must not be turned into a registry install.
          const localBase = path.join(cwd, path.dirname(note || ''), imported)
          if (await exists(localBase) || await exists(localBase + '.py') || await exists(localBase + '.rs') || await exists(path.join(cwd, imported + '.py'))) return result
          const pkg = record.mappings[imported] || (lang === 'python' ? missingPackage(result.errTail) : imported)
          output('stdout', `\nInstalling ${pkg}…\n`)
          const installingAt = Date.now()
          try {
            await install(dir, record, pkg, 'add', how)
            const elapsed = Date.now() - installingAt
            total += elapsed; build += elapsed
          } catch (error) {
            if (control.signal.aborted) return { ...result, code: null, signal: 'SIGTERM' }
            output('stderr', `Could not install ${pkg}: ${error.message}\nOpen Packages to choose the package that provides ${imported}.\n`)
            return result
          }
        }
      })
    } catch (error) {
      if (control.signal.aborted) return { code: null, signal: 'SIGTERM', ms: 0, buildMs: 0 }
      throw error
    } finally { controllers.delete(id) }
  }
  async function manage (note, lang, action = 'list', name, imported) {
    const dir = directory(note, lang)
    const operation = Symbol('package operation')
    const control = new AbortController()
    controllers.set(operation, control)
    try {
      return await locked(dir, async () => {
        if (control.signal.aborted) throw new Error('Stopped.')
        let record = await recordFor(dir, note, lang)
        if (action === 'list') return record
        if (action === 'export') {
          const files = {}
          for (const file of ['record.json', ...MANIFESTS[lang]]) {
            if (await exists(path.join(dir, file))) files[file] = await fs.readFile(path.join(dir, file), 'utf8')
          }
          return { format: 'tulip-environment-v1', language: lang, files }
        }
        if (action === 'reset') {
          if (record.pythonDir) await pythonEnvs.remove(record.pythonDir)
          await fs.rm(dir, { recursive: true, force: true })
          return recordFor(dir, note, lang)
        }
        if (!['add', 'remove', 'update'].includes(action)) throw new Error('Unknown package action.')
        if (imported && !safe(lang, imported)) throw new Error('Invalid import name.')
        const how = { cwd: dir, signal: control.signal }
        record = await setup(dir, note, lang, how)
        if (lang === 'rust' && !await exists(path.join(dir, 'Cargo.toml'))) await rustManifest(dir, 'fn main() {}\n')
        await install(dir, record, name, action, how)
        if (imported) {
          record.mappings[imported] = name
          await save(dir, record)
        }
        return record
      })
    } finally {
      controllers.delete(operation)
    }
  }
  async function relocate (from, to) {
    for (const lang of LANGUAGES) {
      const oldDir = directory(from, lang), newDir = directory(to, lang)
      await locked(oldDir, () => locked(newDir, async () => {
        if (!await exists(oldDir)) return
        if (await exists(newDir)) throw new Error('A package environment already exists for the destination note.')
        await fs.rename(oldDir, newDir)
        await fs.rm(path.join(newDir, 'standalone-source'), { force: true })
        const record = await recordFor(newDir, to, lang)
        record.note = to
        delete record.pythonDir
        await save(newDir, record)
      }))
    }
  }
  async function list () {
    const found = []
    for (const lang of LANGUAGES) {
      const base = path.join(root(), 'code-envs', lang)
      for (const entry of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue
        const record = await json(path.join(base, entry.name, 'record.json'), null)
        if (record?.vault === vault()) found.push(record)
      }
    }
    return found
  }
  return { run, manage, list, relocate, supports: (lang, code) => LANGUAGES.includes(lang) && !(lang === 'python' && hasInlineDeps(code)), stop: (id) => { const c = controllers.get(id); c?.abort(); return !!c }, disposeSync: () => { for (const c of controllers.values()) c.abort() } }
}
module.exports = { makeCodeEnvs, missingImport, safe, LANGUAGES }
