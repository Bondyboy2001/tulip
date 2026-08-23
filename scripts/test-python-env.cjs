'use strict'

/* ============================================== python environments and pip
   What a `python` block runs against, and what happens when the import it
   needs is not installed — see electron/python-env.js.

   Two things here are worth testing directly because both fail quietly.

   The traceback parse decides what gets handed to an installer. A name it
   reads wrongly is a package that cannot be found, which looks like a network
   problem; a name it fails to *refuse* is a command line built out of a string
   the note chose, which looks like nothing at all until it matters. The
   refusals are asserted at least as carefully as the successes.

   The lifecycle is asserted against real directories rather than mocks: the
   whole point of the module is what it does to a filesystem, and a mock would
   have agreed with every version of `relocate` this file has had, including
   the one that renamed environments and broke every console script in them.

   Making an environment is local and fast, so it is always tested. *Installing*
   into one is a request to PyPI, and a test suite that reaches the network is
   a test suite that fails on a train — worse here than elsewhere, because a
   package that resolves slowly holds a ten-minute timeout open while the other
   forty tests wait for a core. Those few run under TULIP_NET_TESTS=1 and are
   skipped, loudly, otherwise.
*/

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  makePythonEnvs, missingPackage, hasInlineDeps, installerReason, pythonIn
} = require('../electron/python-env')

/* Everything that has to fetch a package. Off by default — see the note above.
   `npm run test:python-env:net` turns them on. */
const NET = process.env.TULIP_NET_TESTS === '1'
let skipped = 0
const netOk = (what, fn) => {
  if (NET) return ok(what, fn)
  skipped++
  console.log(`skip - ${what} (needs the network; TULIP_NET_TESTS=1 to run)`)
  return Promise.resolve()
}

let passed = 0
function ok (what, fn) {
  const done = fn()
  if (done instanceof Promise) return done.then(() => { passed++; console.log(`ok - ${what}`) })
  passed++
  console.log(`ok - ${what}`)
  return Promise.resolve()
}

/* ------------------------------------------------------ reading a traceback */

const TRACEBACK = `Traceback (most recent call last):
  File "/tmp/tulip-run-x/block.py", line 1, in <module>
    import numpy as np
ModuleNotFoundError: No module named 'numpy'
`

ok('the missing module is read out of a real traceback', () => {
  assert.equal(missingPackage(TRACEBACK), 'numpy')
})

ok('an import name that differs from its package is mapped', () => {
  assert.equal(missingPackage("ModuleNotFoundError: No module named 'cv2'"), 'opencv-python')
  assert.equal(missingPackage("ModuleNotFoundError: No module named 'PIL'"), 'Pillow')
  assert.equal(missingPackage("ModuleNotFoundError: No module named 'yaml'"), 'PyYAML')
})

ok('a submodule resolves to the package that provides it', () => {
  // `google.protobuf` is not installable; `protobuf` is.
  assert.equal(missingPackage("ModuleNotFoundError: No module named 'google.protobuf'"), 'protobuf')
  assert.equal(missingPackage("ModuleNotFoundError: No module named 'numpy.random'"), 'numpy')
})

ok('the last failed import wins', () => {
  /* An import that failed inside a `try` earlier in the run is not what
     stopped the program, and installing it would not help. */
  const two = "ModuleNotFoundError: No module named 'optional'\n" +
              "ModuleNotFoundError: No module named 'yaml'\n"
  assert.equal(missingPackage(two), 'PyYAML')
})

ok('a failure that is not a missing import asks for nothing', () => {
  for (const other of [
    'ZeroDivisionError: division by zero',
    "ImportError: cannot import name 'x' from 'y'",
    'SyntaxError: invalid syntax',
    '', null, undefined
  ]) assert.equal(missingPackage(other), null, `should not install for: ${other}`)
})

ok('a module name that is really an option is refused', () => {
  /* The traceback is machine-written but it quotes a string the note chose, so
     this is the one place a note could try to reach a command line. Anything
     that is not plainly an identifier is not installed at all. */
  for (const hostile of [
    '--index-url', '-r', '--upgrade',
    ';rm -rf ~', '$(whoami)', '`id`', 'a b', 'a;b', 'a|b', '../../etc/passwd',
    './evil', 'http://evil/x.whl', ''
  ]) {
    assert.equal(
      missingPackage(`ModuleNotFoundError: No module named '${hostile}'`),
      null,
      `should have refused: ${hostile}`
    )
  }
})

/* ------------------------------------------------- reading a failed install

   Real output, pasted from real failures. Installers wrap their prose, so the
   naive "last line" reported "are unsatisfiable." — a sentence with the
   subject cut off, which is worse than saying nothing. */

const UV_MISSING = [
  'Using Python 3.13.15 environment at: rtest',
  '  \u00d7 No solution found when resolving dependencies:',
  '  \u2570\u2500\u25b6 Because nope-xyz was not found in the package registry and',
  '      you require nope-xyz, we can conclude that your requirements',
  '      are unsatisfiable.'
].join('\n')

const UV_OFFLINE = [
  'Using Python 3.13.15',
  'error: Request failed after 3 retries in 7.9s',
  '  Caused by: Failed to fetch: `http://127.0.0.1:9/simple/six/`',
  '  Caused by: tcp connect error'
].join('\n')

ok('a wrapped resolver failure is read whole', () => {
  const said = installerReason(UV_MISSING)
  assert.match(said, /^Because nope-xyz was not found in the package registry/)
  assert.match(said, /unsatisfiable\.$/, 'and to the end of the sentence')
  assert.ok(!said.includes('\n'), 'on one line')
})

ok('a network failure names itself rather than the resolver', () => {
  assert.equal(installerReason(UV_OFFLINE), 'Request failed after 3 retries in 7.9s')
})

ok("pip's own shape is read too", () => {
  const said = installerReason(
    'ERROR: Could not find a version that satisfies the requirement nope\n' +
    'ERROR: No matching distribution found for nope\n')
  assert.equal(said, 'No matching distribution found for nope')
})

ok('and nothing said is nothing claimed', () => {
  for (const nothing of ['', null, undefined, '   \n  \n']) {
    assert.equal(installerReason(nothing), '')
  }
})

/* -------------------------------------------------- declared dependencies

   PEP 723 inline metadata. Only the opening fence is looked for here — what
   the block holds is uv's business — so the tests are about that line and
   about not mistaking anything else for it. */

ok('a script that declares its own dependencies is recognised', () => {
  assert.equal(hasInlineDeps('# /// script\n# dependencies = ["six"]\n# ///'), true)
  // The spec allows no space after the hash.
  assert.equal(hasInlineDeps('#/// script\n# ///'), true)
})

ok('and an ordinary script is not', () => {
  for (const plain of [
    'import six',
    '# just a comment\nimport six',
    '# /// pyproject\n# ///',
    'x = 1  # /// script',
    '', null, undefined
  ]) assert.equal(hasInlineDeps(plain), false, `should not be inline deps: ${plain}`)
})

/* ------------------------------------------------------------- the lifecycle

   `uv` makes these fast enough to do for real; without it the same assertions
   would take minutes, so they are skipped rather than made against a mock.  */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tulip-envtest-'))
const envs = makePythonEnvs({
  root: () => root,
  vault: () => '/vault/one',
  pathFor: () => `${os.homedir()}/.local/bin${path.delimiter}${process.env.PATH}`
})

async function main () {
  /* Without uv every note shares one environment — by design, see dirFor —
     so the two identity checks below would fail on a machine that has only
     pip, which is what a hosted CI runner is. Decided first, and they are
     passed over rather than asserted against a design they do not apply to. */
  const hasUv = await envs.dirFor('probe.md') !== await envs.dirFor(null)
  if (!hasUv) console.log('# uv not installed — the pip path shares one environment, as designed')

  if (hasUv) await ok('a note and the shared pool are different environments', async () => {
    const mine = await envs.dirFor('Notes/Alpha.md')
    const shared = await envs.dirFor(null)
    assert.notEqual(mine, shared)
    // Both under the app's own directory: a vault never holds site-packages.
    assert.ok(mine.startsWith(root) && shared.startsWith(root))
  })

  await ok('the same note is the same environment twice running', async () => {
    assert.equal(await envs.dirFor('Notes/Alpha.md'), await envs.dirFor('Notes/Alpha.md'))
  })

  if (hasUv) await ok('two notes of the same name in different folders do not collide', async () => {
    assert.notEqual(await envs.dirFor('A/Note.md'), await envs.dirFor('B/Note.md'))
  })

  if (hasUv) await ok('the vault is part of the identity', async () => {
    /* The same installer as `envs`, so both sides key a note's own directory
       and the vault is the only thing that differs between them. */
    const other = makePythonEnvs({
      root: () => root,
      vault: () => '/vault/two',
      pathFor: () => `${os.homedir()}/.local/bin${path.delimiter}${process.env.PATH}`
    })
    const one = await envs.dirFor('Notes/Alpha.md')
    const two = await other.dirFor('Notes/Alpha.md')
    assert.notEqual(one, two, `two vaults share an environment: ${one}`)
  })

  if (!hasUv) {
    console.log(`\npython env: ${passed}/${passed}`)
    fs.rmSync(root, { recursive: true, force: true })
    return
  }

  const note = 'Notes/Alpha.md'
  const dir = await envs.dirFor(note)

  await ok('concurrent runs build one environment, not one each', async () => {
    /* "Run all" on a note of twenty python blocks is twenty calls in the same
       instant. Without single-flighting they race at the same directory. */
    const all = await Promise.all(Array.from({ length: 8 }, () => envs.ensure(dir)))
    assert.ok(all[0], 'an environment should have been made')
    assert.ok(all.every((p) => p === all[0]), 'every caller gets the same interpreter')
    assert.equal(all[0], pythonIn(dir))
    assert.ok(fs.existsSync(all[0]), 'and it is really there')
  })

  await netOk('a package installed into a note is importable from it', async () => {
    /* Nothing heavier than a pure-python package: this asserts the wiring, and
       the wiring does not know how big a wheel is. */
    assert.deepEqual(await envs.install(dir, 'six'), { ok: true })
    const { execFileSync } = require('node:child_process')
    const out = execFileSync(pythonIn(dir), ['-c', 'import six; print(six.__version__)'])
    assert.match(out.toString(), /^\d+\.\d+/)
  })

  await netOk('and is not importable from another note', async () => {
    /* The whole reason environments are per-note: what one installs is not
       silently in scope for the rest of the vault. */
    const elsewhere = await envs.dirFor('Notes/Beta.md')
    await envs.ensure(elsewhere)
    const { execFileSync } = require('node:child_process')
    assert.throws(
      () => execFileSync(pythonIn(elsewhere), ['-c', 'import six'], { stdio: 'pipe' }),
      'Beta should not see what Alpha installed'
    )
  })

  await ok('an installed console script is found, an absent one is not', async () => {
    assert.equal(await envs.tool(dir, 'no-such-tool'), null)
    // `six` ships no script; pip does, and `--seed` put it there.
    assert.ok(await envs.tool(dir, 'pip'), 'the seeded pip should be found')
  })

  await ok('a renamed note gives up its environment rather than carrying it', async () => {
    /* Carrying it is what looks right and does not work: a virtual environment
       is not relocatable, and a moved one has console scripts whose absolute
       shebangs name a directory that no longer exists. */
    await envs.relocate(note, 'Notes/Renamed.md')
    assert.equal(fs.existsSync(dir), false, 'the old environment is gone')
    const after = await envs.dirFor('Notes/Renamed.md')
    assert.equal(fs.existsSync(after), false, 'and no half-built one is left in its place')
    // Rebuilt on the next run, which is the whole cost of discarding it.
    assert.ok(await envs.ensure(after))
    assert.ok(fs.existsSync(pythonIn(after)))
  })

  await ok('a deleted note takes its environment with it', async () => {
    const doomed = await envs.dirFor('Notes/Doomed.md')
    await envs.ensure(doomed)
    assert.ok(fs.existsSync(doomed))
    await envs.forget('Notes/Doomed.md')
    assert.equal(fs.existsSync(doomed), false)
  })

  await ok('an environment deleted behind our back is rebuilt, not remembered', async () => {
    const dir2 = await envs.dirFor('Notes/Gamma.md')
    await envs.ensure(dir2)
    // Somebody cleared the app's data directory while Tulip was running.
    fs.rmSync(dir2, { recursive: true, force: true })
    envs.reset()
    assert.ok(await envs.ensure(dir2), 'the next run makes it again')
    assert.ok(fs.existsSync(pythonIn(dir2)))
  })

  await ok('an environment records which note it belongs to', async () => {
    /* The directory is a digest, so without the stamp inside it the only
       honest thing a settings panel could say is "17 directories, no idea
       whose". */
    const listed = await envs.list()
    const mine = listed.find((entry) => entry.note === 'Notes/Renamed.md')
    assert.ok(mine, 'the note should be named in the listing')
    assert.equal(mine.mine, true)
    assert.equal(mine.unknown, false)
    assert.ok(mine.bytes > 0, 'and weighed')
  })

  await ok('an environment whose note is gone is reported as orphaned', async () => {
    /* Only ever reported, never acted on by itself: a note that has merely
       been renamed outside the app is indistinguishable from a deleted one,
       and silently rebuilding is a cost nobody asked for. */
    const live = new Set(['Notes/Renamed.md'])
    const other = await envs.dirFor('Notes/Ghost.md')
    await envs.ensure(other)
    const listed = await envs.list(live)
    assert.equal(listed.find((e) => e.note === 'Notes/Ghost.md')?.orphaned, true)
    assert.equal(listed.find((e) => e.note === 'Notes/Renamed.md')?.orphaned, false)
    // And with nothing to compare against, nothing is accused.
    assert.equal((await envs.list(null)).every((e) => !e.orphaned), true)
  })

  await ok('an environment can be thrown away, and only inside the root', async () => {
    const doomed = await envs.dirFor('Notes/Ghost.md')
    assert.equal(await envs.remove(doomed), true)
    assert.equal(fs.existsSync(doomed), false)
    /* The path arrives from a renderer, and a few directories up from the
       environment root is somebody's home. */
    for (const outside of [os.homedir(), path.join(root, '..'), root, '/']) {
      assert.equal(await envs.remove(outside), false, `should have refused: ${outside}`)
      assert.equal(fs.existsSync(outside), true, `and left it alone: ${outside}`)
    }
  })

  await netOk('a failed install says why, not just that it failed', async () => {
    /* "No network" and "there is no such package" are the same sentence
       without the reason, and they are different things to do next. */
    const nope = await envs.install(dir, 'tulip-no-such-distribution-xyzzy')
    assert.equal(nope.ok, false)
    assert.ok(nope.reason, 'the installer should have said something')
    assert.ok(!/^error:/i.test(nope.reason), 'the "error:" prefix is stripped')
  })

  await ok('a package name that is not one is never handed to an installer', async () => {
    for (const hostile of ['--index-url=http://evil', '-r requirements.txt', ';id', '']) {
      const tried = await envs.install(dir, hostile)
      assert.equal(tried.ok, false, `should have refused: ${hostile}`)
    }
  })

  fs.rmSync(root, { recursive: true, force: true })
  const aside = skipped ? ` (${skipped} skipped — set TULIP_NET_TESTS=1)` : ''
  console.log(`\npython env: ${passed}/${passed}${aside}`)
}

main().catch((err) => {
  fs.rmSync(root, { recursive: true, force: true })
  console.error(err)
  process.exit(1)
})
