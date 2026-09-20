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
const ok = (r) => r.code === 0 && !r.error && !r.signal && !r.timedOut

/* The tail of a stream, kept as chunks rather than one growing string.
   Rebuilding `(tail + text).slice(-limit)` copies the whole tail for every
   chunk that arrives, so a program writing a megabyte in small pieces pays
   for it hundreds of times over. Chunks are pushed and the front is dropped
   once there is more than a tail's worth; the join happens once, if anyone
   asks. Shared with electron/main.js, which keeps a run's stderr the same
   way for the same reason. */
function tailBuffer (limit) {
  const chunks = []
  let held = 0
  return {
    push (text) {
      chunks.push(text)
      held += text.length
      while (chunks.length > 1 && held - chunks[0].length >= limit) held -= chunks.shift().length
    },
    text () {
      const joined = chunks.length === 1 ? chunks[0] : chunks.join('')
      return joined.length > limit ? joined.slice(-limit) : joined
    }
  }
}

function missingImport (lang, stderr, code) {  let name
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

/* The imports a block declares, read without running it. What the scan finds
   is installed before the first execution — a missing import found at run
   time is found after everything above it has already produced its effects,
   and the retry loop's second execution produces them again. The scan is
   permissive on purpose: a false positive costs an availability probe, never
   a wrong install, because the probe decides. */
const NODE_DECLARED = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]|\b(?:import|from)\s*['"]([^'"]+)['"]/g

function declaredImports (lang, code) {
  const found = new Set()
  if (lang === 'python') {
    for (const line of String(code).split('\n')) {
      const from = /^\s*from\s+([\w.]+)\s+import\b/.exec(line)
      if (from) {
        if (!from[1].startsWith('.')) found.add(from[1].split('.')[0])
        continue
      }
      const list = /^\s*import\s+(.+)/.exec(line)
      if (!list) continue
      for (const part of list[1].split(',')) {
        const name = /^\s*([\w.]+)/.exec(part)?.[1]
        if (name && !name.startsWith('.')) found.add(name.split('.')[0])
      }
    }
  } else if (lang === 'node') {
    for (const match of String(code).matchAll(NODE_DECLARED)) {
      const spec = match[1] || match[2]
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
      // `pkg/sub` is installed and probed as `pkg` — the same read
      // missingImport makes of a 'Cannot find module' line.
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (name && !builtinModules.includes(name)) found.add(name)
    }
  }
  return [...found]
}

/* Which declared names the environment cannot already resolve, asked of the
   language's own resolver in one quiet subprocess before the first
   execution. The python probe runs with the run's env, so PYTHONPATH makes a
   module beside the note count as available — the same rule the retry path's
   local-file check applies. A probe that cannot answer says nothing is
   missing: the run goes ahead and the failure-driven retry below is the
   fallback it has always been. `how.command` is the run's own runner. */
const PY_MISSING = 'import importlib.util, json, sys\nnames = json.loads(sys.argv[-1])\nmissing = []\nfor n in names:\n    try:\n        there = importlib.util.find_spec(n) is not None\n    except Exception:\n        there = False\n    if not there: missing.append(n)\nprint(json.dumps(missing))'
const NODE_MISSING = 'const names = JSON.parse(process.argv.at(-1)), missing = []\nfor (const n of names) { try { require.resolve(n) } catch { missing.push(n) } }\nconsole.log(JSON.stringify(missing))'

async function unavailable (lang, names, dir, how) {
  if (!names.length || !how.command) return new Set()
  const json = JSON.stringify(names)
  const [cmd, args] = lang === 'python' ? [how.python, ['-c', PY_MISSING, '--', json]]
    : lang === 'node' ? ['node', ['-e', NODE_MISSING, '--', json]]
    : []
  if (!cmd) return new Set()
  try {
    const result = await how.command(cmd, args, { ...how, cwd: dir, quiet: true })
    return ok(result) ? new Set(JSON.parse(result.stdout)) : new Set()
  } catch { return new Set() }
}

/* On Windows npm and its kin ship as `.cmd` wrappers, and CreateProcess cannot
   start one without a shell — so automatic installs worked everywhere except
   the platform they were written for. These are the commands launched through
   the command interpreter there. Every argument they receive is either a flag
   written in this file or a package name `safe()` has already refused shell
   syntax for, and each runs with its project directory as `cwd` rather than a
   `--prefix` path, so nothing user-spelled joins the command line. */
const WINDOWS_SHIM_COMMANDS = new Set(['npm', 'npx', 'pnpm', 'yarn'])

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
      let stdout = '', timedOut = false, error = null
      /* How much of a run's output is worth streaming, per stream — the same
         bound unmanaged runs keep in electron/main.js. Without it a program
         printing in a tight loop streams tens of megabytes into the panel
         while it runs out its timeout, and the window that renders all of it
         is the thing that falls over, not the loop. Past the bound the pipe
         is still drained — so the program never blocks on a full buffer —
         but nothing more is sent. */
      const OUT_LIMIT = 1024 * 1024
      let truncated = false
      const sent = { stdout: 0, stderr: 0 }
      const send = (stream, text) => {
        if (sent[stream] >= OUT_LIMIT) return
        const room = OUT_LIMIT - sent[stream]
        const chunk = text.length > room ? text.slice(0, room) : text
        sent[stream] += chunk.length
        if (chunk.length < text.length) truncated = true
        output(stream, chunk)
      }
      /* The tail of stderr, kept rather than only streamed. A traceback is the one
         piece of a run's output the main process has a use for after the fact: it
         is where "no module named x" is said, and installing x is the difference
         between a block that works and one that never can. The tail, not the
         whole, because the interesting line is the last one — and a run that
         printed a megabyte to stderr has not earned a megabyte of retention. */
      const errTail = tailBuffer(64000)
      const shim = process.platform === 'win32' &&
        WINDOWS_SHIM_COMMANDS.has(path.basename(cmd, path.extname(cmd)).toLowerCase())
      const child = spawn(
        shim ? (process.env.ComSpec || 'cmd.exe') : cmd,
        shim ? ['/d', '/s', '/c', cmd, ...args] : args,
        { cwd, env: { ...process.env, PATH: pathFor(), NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }
      )
      const abort = () => killTree(child, 'SIGKILL')
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => { timedOut = true; abort() }, build ? 600000 : timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (text) => {
        if (quiet) stdout = (stdout + text).slice(-2000000)
        else send('stdout', text)
      })
      child.stderr.on('data', (text) => {
        errTail.push(text)
        if (!quiet) send('stderr', text)
      })
      child.on('error', (err) => { error = err.message })
      child.on('close', (code, killed) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        const ms = Date.now() - from
        resolve({ code, signal: signal?.aborted ? 'SIGTERM' : killed, error, timedOut, truncated, errTail: errTail.text(), stdout, ms, buildMs: build ? ms : 0 })
      })
    })
  }
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
    if (lang === 'node' && Object.keys(record.packages).length && !await exists(path.join(dir, 'node_modules'))) await requireCommand('npm', ['ci', '--no-audit', '--no-fund'], { ...how, cwd: dir })
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
        return ['npm', [remove ? 'uninstall' : 'install', '--save-exact', '--no-audit', '--no-fund', name + (update ? '@latest' : '')]]
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
        /* What the source declares is installed before the first execution:
           a missing import found at run time is found after the code above
           it has already run, and re-executing the block runs it again.
           What the scan cannot see — a computed specifier, a conditional
           import, rust/go/julia — still takes the failure-driven path below. */
        if (autoInstall()) {
          try {
            for (const imported of await unavailable(lang, declaredImports(lang, code), dir, { ...how, command })) {
              if (!safe(lang, imported)) continue
              const pkg = record.mappings[imported] || imported
              output('stdout', `\nInstalling ${pkg}…\n`)
              try {
                await install(dir, record, pkg, 'add', how)
              } catch (error) {
                if (control.signal.aborted) return { code: null, signal: 'SIGTERM', ms: 0, buildMs: 0 }
                output('stderr', `Could not install ${pkg}: ${error.message}\nOpen Packages to choose the package that provides ${imported}.\n`)
              }
            }
          } catch { /* the pre-pass fails open — the run and its retry loop are the fallback */ }
        }
        const tried = new Set()
        let total = 0, build = 0
        let warned = false
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
          /* The loop is about to execute the block again: what ran before
             the failed import is not undone by running it a second time.
             The reader is told once, not once per pass. */
          if (!warned) {
            warned = true
            output('stdout', '\nRerunning — the code before the failed import already ran once, and its effects are not undone.\n')
          }
        }
      })
    } catch (error) {
      if (control.signal.aborted) return { code: null, signal: 'SIGTERM', ms: 0, buildMs: 0 }
      throw error
    } finally { controllers.delete(id) }
  }
  /* What an 'import' writes into the environment after the manifests land —
     the native manager's own resolve-and-install for the files just written,
     so an export restores the versions it recorded rather than whatever the
     registry happens to answer today. Where a lockfile came with the export it
     is used; where it did not, the manifest's ranges resolve fresh. */
  async function materialize (dir, lang, how, python) {
    switch (lang) {
      case 'python': {
        const useUv = await pythonEnvs.usesUv()
        const requirements = path.join(dir, 'requirements.txt')
        if (!await exists(requirements)) return
        await requireCommand(useUv ? 'uv' : python,
          useUv ? ['pip', 'install', '--python', python, '-r', requirements] : ['-m', 'pip', 'install', '-r', requirements],
          { ...how, cwd: dir })
        return
      }
      case 'node':
        await requireCommand('npm',
          await exists(path.join(dir, 'package-lock.json'))
            ? ['ci', '--no-audit', '--no-fund']
            : ['install', '--save-exact', '--no-audit', '--no-fund'],
          { ...how, cwd: dir })
        return
      case 'rust':
        /* A build at run time resolves the rest; here it is enough that the
           manifest parses and the lock is current. */
        await requireCommand('cargo', ['generate-lockfile', '--manifest-path', path.join(dir, 'Cargo.toml')], { ...how, cwd: dir })
        return
      case 'go':
        await requireCommand('go', ['mod', 'download'], { ...how, cwd: dir })
        return
      case 'julia':
        await requireCommand('julia', ['--startup-file=no', `--project=${dir}`, '-e', 'using Pkg; Pkg.instantiate()'], { ...how, cwd: dir })
    }
  }

  /**
   * An environment export coming back in — the other half of 'export'.
   *
   * The manifests are trusted as *manifests*: they are text the native manager
   * will parse or refuse, written under names from MANIFESTS and nowhere else.
   * The exported `record.json` is not written at all — it names the source
   * note, its vault and its Python directory, none of which belong to this
   * environment. What is kept from it is `mappings`, the import-name answers
   * that took human effort, each re-checked against `safe`.
   *
   * Importing writes over the manifests that are there and installs what they
   * name; it does not empty the environment first — that is what Reset is
   * for, and an import that fails should not have destroyed what was working.
   */
  async function importEnvironment (dir, note, lang, data, how) {
    if (!data || typeof data !== 'object' || data.format !== 'tulip-environment-v1') {
      throw new Error('That file is not a Tulip environment export.')
    }
    if (data.language !== lang) {
      throw new Error(`That export is for ${data.language || 'another language'} — switch the language above and import it there.`)
    }
    const files = data.files && typeof data.files === 'object' && !Array.isArray(data.files) ? data.files : {}
    const allowed = new Set(['record.json', ...MANIFESTS[lang]])
    for (const [file, contents] of Object.entries(files)) {
      if (!allowed.has(file)) throw new Error(`The export carries “${file}”, which is not part of a ${lang} environment.`)
      if (typeof contents !== 'string' || contents.length > 4 * 1024 * 1024) {
        throw new Error(`The export's ${file} is not readable text.`)
      }
    }
    if (!MANIFESTS[lang].some((file) => typeof files[file] === 'string')) {
      throw new Error('That export holds no manifest to restore.')
    }

    await fs.mkdir(dir, { recursive: true })
    for (const file of MANIFESTS[lang]) {
      if (typeof files[file] === 'string') await fs.writeFile(path.join(dir, file), files[file])
    }

    /* The record is rebuilt for this note and vault; only the import-name
       answers are kept from the one that was exported. Setup is asked first
       because it re-reads the record from disk — mappings merged onto an
       earlier copy would be gone by the time this one is saved. */
    const record = await setup(dir, note, lang, how)
    try {
      const exported = JSON.parse(files['record.json'] || '{}')
      for (const [importedAs, pkg] of Object.entries(exported?.mappings || {})) {
        if (safe(lang, importedAs) && safe(lang, pkg)) record.mappings[importedAs] = pkg
      }
    } catch { /* an unparsable record.json loses the mappings, not the import */ }

    await materialize(dir, lang, how, how.python)
    await snapshot(dir, record, how).catch(() => {})
    await save(dir, record)
    return record
  }

  async function manage (note, lang, action = 'list', name, imported, payload) {
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
        if (action === 'import') {
          const how = { cwd: dir, signal: control.signal }
          return await importEnvironment(dir, note, lang, payload, how)
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
module.exports = { makeCodeEnvs, missingImport, safe, tailBuffer, declaredImports, unavailable }
