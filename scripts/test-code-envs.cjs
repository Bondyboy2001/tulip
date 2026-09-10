'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { makeCodeEnvs, missingImport, safe } = require('../electron/code-envs')
const { makePythonEnvs } = require('../electron/python-env')

test('only diagnoses missing external packages requested by the source', () => {
  assert.equal(missingImport('rust', 'error[E0432]: unresolved import `utf8_slice`', 'use utf8_slice;'), 'utf8_slice')
  assert.equal(missingImport('rust', 'unresolved import `thing`', 'mod thing; use thing;'), null)
  assert.equal(missingImport('rust', 'unresolved import `std`', 'use std;'), null)
  assert.equal(missingImport('python', "ModuleNotFoundError: No module named 'PIL'", 'from PIL import Image'), 'PIL')
  assert.equal(missingImport('python', "ModuleNotFoundError: No module named 'internal'", 'import pandas'), null)
  assert.equal(missingImport('python', "ModuleNotFoundError: No module named 'x['", 'import pandas'), null)
  assert.equal(missingImport('node', "Cannot find module './local'", "require('./local')"), null)
  assert.equal(missingImport('node', "Cannot find package '@scope/pkg'", "import x from '@scope/pkg'"), '@scope/pkg')
  assert.equal(safe('node', '--prefix=/tmp'), false)
  assert.equal(safe('python', 'foo;echo'), false)
  assert.equal(safe('go', 'example.com/../../bad'), false)
})

test('managed runs isolate notes, retain records, and cancel queued/running work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-env-test-'))
  const manager = makeCodeEnvs({ root: () => root, vault: () => root, pathFor: () => process.env.PATH, pythonEnvs: {}, autoInstall: () => false })
  try {
    const run = (id, note, code) => manager.run({ id, note, lang: 'node', code, cwd: root, timeoutMs: 5000, output: () => {} })
    const missing = await run(1, 'a.md', "require('tulip-package-that-does-not-exist')")
    assert.notEqual(missing.code, 0)
    assert.deepEqual((await manager.manage('a.md', 'node')).packages, {})
    const first = run(2, 'a.md', 'setTimeout(() => {}, 10000)')
    const second = run(3, 'a.md', "console.log('must not run')")
    setTimeout(() => { manager.stop(2); manager.stop(3) }, 200)
    assert.equal((await first).signal, 'SIGTERM')
    assert.equal((await second).signal, 'SIGTERM')
    assert.equal((await run(4, 'b.md', "console.log('other note')")).code, 0)
    assert.equal((await manager.list()).length, 2)
    let unicode = ''
    const split = await manager.run({ id: 5, note: 'b.md', lang: 'node', code: 'process.stdout.write(Buffer.from([240,159])); setTimeout(() => process.stdout.write(Buffer.from([154,128])), 30)', cwd: root, timeoutMs: 5000, output: (_stream, text) => { unicode += text } })
    assert.equal(split.code, 0)
    assert.equal(unicode, '🚀', 'streamed UTF-8 survives split output chunks')
    const exported = await manager.manage('b.md', 'node', 'export')
    assert.equal(exported.format, 'tulip-environment-v1')
    assert.ok(exported.files['package.json'])
    await manager.manage('a.md', 'node', 'reset')
    assert.equal((await manager.list()).length, 1)
  } finally { manager.disposeSync(); await fs.rm(root, { recursive: true, force: true }) }
})

test('Stop kills an installer and a failed install restores manifests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-env-cancel-'))
  const bin = path.join(root, 'bin')
  await fs.mkdir(bin)
  const marker = path.join(root, 'should-not-exist')
  const installer = 'const fs = require("fs"); fs.writeFileSync("package.json", "broken"); console.log("installer started"); setTimeout(() => fs.writeFileSync(' + JSON.stringify(marker) + ', "alive"), 1500);\n'
  if (process.platform === 'win32') {
    /* A `.cmd` cannot be started by CreateProcess, so the manager launches npm
       through the command interpreter; the shim has to be one too, pointing at
       the same JavaScript. */
    const script = path.join(bin, 'npm-shim.cjs')
    await fs.writeFile(script, installer)
    await fs.writeFile(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    await fs.writeFile(path.join(bin, 'npm'), '#!' + process.execPath + '\n' + installer, { mode: 0o755 })
  }
  let manager
  manager = makeCodeEnvs({ root: () => root, vault: () => root, pathFor: () => bin + path.delimiter + process.env.PATH, pythonEnvs: {}, autoInstall: () => true })
  try {
    const result = await manager.run({ id: 50, note: 'stop.md', lang: 'node', code: "require('missing-example')", cwd: root, timeoutMs: 5000,
      output: (_stream, text) => { if (text.includes('installer started')) manager.stop(50) } })
    assert.equal(result.signal, 'SIGTERM')
    assert.deepEqual((await manager.manage('stop.md', 'node')).packages, {})
    const exported = await manager.manage('stop.md', 'node', 'export')
    assert.equal(JSON.parse(exported.files['package.json']).name, 'tulip-note')
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal(await fs.access(marker).then(() => true, () => false), false)
  } finally { manager.disposeSync(); await fs.rm(root, { recursive: true, force: true }) }
})

test('native managers install imports and preserve resolved versions', { skip: !process.env.TULIP_NET_TESTS, timeout: 600000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-env-net-'))
  const pythonEnvs = makePythonEnvs({ root: () => root, vault: () => root, pathFor: () => process.env.PATH })
  const manager = makeCodeEnvs({ root: () => root, vault: () => root, pathFor: () => process.env.PATH, pythonEnvs, autoInstall: () => true })
  const examples = [
    ['rust', 'use utf8_slice; fn main() { println!("{}", utf8_slice::slice("The 🚀 goes", 4, 5)); }', '🚀'],
    ['node', "import slugify from 'slugify'; console.log(slugify('hello world'));", 'hello-world'],
    ['python', 'import pyfiglet\nprint(pyfiglet.figlet_format("OK"))', '_'],
    ['go', 'package main\nimport ("fmt"; "github.com/google/uuid")\nfunc main(){fmt.Println(uuid.Nil.String())}', '00000000-0000-0000-0000-000000000000'],
    ['julia', 'using Example\nprintln(hello("Tulip"))', 'Hello, Tulip']
  ]
  try {
    let id = 10
    const plain = { note: 'Plain.md', lang: 'python', code: 'print(42)', cwd: root, timeoutMs: 5000, output: () => {} }
    await manager.run({ ...plain, id: id++ })
    const pyRoot = path.join(root, 'code-envs', 'python')
    const pyDir = path.join(pyRoot, (await fs.readdir(pyRoot))[0])
    const stamp = path.join(pyDir, 'record.json')
    const original = await fs.stat(stamp)
    await manager.run({ ...plain, id: id++ })
    assert.equal((await fs.stat(stamp)).mtimeMs, original.mtimeMs, 'repeat runs do not rewrite environment records')
    assert.equal((await manager.manage('Plain.md', 'python')).packagesScanned, true)
    for (const [lang, code, expected] of examples) {
      let output = ''
      const args = { id: id++, note: 'Packages.md', lang, code, cwd: root, timeoutMs: 60000, output: (_stream, text) => { output += text } }
      const result = await manager.run(args)
      assert.equal(result.code, 0, `${lang}: ${output}\n${JSON.stringify(result)}`)
      assert.ok(output.includes(expected), output)
      const before = await manager.manage('Packages.md', lang)
      assert.ok(Object.keys(before.packages).length, lang)
      output = ''
      assert.equal((await manager.run({ ...args, id: id++ })).code, 0)
      assert.ok(!output.includes('Installing '), output)
      assert.deepEqual((await manager.manage('Packages.md', lang)).packages, before.packages)
      const pkg = Object.keys(before.packages)[0]
      await manager.manage('Packages.md', lang, 'remove', pkg)
      assert.ok(!Object.hasOwn((await manager.manage('Packages.md', lang)).packages, pkg))
      console.log(`${lang}: install, repeat and remove passed`)
    }
  } finally { manager.disposeSync(); pythonEnvs.disposeSync(); await fs.rm(root, { recursive: true, force: true }) }
})
