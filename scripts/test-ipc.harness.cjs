'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const electron = require('electron')
const { app, ipcMain } = electron

/* Handed in by scripts/test-ipc.mjs, which makes both directories. */
const VAULT = process.env.TULIP_IPC_VAULT
const OUTSIDE = process.env.TULIP_IPC_OUTSIDE

/* Every handler main registers, kept by channel. Registered for real as well,
   so main behaves exactly as it would in the app. */
const handlers = new Map()
const realHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, fn) => { handlers.set(channel, fn); return realHandle(channel, fn) }

/* The window is created — main's boot depends on having one, and half of what
   is being tested is reached through it — but it is never put on screen. A
   suite that threw a window over the reader's desk and took the keyboard from
   whatever they were doing would be a worse suite for it. Patched on the
   prototype rather than by replacing the class, which Electron does not allow.
   `show` is also how main reveals the window once the renderer says it has
   painted, so this is the one place that has to be stopped. */
const { BrowserWindow } = electron
BrowserWindow.prototype.show = function () {}
BrowserWindow.prototype.showInactive = function () {}
BrowserWindow.prototype.focus = function () {}

require(path.join(__dirname, '..', 'electron', 'main.js'))

const call = (channel, ...args) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('no handler for ' + channel)
  // The first argument of an ipcMain handler is the event, which these ignore.
  return fn({ sender: null }, ...args)
}

const results = []
const check = async (what, run) => {
  try { await run(); results.push({ what, ok: true }) } catch (error) {
    results.push({ what, ok: false, why: String((error && error.message) || error) })
  }
}
/** Something that must be refused. Returns the reason it gave. */
const refused = async (what, run) => {
  try { await run() } catch (error) { return String((error && error.message) || error) }
  throw new Error(what + ': it was allowed')
}

app.whenReady().then(async () => {
  // Main's own ready handler runs first; give its vault set-up a moment to land.
  await new Promise((r) => setTimeout(r, 400))
  try {
    await checks()
  } catch (error) {
    results.push({ what: 'the harness itself', ok: false, why: String((error && error.stack) || error) })
  }
  console.log('TULIP_IPC_RESULTS ' + JSON.stringify(results))
  app.exit(results.some((r) => !r.ok) ? 1 : 0)
})

async function checks () {
  await check('vault:current names the vault main was pointed at', async () => {
    const now = await call('vault:current')
    assert.equal(now.path, VAULT)
    assert.equal(now.name, path.basename(VAULT))
  })

  await check('vault:snapshot lists the note that was already there', async () => {
    const snap = await call('vault:snapshot')
    const paths = JSON.stringify(snap.tree)
    assert.ok(paths.includes('Seed.md'), 'the seeded note is in the tree')
  })

  await check('a note can be created, read, written and read back', async () => {
    const made = await call('file:create', '', 'Fresh')
    assert.equal(made, 'Fresh.md')
    assert.equal(typeof await call('file:read', made), 'string')
    await call('file:write', made, 'written by the test')
    assert.equal(await call('file:read', made), 'written by the test')
  })

  await check('a second note of the same name gets its own name', async () => {
    const again = await call('file:create', '', 'Fresh')
    assert.notEqual(again, 'Fresh.md')
    assert.ok(again.startsWith('Fresh'))
  })

  await check('a folder can be made and a note moved into it', async () => {
    await call('folder:create', '', 'Shelf')
    const moved = await call('file:move', 'Fresh.md', 'Shelf')
    // { path, links } — where it went, and how many wikilinks were rewritten
    // to follow it.
    assert.ok(String(moved.path).startsWith('Shelf/'), 'it answers with where it went')
    assert.equal(typeof moved.links, 'number')
    assert.ok(fs.existsSync(path.join(VAULT, 'Shelf', 'Fresh.md')))
    assert.equal(fs.existsSync(path.join(VAULT, 'Fresh.md')), false, 'and not where it was')
  })

  /* ---- the containment rules, which are the reason this file exists ---- */

  await check('reading outside the vault is refused', async () => {
    const why = await refused('read ..', () => call('file:read', '../config.json'))
    assert.ok(why.length, 'it says something')
    await refused('read an absolute path', () => call('file:read', path.join(OUTSIDE, 'profile', 'config.json')))
  })

  await check('writing outside the vault is refused', async () => {
    await refused('write ..', () => call('file:write', '../escaped.md', 'no'))
    assert.equal(fs.existsSync(path.join(OUTSIDE, 'escaped.md')), false,
      'and nothing was written on the way to refusing')
  })

  await check('creating outside the vault is refused', async () => {
    await refused('create in ..', () => call('file:create', '..', 'Escaped'))
    assert.equal(fs.existsSync(path.join(OUTSIDE, 'Escaped.md')), false)
  })

  await check('deleting outside the vault is refused', async () => {
    const bystander = path.join(OUTSIDE, 'bystander.md')
    fs.writeFileSync(bystander, 'not the vault\'s business')
    await refused('delete ..', () => call('file:delete', '../bystander.md'))
    assert.ok(fs.existsSync(bystander), 'the file outside is still there')
  })

  /* ---- names, which are the other way a write goes somewhere unintended ---- */

  await check('a name with a separator in it cannot make a path', async () => {
    const made = await call('file:create', '', 'a/b')
    assert.equal(made.includes('/'), false, 'the slash did not become a folder')
  })

  /* Refused rather than quietly renamed, and that is the right way round: a
     name the reader typed is a name they meant, and a note that silently became
     CON_ is one they will look for under the name they gave it. The rule is
     applied on both platforms so that a vault written on macOS can still be
     opened on Windows — see electron/safe-name.js. */
  await check('a name Windows cannot hold is refused, and says why', async () => {
    const why = await refused('create CON', () => call('file:create', '', 'CON'))
    assert.ok(/reserved/i.test(why), 'the reason names the rule: ' + why)
    assert.equal(fs.existsSync(path.join(VAULT, 'CON.md')), false)
  })

  await check('a name that is only punctuation is refused too', async () => {
    await refused('create ...', () => call('file:create', '', '...'))
  })

  /* ---- config, whose allowlist is a security boundary ---- */

  await check('config:set writes a key that is on the list', async () => {
    await call('config:set', { theme: 'moss' })
    const cfg = await call('config:get')
    assert.equal(cfg.theme, 'moss')
  })

  await check('config:set will not repoint the vault', async () => {
    await call('config:set', { vaultPath: OUTSIDE })
    const now = await call('vault:current')
    assert.equal(now.path, VAULT, 'the vault is where it was')
  })

  await check('config:set will not set the command that gets spawned', async () => {
    await call('config:set', { tikzCommand: 'touch /tmp/tulip-ipc-pwned' })
    const cfg = await call('config:get')
    assert.notEqual(cfg.tikzCommand, 'touch /tmp/tulip-ipc-pwned')
  })

  /* ---- search, over the index these handlers keep ---- */

  await check('search finds a word in a note that was never opened', async () => {
    const found = await call('search:vault', 'pomegranate', {})
    const hits = found.results || found
    assert.ok(hits.length, 'the seeded note matched')
    assert.ok(JSON.stringify(hits).includes('Seed.md'))
  })

  await check('search finds nothing for a word nothing says', async () => {
    const found = await call('search:vault', 'zzzznotinthisvault', {})
    assert.equal((found.results || found).length, 0)
  })

  /* ---- the recent-vault channels ---- */

  await check('vault:recent does not offer the vault already open', async () => {
    const seen = await call('vault:recent')
    assert.equal(seen.some((entry) => entry.path === VAULT), false)
  })

  await check('vault:open refuses a folder Tulip has never opened', async () => {
    const answer = await call('vault:open', OUTSIDE)
    assert.equal(answer.ok, false)
    const now = await call('vault:current')
    assert.equal(now.path, VAULT, 'and the vault did not move')
  })

  await check('vault:open refuses nothing at all', async () => {
    assert.equal((await call('vault:open', '')).ok, false)
    assert.equal((await call('vault:open', null)).ok, false)
  })

  /* ---- the review store, reached the way the panel reaches it ---- */

  await check('review answers are recorded and come back', async () => {
    const id = 'Deck.lang|word|f'
    await call('review:record', [{ id, at: Date.now(), grade: 3, state: { due: 1, stability: 2, difficulty: 5, reps: 1, lapses: 0, last: 0 } }])
    const all = await call('review:all')
    assert.ok(all[id], 'the card is in the state file')
    const log = await call('review:history')
    assert.ok(log.some((line) => line.id === id), 'and the answer is in the log')
  })

  await check('an undone answer leaves neither state nor statistics behind', async () => {
    const id = 'Deck.lang|undone-word|f'
    const at = Date.now()
    await call('review:record', [{ id, at, grade: 3, state: { due: 9, stability: 1, difficulty: 5, reps: 1, lapses: 0, last: 0 } }])
    await call('review:unrecord', { id, at, state: null })
    const all = await call('review:all')
    assert.equal(all[id], undefined, 'a never-seen card goes back to never seen')
    const log = await call('review:history')
    assert.ok(!log.some((line) => line.id === id), 'and the history shows neither the answer nor the undo')
  })

  await check('undo puts back the state a card had before the answer', async () => {
    const id = 'Deck.lang|reworded|f'
    const before = { due: 5, stability: 3, difficulty: 4, reps: 2, lapses: 1, last: 1 }
    await call('review:record', [{ id, at: Date.now() - 1000, grade: 3, state: before }])
    await call('review:record', [{ id, at: Date.now(), grade: 1, state: { ...before, due: 0, lapses: 2 } }])
    await call('review:unrecord', { id, at: Date.now(), state: before })
    const all = await call('review:all')
    assert.deepEqual(all[id], before)
    const log = await call('review:history')
    assert.equal(log.filter((line) => line.id === id).length, 1, 'only the first answer remains counted')
  })

  await check('review:prune refuses to act on a scan that found nothing', async () => {
    const answer = await call('review:prune', [])
    assert.equal(answer.refused, true)
    assert.ok(answer.reason)
  })

  /* ---- what is filed against a path rather than kept inside the file ----

     Tags and table column widths live in the same kind of sidecar, and the
     thing that breaks about a sidecar is never the reading and writing: it is
     that a rename leaves the entry behind under a name nothing will ask for
     again, and a delete leaves it there for ever. So each is renamed and
     deleted here, which is the half nobody notices is broken. */

  await check('tags are kept for a file and come back', async () => {
    await call('file:create', '', 'Tagged')
    assert.deepEqual(await call('file-tags:set', 'Tagged.md', ['Blue', '#blue', ' green ']),
      ['blue', 'green'], 'cleaned, lower-cased and deduplicated')
    assert.deepEqual(await call('file-tags:get', 'Tagged.md'), ['blue', 'green'])
    assert.deepEqual(await call('file-tags:get', 'Seed.md'), [], 'a file with none says so')
  })

  await check('a table\'s layout is kept for it and comes back', async () => {
    fs.writeFileSync(path.join(VAULT, 'Table.csv'), 'a,b\n1,2\n')
    const layout = { widths: [120, 260], delimiter: ';' }
    assert.deepEqual(await call('table-widths:set', 'Table.csv', layout), layout)
    assert.deepEqual(await call('table-widths:get', 'Table.csv'), layout)
    assert.equal(await call('table-widths:get', 'Seed.md'), null, 'a file with none says so')
  })

  await check('a layout written before delimiters were kept still means what it did', async () => {
    /* The store predates half of what it now holds, and a sidecar written by
       an older build is a bare array. It has to go on working rather than be
       thrown away, which would take every deliberate column width with it. */
    assert.deepEqual(await call('table-widths:set', 'Table.csv', [90, 300]), { widths: [90, 300] })
    assert.deepEqual(await call('table-widths:get', 'Table.csv'), { widths: [90, 300] })
  })

  await check('a layout that is not one is not stored', async () => {
    assert.equal(await call('table-widths:set', 'Table.csv', 'wide'), null)
    assert.equal(await call('table-widths:set', 'Table.csv', [0, -4]), null)
    assert.equal(await call('table-widths:get', 'Table.csv'), null,
      'and the refused write cleared what was there rather than keeping a stale one')
    // A delimiter the grid does not offer is not one it will split data on.
    assert.deepEqual(await call('table-widths:set', 'Table.csv',
      { widths: [120, 260], delimiter: 'q' }), { widths: [120, 260] })
    await call('table-widths:set', 'Table.csv', { widths: [120, 260], delimiter: ';' })
  })

  /* ---- what History keeps a copy of, and what it cannot afford to ---- */

  await check('an ordinary save is kept so it can be put back', async () => {
    fs.writeFileSync(path.join(VAULT, 'Small.csv'), 'a,b\n1,2\n')
    await call('file:write', 'Small.csv', 'a,b\n1,3\n')
    const kept = (await call('trust:list') || [])
      .some((op) => JSON.stringify(op).includes('Small.csv'))
    assert.ok(kept, 'a small data file should be recoverable like a note')
  })

  await check('a file too large to version is written but not kept', async () => {
    /* History holds every save whole inside one budget shared by the vault. A
       large export autosaving would carry more than the whole store into it
       on a single keystroke, evicting the recoverable history of every note
       to make room for a version it cannot keep either. So past a size it is
       written — atomically, like everything else — and not recorded. */
    const wide = 'a,b\n' + ('1234567890,abcdefghij\n'.repeat(30000))
    assert.ok(wide.length > 256 * 1024, 'the fixture has to be over the ceiling')
    fs.writeFileSync(path.join(VAULT, 'Big.csv'), wide)
    await call('file:write', 'Big.csv', wide.replace('1234567890', '9999999999'))

    assert.ok(fs.readFileSync(path.join(VAULT, 'Big.csv'), 'utf8').startsWith('a,b\n9999999999'),
      'the write itself still has to land')
    const kept = (await call('trust:list') || [])
      .some((op) => JSON.stringify(op).includes('Big.csv'))
    assert.equal(kept, false, 'a large export was copied whole into the history store')
  })

  await check('both follow the file through a rename', async () => {
    await call('file:rename', 'Tagged.md', 'Renamed')
    assert.deepEqual(await call('file-tags:get', 'Renamed.md'), ['blue', 'green'])
    await call('file:rename', 'Table.csv', 'Renamed table')
    assert.deepEqual(await call('table-widths:get', 'Renamed table.csv'),
      { widths: [120, 260], delimiter: ';' })
  })

  await check('and are forgotten when it is deleted', async () => {
    await call('file:delete', 'Renamed.md')
    await call('file:delete', 'Renamed table.csv')
    const sidecar = (name) => {
      const at = path.join(VAULT, '.tulip', name)
      return fs.existsSync(at) ? JSON.parse(fs.readFileSync(at, 'utf8')) : {}
    }
    assert.deepEqual(Object.keys(sidecar('file-tags.json')), [])
    assert.deepEqual(Object.keys(sidecar('table-widths.json')), [])
  })

  /* What a reader is handed when they are told something went wrong. The toast
     that sends them here is the only account they get of a failure, so the two
     things behind it have to be true: the log is reachable only when there is
     one, and the report describes this install rather than a template. */
  await check('there is no crash log to reveal until something goes wrong', async () => {
    // The suite's own userData is fresh, so a log here would mean main wrote
    // one during boot — which is a finding in itself, not a passing test.
    assert.equal(await call('app:reveal-log'), false)
  })

  await check('diagnostics describe this build and this vault', async () => {
    const { text, hasLog } = await call('app:diagnostics')
    assert.match(text, /^Tulip \d+\.\d+\.\d+/, 'the version leads the report')
    assert.match(text, /Electron \d/, 'the Electron version is in it')
    assert.match(text, new RegExp(`${process.platform}`), 'the platform is in it')
    assert.match(text, /Vault: \d+ notes/, 'the vault is described by shape')
    assert.equal(hasLog, false, 'nothing has failed, so there is nothing to quote')
  })

  await check('diagnostics name no path from the reader machine', async () => {
    /* A report is written to be pasted somewhere public. The vault path is a
       home directory more often than not, and a real name with it. */
    const { text } = await call('app:diagnostics')
    assert.equal(text.includes(VAULT), false, 'the vault path is in the report')
    assert.equal(text.includes(require('node:os').homedir()), false,
      'the home directory is in the report')
  })
}
