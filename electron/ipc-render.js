'use strict'

/* ------------------------------------------------------------ rendering

   The three "turn a block into a real file" features, which share one shape:
   the rendered artefact lives beside the note as an attachment, and is named
   after a hash of what produced it — which is the whole caching story, so a
   rendered block opens with its file already there and an edited one asks for
   a name nothing has written yet.

   - `tex:compile` — a TeX document compiled to a preview PDF by
     electron/tex-compile.js, cached per vault.
   - `manim:render` — a scene rendered to video by manim, streaming progress
     into the run pane.
   - `tikz:render` — a drawing typeset by latex and converted by dvisvgm, run
     as one two-command job.

   The last two *are* runs: they allocate a run id, stream into `run:out` and
   answer on `run:done`, so the run machinery (allocation, start, kill,
   timeout) crosses the context boundary as the named seams below rather than
   being re-made here. Everything else that belongs to the rest of main —
   paths, the self-write bookkeeping, the vault snapshot, the config — crosses
   the same way.
   ================================================================== */

const { ipcMain } = require('electron')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { ATTACHMENT_DIR, isTex } = require('./vault-kinds')

/**
 * @param {{
 *   safePath: (relOrAbs: string) => string,
 *   realSafePath: (relOrAbs: string) => Promise<string>,
 *   sha1: (text: string, chars?: number) => string,
 *   assertReal: (from: string) => Promise<void>,
 *   rel: (abs: string) => string,
 *   noteSelfWrite: (abs: string, stamp?: string | null) => void,
 *   invalidateVaultSnapshot: () => void,
 *   getVaultPath: () => string | null,
 *   readConfig: () => Record<string, any>,
 *   ensureLoginPath: () => Promise<void>,
 *   ensureFallbackPaths: () => Promise<void>,
 *   runnerPath: () => string,
 *   pythonEnvs: { sharedDir: () => string, tool: (dir: string, name: string) => Promise<string|null>, install: (dir: string, name: string, opts?: any) => Promise<{ok: boolean, reason?: string}> },
 *   mayInstallPython: () => boolean,
 *   toRun: (channel: string, payload: unknown) => void,
 *   ownRun: (id: number, event: Electron.IpcMainInvokeEvent) => void,
 *   startRun: (id: number, cmd: string, args: string[], opts?: any) => Promise<{code: number|null, ms: number, error?: string}>,
 *   runTimeoutMs: (key: string, fallback: number) => number,
 *   nextRunId: () => number,
 *   cancelled: Set<number>,
 *   discard: (dir: string) => Promise<void>,
 *   texPreviewDir: () => string
 * }} ctx
 */
function makeRenderDomain (ctx) {
  const {
    safePath, realSafePath, sha1, assertReal, rel, noteSelfWrite, invalidateVaultSnapshot,
    getVaultPath, readConfig, ensureLoginPath, ensureFallbackPaths, runnerPath, pythonEnvs,
    mayInstallPython, toRun, ownRun, startRun, runTimeoutMs, nextRunId, cancelled,
    discard, texPreviewDir
  } = ctx

  /* ------------------------------------------------- the artefact cache

   * Where a note's rendered artefacts live, and what one is called.
   *
   * The digest is 10 characters rather than sha1's usual 16 here, and has to
   * stay so: it is baked into every file already rendered into a vault, and
   * lengthening it would silently orphan all of them.
   */
  async function artefactTarget (noteName, kind, seed, ext) {
    const folder = path.join(ATTACHMENT_DIR, String(noteName || 'Untitled').replace(/[/\\]/g, '-'))
    const target = safePath(path.join(folder, `${kind}-${sha1(seed, 10)}.${ext}`))
    await assertReal(target)
    return target
  }

  /** Is this block already rendered? Answered without running anything, so the
   *  reading view can show the result the moment the note opens. */
  async function artefactAt (target) {
    if (!getVaultPath()) return null
    try {
      await fs.access(target)
      return rel(target)
    } catch {
      return null
    }
  }

  /** A finished render, moved into the vault. Copied rather than renamed: the
   *  temp dir is often on a different volume, where rename fails outright. */
  async function keepArtefact (produced, target) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    /* The app's own write, so the watcher does not report it back as an outside
       change and set off a full vault walk plus a backlink scan for a picture
       Tulip drew itself. Stamped on both sides of the copy: the window has to be
       open when the event is actually generated. */
    noteSelfWrite(target)
    await fs.copyFile(produced, target)
    noteSelfWrite(target)
    // A new file in the vault; the note embeds it as soon as this returns.
    invalidateVaultSnapshot()
  }

  /* ---------------------------------------------------------------- manim
     A ```manim block is a scene, and what a scene is *for* is the video. So it
     renders to a real file in the vault and the reading view shows that instead
     of the code. Nothing is written into the .md — the note keeps saying what
     you wrote, and the video sits beside it as an attachment. */

  const MANIM_TIMEOUT_MS = 5 * 60 * 1000

  /** Manim CE's quality flags, smallest first. Medium is 720p30. */
  const MANIM_QUALITIES = new Set(['l', 'm', 'h', 'p', 'k'])

  const manimTarget = (noteName, code, quality) =>
    artefactTarget(noteName, 'manim', `${quality}\n${code}`, 'mp4')

  /**
   * The scene to render. Manim asks interactively when a file holds several and
   * none was named, which would hang a run forever with nobody to answer — so one
   * is always chosen here. The fence may name it (```manim MyScene); otherwise
   * the last class in the block wins, which is the one people write last and mean.
   */
  function sceneName (code, requested) {
    if (requested && /^[A-Za-z_]\w*$/.test(requested)) return requested
    const found = [...code.matchAll(/^\s*class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/gm)]
      .filter((m) => /Scene\b/.test(m[2]))
      .map((m) => m[1])
    return found.length ? found[found.length - 1] : null
  }

  /** The newest .mp4 anywhere under `dir` — manim's own layout is a deep tree
   *  whose shape has changed between releases, so the file is found, not guessed. */
  async function newestVideo (dir) {
    /** @type {{ abs: string, mtime: number } | null} */
    let best = null
    const walk = async (at) => {
      let entries
      try { entries = await fs.readdir(at, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const abs = path.join(at, entry.name)
        if (entry.isDirectory()) { await walk(abs); continue }
        if (path.extname(entry.name).toLowerCase() !== '.mp4') continue
        // Manim writes partial clips into a `partial_movie_files` folder and
        // stitches them; the assembled scene is the one outside it.
        if (abs.includes('partial_movie_files')) continue
        const stat = await fs.stat(abs).catch(() => null)
        if (stat && (!best || stat.mtimeMs > best.mtime)) best = { abs, mtime: stat.mtimeMs }
      }
    }
    await walk(dir)
    // The assignment happens inside the walk closure, which flow analysis
    // cannot see — so the declared shape is asserted here.
    const found = /** @type {{ abs: string, mtime: number } | null} */ (best)
    return found ? found.abs : null
  }

  /** Manim on the PATH, else the module under python3 — both are normal installs. */
  /** Is manim on the PATH a render will use? */
  function systemManim () {
    return new Promise((resolve) => {
      // The same PATH a run gets, so the probe and the render cannot disagree
      // about which manim is installed.
      const probe = spawn('manim', ['--version'], {
        stdio: 'ignore',
        env: { ...process.env, PATH: runnerPath() }
      })
      probe.on('error', () => resolve(false))
      probe.on('close', (code) => resolve(code === 0))
    })
  }

  /**
   * What to invoke to render a scene.
   *
   * A manim installed on the machine is preferred over one Tulip installed: it
   * is the one the reader chose, and on this machine it is commonly a `uv tool`
   * that works perfectly while `python3 -m manim` — the old fallback — cannot
   * see it at all. Tulip's own copy is for the machine that has no manim, where
   * the alternative is a block that can never render.
   *
   * @param {{id?: number}} [reporting]  a run to stream an install into
   */
  async function manimCommand (reporting = {}) {
    const configured = readConfig().manimCommand
    if (configured) return String(configured).split(/\s+/)
    // The probe is the first thing a render does, so it is also where the login
    // shell's PATH has to have arrived.
    await ensureLoginPath()
    await ensureFallbackPaths()

    const shared = pythonEnvs.sharedDir()
    const mine = await pythonEnvs.tool(shared, 'manim')
    if (mine) return [mine]

    if (await systemManim()) return ['manim']

    if (mayInstallPython()) {
      const { id } = reporting
      if (id) toRun('run:out', { id, stream: 'stdout', text: '\nInstalling manim…\n' })
      const done = await pythonEnvs.install(shared, 'manim', {
        onOutput: (text) => { if (id) toRun('run:out', { id, stream: 'stdout', text }) }
      })
      if (!done.ok && id && done.reason) {
        toRun('run:out', { id, stream: 'stderr', text: `Could not install manim. ${done.reason}\n` })
      }
      const installed = done.ok && await pythonEnvs.tool(shared, 'manim')
      if (installed) return [installed]
    }

    /* Nothing found and nothing installed. The old fallback stands, because on a
       machine where manim is a library in the system interpreter it is right —
       and where it is not, its failure names manim, which is the useful thing to
       put in front of the reader. */
    return ['python3', '-m', 'manim']
  }

  function manimQuality () {
    const q = String(readConfig().manimQuality || 'm').toLowerCase()
    return MANIM_QUALITIES.has(q) ? q : 'm'
  }

  /* ---------------------------------------------------------------- tikz
     A ```tikz block is a picture, and what a picture is *for* is the drawing —
     so it renders to a real file in the vault and both views show that instead
     of the source. Cheaper than a scene — a second or two rather than minutes —
     but far too slow to redraw on every keystroke the way mermaid does, and it
     needs a TeX installation, which is exactly why the result is kept. */

  const TIKZ_TIMEOUT_MS = 90 * 1000

  const tikzTarget = (noteName, code) => artefactTarget(noteName, 'tikz', code, 'svg')

  /* Commands LaTeX will only accept before \begin{document}. A block is written
     as a picture, not as a document, so anything of this kind found in one is
     meant for the preamble the block never sees — and is lifted into it below.
     \usetikzlibrary and friends are legal in both places, but they are listed
     here anyway so that a block's libraries load in the order it wrote them,
     alongside the packages they may belong to. */
  const PREAMBLE_ONLY =
    /^\s*\\(usepackage|RequirePackage|usetikzlibrary|usepgflibrary|usepgfplotslibrary|pgfplotsset)\b/

  /**
   * Splits a block into the lines that belong in the preamble and the lines that
   * are the drawing, keeping the order within each.
   *
   * Line-based on purpose: `\usepackage[options]{name}` is written on one line by
   * everyone, and a scanner that balanced braces across lines would have to
   * understand comments and verbatim to be right rather than nearly right.
   */
  function liftPreamble (code) {
    const head = []
    const body = []
    for (const line of code.split('\n')) {
      (PREAMBLE_ONLY.test(line) ? head : body).push(line)
    }
    return { head, body }
  }

  /**
   * The block, as a document LaTeX will accept.
   *
   * A block that brings its own \documentclass is left alone — someone doing that
   * has a reason. Everything else is a picture, and gets the standard wrapper for
   * one: `standalone` crops the page to the drawing, and pgf is pointed at its
   * dvisvgm backend before TikZ loads, which is what makes the DVI convertible.
   * A handful of the most-used libraries come along.
   *
   * Anything the block asks for arrives *after* those, so `\usepackage{pgfplots}`
   * in a block behaves as it would at the top of a real document: the block can
   * load whatever the TeX installation has, and can configure it, without having
   * to write out a whole document to do it.
   */
  function tikzDocument (code) {
    if (/\\documentclass/.test(code)) return code
    const { head, body } = liftPreamble(code)
    return [
      '\\documentclass[border=4pt]{standalone}',
      '\\def\\pgfsysdriver{pgfsys-dvisvgm.def}',
      '\\usepackage{tikz}',
      '\\usetikzlibrary{arrows.meta,positioning,calc,shapes,patterns,decorations.pathreplacing}',
      ...head,
      '\\begin{document}',
      ...body,
      '\\end{document}'
    ].join('\n')
  }

  /** The two commands a drawing goes through, either as configured or as found. */
  function tikzCommands () {
    const configured = readConfig().tikzCommand
    const latex = configured ? String(configured).split(/\s+/) : ['latex']
    return { latex, dvisvgm: ['dvisvgm'] }
  }

  /**
   * TeX with the doors that can be shut, shut.
   *
   * A picture draws itself when the note is read, which means TeX runs on
   * whatever a note contains before anyone has looked at it — and a note is not
   * always something the reader wrote. Vaults are synced, shared, cloned from a
   * repository, handed over as a folder of somebody's lecture notes. TeX is a
   * full macro language with file and process access, so opening a note was
   * enough to run a command outright on the many installations where
   * `shell_escape` is enabled in `texmf.cnf`.
   *
   * `shell_escape=f`, with `-no-shell-escape` on the command line beside it,
   * closes that: `\write18` is refused, and the flag also overrides a
   * `-shell-escape` that a configured `tikzCommand` carries. Both were tested
   * against a block that tries it; neither lets it through.
   *
   * `openin_any`/`openout_any` are set for the installations that honour them,
   * but they are **not** load-bearing and must not be relied on: measured
   * against MacTeX's `latex`, `openin_any=p` did not prevent `\openin` from
   * reading an absolute path, or a path inside a dot-directory — all three of
   * `a`, `r` and `p` behaved identically. kpathsea reports the value correctly
   * (`kpsewhich --var-value=openin_any` answers `p`), so the setting arrives and
   * the engine simply does not enforce it for reads.
   *
   * What guards reading is therefore in the renderer, not here: a block that
   * asks to open files is not drawn on sight — see `READS_FILES` in src/tikz.js.
   * Pressing Draw still runs it, because at that point a person has asked.
   */
  const TEX_SANDBOX_ENV = { openin_any: 'p', openout_any: 'p', shell_escape: 'f' }

  /* LaTeX says what went wrong in the middle of a great deal of noise. The lines
     worth showing are the error itself and the line of the document it stopped
     on, which is what a reader needs to find it in the block. */
  function texTrouble (log) {
    const lines = log.split('\n')
    const kept = []
    for (let i = 0; i < lines.length && kept.length < 12; i++) {
      if (!/^(!|l\.\d+|<recently read>)/.test(lines[i])) continue
      kept.push(lines[i].trimEnd())
    }
    return kept.join('\n')
  }

  /* --------------------------------------------------------- TeX preview */

  /** @type {any} */
  let texCompiler = null
  /** @type {string | null} */
  let texCompilerVault = ''

  function register () {
    ipcMain.handle('tex:compile', async (_e, p) => {
      if (!getVaultPath()) return { ok: false, error: 'Open a vault first.' }
      let abs
      try { abs = await realSafePath(p) } catch (err) {
        return { ok: false, error: err.message || 'That TeX file is not available.' }
      }
      if (!isTex(abs)) return { ok: false, error: 'Only TeX files can be compiled.' }

      if (!texCompiler || texCompilerVault !== getVaultPath()) {
        texCompiler?.stop()
        texCompilerVault = getVaultPath()
        const { createTexCompiler } = require('./tex-compile')
        texCompiler = createTexCompiler({
          vault: getVaultPath(),
          cacheRoot: texPreviewDir(),
          // Read per compile, not captured here: the compiler outlives a trip to
          // the settings pane, and the engine chosen there has to take effect on
          // the next compile rather than the next vault.
          engine: () => readConfig().texEngine || 'pdflatex'
        })
      }
      try {
        const result = await texCompiler.compile(abs)
        return {
          ok: true,
          url: `tulip-file://tex-preview/${result.artifact}?v=${Date.now()}`,
          root: result.root,
          compiler: result.compiler,
          log: result.log
        }
      } catch (err) {
        return { ok: false, error: err.message || 'LaTeX could not compile this document.', log: err.log || '' }
      }
    })

    ipcMain.handle('manim:lookup', async (_e, noteName, code, scene) => {
      const found = await artefactAt(await manimTarget(noteName, code, manimQuality()))
      return found ? { path: found, scene: sceneName(code, scene) } : null
    })

    ipcMain.handle('manim:render', async (event, noteName, code, scene) => {
      if (!getVaultPath()) throw new Error('Open a vault first — the video is saved into it.')
      if (typeof code !== 'string' || !code.trim()) throw new Error('Nothing to render.')

      const name = sceneName(code, scene)
      if (!name) throw new Error('No Scene class found in this block.')

      const quality = manimQuality()
      const target = await manimTarget(noteName, code, quality)
      const id = nextRunId()
      ownRun(id, event)
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-manim-'))

      // Started before the work so the page can show progress and offer a Stop.
      queueMicrotask(() => toRun('run:out', {
        id, stream: 'stdout', text: `Rendering ${name}…\n`
      }))

      const finish = async () => {
        const file = path.join(dir, 'scene.py')
        await fs.writeFile(file, code, 'utf8')

        const [cmd, ...lead] = await manimCommand({ id })
        const result = await startRun(
          id,
          cmd,
          [...lead, 'render', '--media_dir', path.join(dir, 'media'),
            '--format', 'mp4', '--quality', quality, file, name],
          { cwd: dir, timeoutMs: runTimeoutMs('manimTimeout', MANIM_TIMEOUT_MS) }
        )
        // A render is one command, so nothing reads this flag afterwards — but a
        // stopped render would otherwise leave its id in the set for good.
        cancelled.delete(id)

        if (result.error || result.code !== 0) {
          await discard(dir)
          return { ...result, path: null }
        }

        const produced = await newestVideo(path.join(dir, 'media'))
        if (!produced) {
          await discard(dir)
          return { ...result, path: null, error: 'Manim finished but produced no video.' }
        }

        await keepArtefact(produced, target)
        await discard(dir)
        return { ...result, path: rel(target) }
      }

      finish()
        .catch((err) => ({ code: null, ms: 0, error: err.message, path: null }))
        .then((result) => toRun('run:done', { id, ...result }))

      return { id, scene: name, quality }
    })

    ipcMain.handle('tikz:lookup', async (_e, noteName, code) => {
      const found = await artefactAt(await tikzTarget(noteName, code))
      return found ? { path: found } : null
    })

    ipcMain.handle('tikz:render', async (event, noteName, code) => {
      if (!getVaultPath()) throw new Error('Open a vault first — the drawing is saved into it.')
      if (typeof code !== 'string' || !code.trim()) throw new Error('Nothing to draw.')

      const target = await tikzTarget(noteName, code)
      const id = nextRunId()
      ownRun(id, event)
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-tikz-'))
      const timeoutMs = runTimeoutMs('tikzTimeout', TIKZ_TIMEOUT_MS)

      queueMicrotask(() => toRun('run:out', { id, stream: 'stdout', text: 'Drawing…\n' }))

      const finish = async () => {
        await ensureLoginPath()
        await ensureFallbackPaths()
        await fs.writeFile(path.join(dir, 'figure.tex'), tikzDocument(code), 'utf8')
        const { latex, dvisvgm } = tikzCommands()

        /* Two commands, one run: TeX turns the block into a DVI and dvisvgm turns
           the DVI into the picture. They share an id so that Stop stops whichever
           is going, and so the page sees one piece of work rather than two. */
        const typeset = await startRun(
          id, latex[0],
          [...latex.slice(1), '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'figure.tex'],
          { cwd: dir, timeoutMs, env: TEX_SANDBOX_ENV }
        )
        if (typeset.error || typeset.code !== 0) {
          const log = await fs.readFile(path.join(dir, 'figure.log'), 'utf8').catch(() => '')
          await discard(dir)
          cancelled.delete(id)
          return { ...typeset, path: null, error: typeset.error || texTrouble(log) || null }
        }

        const convert = await startRun(
          id, dvisvgm[0],
          [...dvisvgm.slice(1), '--no-fonts', '--exact-bbox', '--output=figure.svg', 'figure.dvi'],
          { cwd: dir, timeoutMs }
        )
        cancelled.delete(id)
        if (convert.error || convert.code !== 0) {
          await discard(dir)
          return { ...convert, path: null }
        }

        const produced = path.join(dir, 'figure.svg')
        if (!fsSync.existsSync(produced)) {
          await discard(dir)
          return { ...convert, path: null, error: 'TeX finished but produced no drawing.' }
        }

        await keepArtefact(produced, target)
        await discard(dir)
        return { ...convert, path: rel(target) }
      }

      finish()
        .catch((err) => ({ code: null, ms: 0, error: err.message, path: null }))
        .then((result) => toRun('run:done', { id, ...result }))

      return { id }
    })
  }

  return { register }
}

module.exports = { makeRenderDomain }
