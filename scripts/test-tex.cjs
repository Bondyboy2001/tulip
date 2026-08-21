'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  createTexCompiler, directives, inside, resolveRoot, commandFor, usefulError,
  needsForcedRetry
} = require('../electron/tex-compile')

;(async () => {
  assert.deepEqual(
    directives('% !TEX root = ../main.tex\n% !TEX program = xelatex\n'),
    { root: '../main.tex', engine: 'xelatex' }
  )
  assert.equal(directives('% !TeX program = LuaTeX').engine, 'lualatex')
  /* The engine a document does not name is the one chosen in settings — and a
     document that does name one still gets it, whatever the setting says. */
  assert.equal(directives('\\documentclass{article}').engine, 'pdflatex')
  assert.equal(directives('\\documentclass{article}', 'xelatex').engine, 'xelatex')
  assert.equal(directives('% !TEX program = lualatex', 'xelatex').engine, 'lualatex')
  assert.equal(directives('', 'nonsense').engine, 'pdflatex')
  assert.equal(inside('/tmp/vault', '/tmp/vault/Papers/main.tex'), true)
  assert.equal(inside('/tmp/vault', '/tmp/vault-other/main.tex'), false)
  assert.match(usefulError('noise\n! Undefined control sequence.\nmore'), /Undefined control sequence/)
  assert.equal(
    usefulError('/a/very/long/path/main.tex:19: Undefined co\nntrol sequence.\nlatexmk advice'),
    'main.tex:19: Undefined control sequence.'
  )
  assert.equal(needsForcedRetry('pdflatex: gave an error in previous invocation'), true)
  assert.equal(needsForcedRetry('main.tex:19: Undefined control sequence.'), false)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-tex-'))
  try {
    const vault = path.join(dir, 'vault')
    const chapter = path.join(vault, 'chapters')
    const cache = path.join(dir, 'cache')
    await fs.mkdir(chapter, { recursive: true })
    await fs.writeFile(path.join(vault, 'main.tex'), '% !TEX program = lualatex\n\\documentclass{article}\n')
    await fs.writeFile(path.join(chapter, 'one.tex'), '% !TEX root = ../main.tex\nChapter\n')
    const project = await resolveRoot(path.join(chapter, 'one.tex'), vault)
    assert.equal(project.root, await fs.realpath(path.join(vault, 'main.tex')))
    assert.equal(project.engine, 'lualatex')

    /* A chapter that names its engine, under a root that does not: the
       chapter's answer stands. The root used to overrule it with its own
       built-in default, which is not an answer anybody gave. */
    await fs.writeFile(path.join(vault, 'plain.tex'), '\\documentclass{article}\n')
    await fs.writeFile(
      path.join(chapter, 'two.tex'),
      '% !TEX root = ../plain.tex\n% !TEX program = xelatex\n'
    )
    const named = await resolveRoot(path.join(chapter, 'two.tex'), vault)
    assert.equal(named.engine, 'xelatex')
    // And with nothing named anywhere, the setting decides.
    await fs.writeFile(path.join(chapter, 'three.tex'), '% !TEX root = ../plain.tex\n')
    const settled = await resolveRoot(path.join(chapter, 'three.tex'), vault, 'lualatex')
    assert.equal(settled.engine, 'lualatex')

    const fakeEnv = { PATH: path.join(dir, 'bin') }
    await fs.mkdir(fakeEnv.PATH)
    for (const name of ['latexmk', 'pdflatex']) {
      const file = path.join(fakeEnv.PATH, name)
      await fs.writeFile(file, '#!/bin/sh\n')
      await fs.chmod(file, 0o755)
    }
    const command = commandFor({ root: project.root, engine: project.engine, output: cache, env: fakeEnv })
    assert.equal(command.args[0], '-norc')
    assert.equal(command.args.includes('-g'), false)
    assert.ok(command.args.includes('-lualatex'))
    assert.ok(command.args.some((arg) => arg.includes('lualatex -no-shell-escape')))
    assert.equal(command.args.at(-1), 'main.tex')
    assert.equal(command.args.includes(project.root), false)

    const compiler = createTexCompiler({
      vault,
      cacheRoot: cache,
      env: fakeEnv,
      runner: async ({ args, onChild }) => {
        onChild({ kill () {} })
        const outdir = args.find((arg) => arg.startsWith('-outdir=')).slice('-outdir='.length)
        await fs.mkdir(outdir, { recursive: true })
        await fs.writeFile(path.join(outdir, 'main.pdf'), '%PDF-1.7 test')
        return { code: 0, log: 'ok' }
      }
    })
    const result = await compiler.compile(path.join(chapter, 'one.tex'))
    assert.equal(result.root, 'main.tex')
    assert.match(result.artifact, /^[a-f0-9]{20}\/main\.pdf$/)

    const calls = []
    const recovering = createTexCompiler({
      vault,
      cacheRoot: path.join(dir, 'recovery-cache'),
      env: fakeEnv,
      runner: async ({ args, onChild }) => {
        onChild({ kill () {} })
        calls.push(args)
        if (calls.length === 1) {
          return { code: 12, log: 'pdflatex: gave an error in previous invocation of latexmk.' }
        }
        const outdir = args.find((arg) => arg.startsWith('-outdir=')).slice('-outdir='.length)
        await fs.mkdir(outdir, { recursive: true })
        await fs.writeFile(path.join(outdir, 'main.pdf'), '%PDF-1.7 recovered')
        return { code: 0, log: 'ok' }
      }
    })
    await recovering.compile(path.join(chapter, 'one.tex'))
    assert.equal(calls.length, 2)
    assert.equal(calls[0].includes('-g'), false)
    assert.equal(calls[1].includes('-g'), true)

    let staleKills = 0
    const failing = createTexCompiler({
      vault,
      cacheRoot: path.join(dir, 'failure-cache'),
      env: fakeEnv,
      runner: async ({ onChild }) => {
        onChild({ kill: () => { staleKills++ } })
        throw new Error('runner failed')
      }
    })
    await assert.rejects(failing.compile(path.join(chapter, 'one.tex')), /runner failed/)
    failing.stop()
    assert.equal(staleKills, 0, 'a failed runner does not leave a stale active child')

    let releaseFirst
    let running = 0
    let peakRunning = 0
    let callsStarted = 0
    const serial = createTexCompiler({
      vault,
      cacheRoot: path.join(dir, 'serial-cache'),
      env: fakeEnv,
      runner: ({ args, onChild }) => new Promise((resolve) => {
        callsStarted++
        running++
        peakRunning = Math.max(peakRunning, running)
        let finished = false
        const finish = async (code) => {
          if (finished) return
          finished = true
          if (code === 0) {
            const outdir = args.find((arg) => arg.startsWith('-outdir=')).slice('-outdir='.length)
            await fs.mkdir(outdir, { recursive: true })
            await fs.writeFile(path.join(outdir, 'main.pdf'), '%PDF-1.7 newest')
          }
          running--
          resolve({ code, log: code ? 'cancelled' : 'ok' })
        }
        onChild({ kill: () => finish(143) })
        if (callsStarted === 1) releaseFirst = () => finish(0)
        else finish(0)
      })
    })
    const oldCompile = serial.compile(path.join(chapter, 'one.tex'))
    while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve))
    const newCompile = serial.compile(path.join(chapter, 'one.tex'))
    await assert.rejects(oldCompile, /cancelled/)
    await newCompile
    assert.equal(peakRunning, 1, 'superseded TeX processes must not overlap')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }

  console.log('tex: all checks passed')
})().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
