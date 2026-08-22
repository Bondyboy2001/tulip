'use strict'

/* ------------------------------------------------- python environments

   A `python` block used to be handed to whatever `python3` the login shell
   found, which made every block in the vault share one interpreter and made
   `import manim` a `ModuleNotFoundError` unless the reader had installed manim
   into that exact interpreter by hand. Two things follow from that and both
   live here: blocks run against an environment Tulip made, and a missing
   import is something to install rather than something to report.

   Environments live under `userData`, never in the vault. A vault is a folder
   of notes somebody syncs, greps and backs up; several hundred megabytes of
   site-packages in it would be an unwelcome surprise in all three. Nothing
   here is precious — an environment deleted behind Tulip's back is rebuilt on
   the next run, which is the same reason no pruner walks these directories
   looking for work to do.

   The unit is the note. That sounds extravagant and is not: `uv` installs by
   reflink out of a shared cache, so the second note wanting numpy costs
   ~0 bytes and ~0.2s, and the download is paid once per machine rather than
   once per note. Measured on APFS, 5 environments with numpy in each came to
   11 MB of real disk where `du` reported 141 MB. Where `uv` is absent that
   bargain is not on offer — pip copies, and copies are real — so the pip
   fallback puts every block in the one shared environment instead. See
   `dirFor`.

   The module takes its dependencies rather than importing them: `app` and the
   runner's PATH belong to main.js, and keeping them out means this file can be
   exercised without Electron. Same arrangement as electron/kernel.js. */

const path = require('node:path')
const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const WINDOWS = process.platform === 'win32'

/* What `-m venv` is run with when there is no uv. Windows ships the launcher
   as `python`; `python3` exists nearly everywhere else and is the one that
   avoids a system Python 2 on the older Unixes that still have one. Getting
   this wrong is invisible until you are on the other platform, because it is
   only reached when uv is absent. */
const SYSTEM_PYTHON = WINDOWS ? 'python' : 'python3'

/* Long enough for a cold, large wheel set on a slow link — manim is ~250 MB of
   dependencies — and short enough that a hung mirror eventually gives up.
   Making an environment is local work and gets far less. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const CREATE_TIMEOUT_MS = 60 * 1000
/* The probe answers in milliseconds or it is not the answer to a question
   worth waiting on; the fallback is a perfectly good installer. */
const PROBE_TIMEOUT_MS = 4000

const digest = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)

const binDir = (dir) => path.join(dir, WINDOWS ? 'Scripts' : 'bin')

/** The interpreter inside an environment. A string, not a promise: after the
 *  first `ensure` this is the whole of the hot path. */
const pythonIn = (dir) => path.join(binDir(dir), WINDOWS ? 'python.exe' : 'python')

/** A console script an environment may have — `manim`, `pytest`. */
const toolIn = (dir, name) => path.join(binDir(dir), WINDOWS ? `${name}.exe` : name)

const exists = (target) => fs.access(target).then(() => true, () => false)

/* Which note an environment belongs to, written inside it when it is made.

   The directory is named after a digest, which is what keeps two notes of the
   same name apart and what makes the name meaningless to a person. Something
   has to carry the note back, or the only honest thing a settings panel could
   say is "17 directories, 4.2 GB, no idea whose". Kept inside the environment
   rather than in one index beside them so it is deleted with what it
   describes and cannot go stale or be raced by two writers. */
const STAMP = 'tulip-env.json'

async function stamp (dir, body) {
  await fs.writeFile(path.join(dir, STAMP), JSON.stringify(body), 'utf8').catch(() => {})
}

async function readStamp (dir) {
  try {
    const held = JSON.parse(await fs.readFile(path.join(dir, STAMP), 'utf8'))
    return held && typeof held === 'object' ? held : null
  } catch {
    return null
  }
}

/* What an environment takes up, as the sum of its files.

   Apparent size, not blocks: `uv` installs by reflink, so the same numpy in
   ten environments is one copy on disk and ten full-size entries in a walk.
   Reporting the true figure per environment is not something a walk can do —
   the sharing is between them — so the number shown is "what this would cost
   on its own", and the panel says as much. */
async function weigh (dir) {
  let total = 0
  const walk = async (at) => {
    let entries
    try { entries = await fs.readdir(at, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      try { total += (await fs.stat(full)).size } catch { /* gone mid-walk */ }
    }
  }
  await walk(dir)
  return total
}

/* ------------------------------------------------------ import → package

   The name in the traceback is the import, and the import is not always the
   thing you install. Everything absent from this table installs under the name
   it was imported by, which is the overwhelmingly common case — the table is
   for the handful where the two genuinely differ. */
const DISTRIBUTIONS = new Map(Object.entries({
  attr: 'attrs',
  bs4: 'beautifulsoup4',
  Crypto: 'pycryptodome',
  cv2: 'opencv-python',
  dateutil: 'python-dateutil',
  docx: 'python-docx',
  dotenv: 'python-dotenv',
  fitz: 'PyMuPDF',
  google: 'protobuf',
  IPython: 'ipython',
  jwt: 'PyJWT',
  OpenGL: 'PyOpenGL',
  PIL: 'Pillow',
  pptx: 'python-pptx',
  serial: 'pyserial',
  skimage: 'scikit-image',
  sklearn: 'scikit-learn',
  usb: 'pyusb',
  wx: 'wxPython',
  yaml: 'PyYAML',
  zmq: 'pyzmq'
}))

/* Python names the module it could not find and nothing else on that line, so
   the quotes are the whole of the parse. The last such line wins: a failed
   import inside a `try` earlier in the run is not what stopped the program —
   which is why this is found from the end rather than by walking every match. */
const MISSING_LABEL = 'ModuleNotFoundError: No module named '
const MISSING = /^ModuleNotFoundError: No module named '([^']+)'/

/* What may be handed to an installer. The traceback is machine-written, but it
   quotes a string the note chose, and a "module" called `--index-url` or
   `;rm -rf ~` must never reach a command line. Anchored, no dots at the edges,
   and a leading dash is unrepresentable — which is the specific thing this is
   here to prevent. */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/* The same rule for what may reach an installer, loosened only by the two
   characters real distribution names use and import names cannot —
   `python-dateutil`, `backports.zoneinfo`. Still anchored, still no leading
   dash. Values from DISTRIBUTIONS pass this by construction; the check is for
   the ones that come straight from a traceback. */
const INSTALLABLE = /^[A-Za-z_][A-Za-z0-9._-]*$/

/* PEP 723 inline script metadata — the standard way a single-file script says
   what it needs:

     # /// script
     # dependencies = ["manim", "numpy==2.1"]
     # ///

   Only the opening fence is looked for. What the block actually contains is
   uv's business, and re-implementing a TOML parser here to second-guess it
   would be two answers to one question. */
const INLINE_DEPS = /^#\s*\/\/\/\s*script\s*$/m

/** Does this source declare its own dependencies? */
const hasInlineDeps = (code) => INLINE_DEPS.test(String(code || ''))

/* What went wrong, from an installer's own account of it.

   Installers wrap their prose to a terminal width nobody here has, so the last
   line of a failure is usually the tail of a sentence — reading it alone
   reported "are unsatisfiable." and nothing about what was unsatisfiable. uv
   marks its conclusion with `╰─▶` and continues it on indented lines; pip has
   no such marker and its last `error:` is the best available. */
const tidy = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 200)

function installerReason (output) {
  const lines = String(output || '').split('\n')

  const at = lines.findIndex((line) => line.includes('╰─▶'))
  if (at >= 0) {
    const held = [lines[at].slice(lines[at].indexOf('╰─▶') + '╰─▶'.length)]
    // Continuations are indented and carry none of the block's own furniture.
    for (let i = at + 1; i < lines.length; i++) {
      if (!/^\s+\S/.test(lines[i]) || /[×╰]|^\s*error:/i.test(lines[i])) break
      held.push(lines[i])
    }
    return tidy(held.join(' '))
  }

  const said = lines.map((line) => line.trim()).filter(Boolean)
  const blamed = [...said].reverse().find((line) => /^error[: ]/i.test(line))
  return tidy((blamed || said.at(-1) || '').replace(/^error:\s*/i, ''))
}

/**
 * The distribution to install for a failed run, or null if the failure was not
 * a missing import.
 *
 * Submodules resolve to their top-level package: `google.protobuf` is not
 * installable, `protobuf` is.
 */
function missingPackage (stderr) {
  if (!stderr) return null
  const text = String(stderr)
  const at = text.lastIndexOf(MISSING_LABEL)
  if (at < 0) return null
  const named = MISSING.exec(text.slice(at))
  if (!named) return null
  // `google.protobuf` is not installable; the package that provides it is.
  const head = named[1].split('.')[0]
  if (!SAFE_NAME.test(head)) return null
  return DISTRIBUTIONS.get(head) || head
}

/**
 * How packages get installed. A configured command carries its own argv; the
 * two probed ones build theirs from the environment's interpreter.
 * @typedef {{kind: 'uv'|'pip'} | {kind: 'custom', argv: string[]}} Installer
 */

/**
 * @param {object} deps
 * @param {() => string} deps.root      where environments live — `userData`
 * @param {() => string} deps.vault     the open vault, or '' if none
 * @param {() => string} deps.pathFor   the PATH a run gets, so a probe here and
 *                                      a run there cannot disagree about which
 *                                      `uv` is installed
 * @param {() => string|null} deps.installerOverride  a configured command, for
 *                                      when the probe guesses wrong
 */
function makePythonEnvs ({ root, vault, pathFor, installerOverride = () => null }) {
  /** Resolved once per launch: the probe is a spawn, and the answer cannot
   *  change under a running app in any way worth re-asking about.
   *  @type {Installer|null} */
  let installer = null

  /** @type {Map<string, Promise<string|null>>}
   *  dir -> promise of a ready environment. Single-flighted because "Run all"
   *  on a note of twenty python blocks would otherwise race twenty `uv venv`
   *  invocations at the same directory. Kept after it settles, so every run
   *  after the first resolves without touching the disk. */
  const ready = new Map()

  /** Which note each environment was made for, so the stamp inside it can say.
   *  Populated by `dirFor`, which is the only thing that knows both. */
  const noteOf = new Map()

  /** `${dir}\n${pkg}` -> the install in flight for it. Two blocks in the same
   *  note failing on the same import at the same moment are one install, not
   *  two writing into one environment at once. */
  const installing = new Map()

  /* --------------------------------------------------------- spawning */

  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {{timeoutMs: number, onOutput?: (text: string) => void}} how
   * @returns {Promise<{ok: boolean, output: string}>}
   */
  function once (cmd, args, how) {
    const { timeoutMs, onOutput } = how
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(cmd, args, {
          env: { ...process.env, PATH: pathFor(), NO_COLOR: '1', PYTHONUNBUFFERED: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        resolve({ ok: false, output: err.message })
        return
      }

      let output = ''
      let settled = false
      /** @type {ReturnType<typeof setTimeout>|null} */
      let timer = null
      const finish = (/** @type {boolean} */ ok) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({ ok, output })
      }

      const read = (/** @type {import('node:stream').Readable} */ stream) => {
        stream.setEncoding('utf8')
        /* Bounded: an installer resolving a large dependency set is chatty, and
           none of it is worth holding in the main process once the tail has
           enough to explain a failure. */
        stream.on('data', (text) => {
          if (output.length < 64_000) output += text
          onOutput?.(text)
        })
        stream.on('error', () => {})
      }
      read(child.stdout)
      read(child.stderr)

      child.on('error', () => finish(false))
      child.on('close', (code) => finish(code === 0))

      timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(false)
      }, timeoutMs)
      timer.unref?.()
    })
  }

  /** `uv` if it is installed, else pip. Probed the same way manim is.
   *  @returns {Promise<Installer>} */
  async function resolveInstaller () {
    if (installer) return installer
    const configured = installerOverride()
    const argv = configured ? String(configured).split(/\s+/).filter(Boolean) : []
    // An override set to blank or to whitespace is not an installer; probe.
    if (argv.length) {
      installer = { kind: 'custom', argv }
      return installer
    }
    const probe = await once('uv', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS })
    installer = probe.ok ? { kind: 'uv' } : { kind: 'pip' }
    return installer
  }

  /* ------------------------------------------------------- addressing */

  const envRoot = () => path.join(root(), 'py-envs')

  const sharedDir = () => path.join(envRoot(), digest(`${vault()}\n:shared`))

  /** An environment of a note's own. The vault is in the digest so the same
   *  note path in two vaults is two environments. */
  const noteDir = (noteRel) => path.join(envRoot(), digest(`${vault()}\n${noteRel}`))

  /**
   * Which environment a block belongs in.
   *
   * A note gets its own only where isolation is close to free — see the note
   * at the top of this file. Under pip it is not free, so everything shares
   * one environment and the cost stays a single install rather than one per
   * note. A block with no note behind it — the chat pane, an unsaved buffer —
   * has no identity to key on and shares too.
   */
  async function dirFor (noteRel) {
    if (!noteRel) return sharedDir()
    const which = await resolveInstaller()
    const dir = which.kind === 'pip' ? sharedDir() : noteDir(noteRel)
    if (dir !== sharedDir()) noteOf.set(dir, noteRel)
    return dir
  }

  /* --------------------------------------------------------- lifecycle */

  /** An environment that exists, made if it did not. Resolves to its
   *  interpreter, or to null if it could not be made — in which case the
   *  caller falls back to the system interpreter and the block still runs. */
  function ensure (dir) {
    const waiting = ready.get(dir)
    if (waiting) return waiting

    const work = (async () => {
      const python = pythonIn(dir)
      if (await exists(python)) return python

      const which = await resolveInstaller()
      /* `--seed` puts pip in the environment. uv does not need it to install,
         but a block that shells out to pip does, and the seed is reflinked out
         of the same cache as everything else. */
      const made = which.kind === 'uv'
        ? await once('uv', ['venv', '--seed', dir], { timeoutMs: CREATE_TIMEOUT_MS })
        : await once(SYSTEM_PYTHON, ['-m', 'venv', dir], { timeoutMs: CREATE_TIMEOUT_MS })

      if (made.ok && await exists(python)) {
        await stamp(dir, { vault: vault(), note: noteOf.get(dir) || null })
        return python
      }
      /* A half-made directory would be taken for a working environment by the
         `exists` check above on the next run, and every run after it. */
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return null
    })()
      .catch(() => null)
      /* A failed attempt is not cached: the reason is usually transient — no
         network, a full disk — and the next Run should try again. */
      .then((python) => {
        if (!python) ready.delete(dir)
        return python
      })

    ready.set(dir, work)
    return work
  }

  /**
   * Put a package in an environment.
   *
   * @param {string} dir
   * @param {string} pkg
   * @param {{onOutput?: (text: string) => void}} [how]
   * @returns {Promise<{ok: boolean, reason?: string}>} whether it is there now,
   *   and if not, the installer's own account of why — "no network" and
   *   "there is no such package" are the same sentence without it.
   */
  async function install (dir, pkg, { onOutput } = {}) {
    /* Belt and braces — `missingPackage` refuses anything else already, but
       this is the function that builds a command line, so it is the one that
       must not be talked into an option. */
    if (!INSTALLABLE.test(pkg)) return { ok: false, reason: `"${pkg}" is not a package name.` }

    const already = installing.get(`${dir}\n${pkg}`)
    if (already) return already

    const work = doInstall(dir, pkg, onOutput)
    installing.set(`${dir}\n${pkg}`, work)
    try {
      return await work
    } finally {
      installing.delete(`${dir}\n${pkg}`)
    }
  }

  async function doInstall (dir, pkg, onOutput) {
    const python = await ensure(dir)
    if (!python) return { ok: false, reason: 'no environment to install into.' }

    const which = await resolveInstaller()
    const [cmd, args] =
      which.kind === 'custom' ? [which.argv[0], [...which.argv.slice(1), pkg]]
      /* `--compile-bytecode` because the very next thing that happens is the
         block being run: uv skips writing `.pyc` by default and leaves the
         cost to the first import, which is the one place here where it lands
         on the reader as an apparently slow program rather than as part of an
         install they were already waiting for. pip does this by default. */
      : which.kind === 'uv' ? ['uv', ['pip', 'install', '--compile-bytecode', '--python', python, pkg]]
      : [python, ['-m', 'pip', 'install', pkg]]

    const result = await once(cmd, args, { timeoutMs: INSTALL_TIMEOUT_MS, onOutput })
    return result.ok ? { ok: true } : { ok: false, reason: installerReason(result.output) }
  }

  /**
   * What a run needs in its environment to be *in* the environment.
   *
   * Naming the interpreter is enough for `import`: it finds its own prefix and
   * its own site-packages. It is not enough for anything the block shells out
   * to. Without these, `subprocess.run(['pip', ...])` reaches the system pip,
   * a console script the note installed is not on PATH, and every tool that
   * decides what it is looking at by reading `VIRTUAL_ENV` decides wrong.
   *
   * This is what `activate` sets, minus the prompt: the two that matter.
   */
  function activation (dir) {
    return {
      VIRTUAL_ENV: dir,
      PATH: `${binDir(dir)}${path.delimiter}${pathFor()}`
    }
  }

  /** A console script inside an environment, if that environment has one.
   *  How a note that installed manim gets manim rather than the system's. */
  async function tool (dir, name) {
    const target = toolIn(dir, name)
    return (await exists(target)) ? target : null
  }

  /* ---------------------------------------------------------- cleanup

     An environment is derived, so losing one costs a rebuild and nothing else.
     These are called from the same places every other per-note store is, and
     failure is deliberately quiet: a note must still delete when its
     environment will not. */

  function forget (noteRel) {
    const dir = noteDir(noteRel)
    ready.delete(dir)
    return fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  /**
   * A note has moved, so its environment is discarded rather than carried.
   *
   * Carrying it looks obvious and does not work: a virtual environment is not
   * relocatable. `bin/python` survives a move — it resolves its prefix from
   * where it finds itself — but every console script beside it was written
   * with an absolute shebang, so a renamed note's `manim` fails with
   * `bad interpreter: …/bin/python: no such file or directory`, naming a path
   * that no longer exists, at the moment the reader is least expecting it.
   *
   * Discarding costs a rebuild on the next run and the rebuild is not
   * expensive: the packages are already in the installer's cache, which is
   * where the time and the bytes actually went. Measured at ~0.2s to put manim
   * back into a fresh environment.
   */
  async function relocate (from, to) {
    await Promise.all([forget(from), forget(to)])
  }

  /* ------------------------------------------------------------ managing

     Environments are invisible by design — nobody should have to think about
     them — but invisible and unmanageable are different things. One that has
     gone wrong needs a way to be thrown away, and a vault worked in for a year
     needs a way to see where the disk went. */

  /**
   * Every environment under this app, newest question first: whose it is, what
   * it holds, and whether this vault still has the note it was made for.
   *
   * @param {Set<string>|null} liveNotes  the notes that currently exist, so an
   *   environment can be reported as orphaned. Null means "do not judge".
   */
  async function list (liveNotes = null) {
    let names
    try { names = await fs.readdir(envRoot(), { withFileTypes: true }) } catch { return [] }

    const here = vault()
    const shared = sharedDir()
    const found = await Promise.all(names
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(envRoot(), entry.name)
        const held = await readStamp(dir)
        const isShared = dir === shared
        const mine = isShared || held?.vault === here
        /* Orphaned is only ever said about this vault's own notes. Another
           vault's environments are not this vault's business to judge, and a
           vault that is not open cannot be asked what it still contains. */
        const orphaned = !!(mine && !isShared && held?.note && liveNotes && !liveNotes.has(held.note))
        return {
          dir,
          note: isShared ? null : (held?.note || null),
          vault: held?.vault ?? null,
          shared: isShared,
          mine,
          orphaned,
          /* A stamp is written when an environment is made. One without it was
             made by a version that did not write them, or interrupted — either
             way its note cannot be recovered, and saying so is better than
             guessing. */
          unknown: !held,
          bytes: await weigh(dir)
        }
      }))
    return found.sort((a, b) => b.bytes - a.bytes)
  }

  /** Throw one away. It is rebuilt, empty, on the next run that needs it. */
  async function remove (dir) {
    /* Only ever inside the root this module owns — the path comes from a
       renderer, and `py-envs/../../..` is a directory somebody's notes are in. */
    const resolved = path.resolve(dir)
    const root = path.resolve(envRoot())
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return false
    if (resolved === root) return false
    ready.delete(resolved)
    await fs.rm(resolved, { recursive: true, force: true })
    return true
  }

  /** Whether `uv` is what would do the installing — which is also whether a
   *  script declaring its own dependencies can be honoured. */
  const usesUv = async () => (await resolveInstaller()).kind === 'uv'

  /** Said when the vault changes: the digests are of a different vault now. */
  const reset = () => ready.clear()

  /* `noteDir` stays inside: callers ask through `dirFor`, which is the one
     place that knows whether a note gets an environment of its own or shares
     the pool. Handing out the raw address would let a caller answer that
     question differently. */
  return {
    dirFor, sharedDir, ensure, install, tool, activation, usesUv,
    list, remove, forget, relocate, reset
  }
}

module.exports = { makePythonEnvs, missingPackage, hasInlineDeps, installerReason, pythonIn }
