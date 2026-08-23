'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
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

/* The send-only half. `ipcMain.on` carries the channels where nothing waits for
   an answer, and one of them — the tab a window has picked up — is half of a
   protocol whose other half IS invoked, so testing only the invoked half would
   test a conversation with one side missing. */
const listeners = new Map()
const realOn = ipcMain.on.bind(ipcMain)
ipcMain.on = (channel, fn) => { listeners.set(channel, fn); return realOn(channel, fn) }

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

/* The same, for a handler that cares WHICH window is asking. A window is a
   `sender.id` to all of these, so a number is a whole window here. */
const from = (id, channel, ...args) => {
  const fn = handlers.get(channel) || listeners.get(channel)
  if (!fn) throw new Error('no handler for ' + channel)
  return fn({ sender: { id } }, ...args)
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

  /* A `.docx` is a zip: nothing in it is text on disk, so a search that only
     reads files finds nothing in one. This is the whole reason there is a
     second index for them — a document the vault lists, opens and edits but
     cannot find reads as "not in the vault" when it means "never looked". */
  await check('search finds a word inside a Word document', async () => {
    const { blankDocxBuffer, readDocxBuffer, writeDocxBuffer } = require('../electron/docx')
    const blank = blankDocxBuffer()
    const read = readDocxBuffer(blank)
    fs.writeFileSync(path.join(VAULT, 'Minutes.docx'), writeDocxBuffer(blank, {
      stamp: read.stamp,
      body: read.body,
      after: read.after,
      items: [{ p: { ppr: '', runs: [{ text: 'The quince harvest was discussed.' }] } }]
    }))
    /* The walk indexes what it finds. A file that appeared from outside the app
       reaches the index when the watcher notices it, so this asks more than
       once rather than assuming the first query is late enough. */
    let hits = []
    for (let tries = 0; tries < 40 && !hits.length; tries++) {
      await call('vault:snapshot', null)
      const found = await call('search:vault', 'quince', {})
      hits = found.results || found
      if (!hits.length) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.ok(JSON.stringify(hits).includes('Minutes.docx'), 'the Word document did not match')
    const hit = hits.find((r) => r.path === 'Minutes.docx')
    assert.equal(hit.kind, 'docx', 'it came back as some other kind of result')
    assert.ok(/quince/.test(JSON.stringify(hit.hits)), 'no line of the document was quoted')
  })

  /* The watcher names the file that moved, and the index syncs that one file
     rather than walking the vault: an outside edit to a note is found, and a
     note removed from outside stops being found. Both go through the targeted
     path in `syncIndex`, which is the one that stats one file, not every one. */
  await check('an outside edit to one note reaches the index by name', async () => {
    const until = async (word, wanted) => {
      let hits = []
      for (let tries = 0; tries < 40; tries++) {
        const found = await call('search:vault', word, {})
        hits = found.results || found
        if (Boolean(hits.length) === wanted) return hits
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return hits
    }
    fs.writeFileSync(path.join(VAULT, 'Seed.md'), '# Seed\n\nA pomegranate and a loquat.\n')
    const found = await until('loquat', true)
    assert.ok(JSON.stringify(found).includes('Seed.md'), 'the edited note was not re-read')
    fs.writeFileSync(path.join(VAULT, 'Gone.md'), '# Gone\n\nmedlar\n')
    assert.ok((await until('medlar', true)).length, 'the new note was not indexed')
    fs.unlinkSync(path.join(VAULT, 'Gone.md'))
    assert.equal((await until('medlar', false)).length, 0, 'the removed note is still found')
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

  await check('and which way a column was pointed is kept with the widths', async () => {
    const pointed = { widths: [120, 260], aligns: [null, 'center'], delimiter: ';' }
    assert.deepEqual(await call('table-widths:set', 'Table.csv', pointed), pointed)
    assert.deepEqual(await call('table-widths:get', 'Table.csv'), pointed)
    /* An alignment nobody offers, and a list that describes some other table,
       are both dropped — the widths beside them are not. */
    assert.deepEqual(await call('table-widths:set', 'Table.csv',
      { widths: [120, 260], aligns: ['sideways', 'left'] }),
    { widths: [120, 260], aligns: [null, 'left'] })
    assert.deepEqual(await call('table-widths:set', 'Table.csv',
      { widths: [120, 260], aligns: ['left'] }), { widths: [120, 260] })
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

  /* ---- a tab carried from one window's strip to another's ----

     Main arbitrates this because the drag itself cannot: it becomes an OS drag
     on the way across and a custom flavour does not survive the crossing. What
     that buys has to be tested from both windows at once, which is what the
     `from(id, …)` helper is for — two numbers standing in for two windows. */
  const A = 101
  const B = 202

  await check('a strip is not told about its own drag', async () => {
    from(A, 'tab:drag-start', 'Note.md')
    assert.equal(await from(A, 'tab:dragging'), null,
      'the window that picked the tab up would treat a reorder as a handoff')
    const seen = await from(B, 'tab:dragging')
    assert.equal(seen && seen.path, 'Note.md', 'the other window cannot see what is in flight')
    from(A, 'tab:drag-end')
  })

  await check('a drag that ends nowhere leaves no claim behind', async () => {
    from(A, 'tab:drag-start', 'Note.md')
    from(A, 'tab:drag-end')
    assert.equal(await from(B, 'tab:dragging'), null)
    assert.equal(await from(B, 'tab:claim'), null, 'a stale claim can still be taken')
  })

  await check('only the window that picked a tab up may put it down', async () => {
    from(A, 'tab:drag-start', 'Note.md')
    // B never started this drag; its end must not cancel A's.
    from(B, 'tab:drag-end')
    const seen = await from(B, 'tab:dragging')
    assert.equal(seen && seen.path, 'Note.md')
    from(A, 'tab:drag-end')
  })

  await check('a tab is claimed once, and the second drop gets nothing', async () => {
    from(A, 'tab:drag-start', 'Note.md')
    const first = await from(B, 'tab:claim')
    assert.equal(first && first.path, 'Note.md')
    /* Two strips both opening one note is the failure this guards: the claim is
       consumed before the handler awaits anything, so a second drop landing in
       the same frame finds nothing. */
    assert.equal(await from(B, 'tab:claim'), null)
    assert.equal(await from(A, 'tab:dragging'), null, 'the claim outlived being taken')
  })

  await check('a strip cannot claim its own drag', async () => {
    from(A, 'tab:drag-start', 'Note.md')
    assert.equal(await from(A, 'tab:claim'), null)
    from(A, 'tab:drag-end')
  })

  await check('a path that is not one is not carried', async () => {
    for (const bad of [null, 42, '', 'x'.repeat(1025)]) {
      from(A, 'tab:drag-start', bad)
      assert.equal(await from(B, 'tab:dragging'), null, `it accepted ${JSON.stringify(bad)}`)
    }
  })

  /* ---------------- the exports, which write outside the vault ----------------

     Every other write in this file is checked for staying inside the vault.
     These are the handlers where leaving it is the whole point — an export is
     how a note gets somewhere the app does not own — so what has to be tested
     is the opposite: that they write what they promised, where they were told,
     and that the one path in them which is *not* the user's choice (an
     attachment's name inside the export folder) still cannot climb out.

     Each is given an explicit `to`. That argument exists so the destination can
     come from somewhere other than the native dialog, and a suite that let the
     dialog open would hang on a modal nobody is there to answer. */

  const exportWindow = BrowserWindow.getAllWindows()[0]
  /* From a real window, because these handlers begin by asking which one is
     speaking and refuse when the answer is nothing. */
  const exporting = (channel, ...args) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error('no handler for ' + channel)
    return fn({ sender: exportWindow.webContents }, ...args)
  }
  const OUT = path.join(OUTSIDE, 'exports')
  fs.mkdirSync(OUT, { recursive: true })

  await check('a note exports as one self-contained HTML file', async () => {
    const to = path.join(OUT, 'note.html')
    const done = await exporting('note:export-html', 'Seed', '<article class="reading"><h1>Hello</h1></article>', to)
    assert.equal(done.ok, true, done.error || 'it reported failure')
    assert.equal(done.path, to, 'it wrote where it was told')
    const page = fs.readFileSync(to, 'utf8')
    assert.ok(page.startsWith('<!doctype html>'), 'it is a whole document')
    assert.ok(page.includes('<h1>Hello</h1>'), 'the body it was handed is in it')
    /* The point of the export: no <link> to a stylesheet the file cannot reach
       from wherever it is opened. */
    assert.ok(/<style>[\s\S]*}/.test(page), 'the stylesheet came with it')
    assert.equal(done.bytes, Buffer.byteLength(page), 'and it counted what it wrote')
  })

  await check('a name that would be markup does not become markup', async () => {
    const to = path.join(OUT, 'sharp.html')
    await exporting('note:export-html', 'Tom & <script>', '<p>x</p>', to)
    const page = fs.readFileSync(to, 'utf8')
    assert.ok(page.includes('<title>Tom &amp; '), 'the ampersand is escaped')
    assert.ok(!page.includes('<title>Tom &amp; <script>'), 'and the tag is not opened in the title')
  })

  await check('a note exports as Markdown with its attachments beside it', async () => {
    fs.writeFileSync(path.join(VAULT, 'picture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const to = path.join(OUT, 'portable.md')
    const done = await exporting('note:export-markdown', 'Seed', '# Portable\n\n![](picture.png)\n',
      [{ rel: 'picture.png', as: 'picture.png' }], to)
    assert.equal(done.ok, true, done.error || 'it reported failure')
    assert.equal(done.copied, 1, 'the attachment was copied')
    assert.equal(fs.readFileSync(to, 'utf8'), '# Portable\n\n![](picture.png)\n')
    assert.ok(fs.existsSync(path.join(OUT, 'picture.png')), 'and it landed beside the note')
  })

  await check('an attachment cannot be written outside the export folder', async () => {
    const to = path.join(OUT, 'nested', 'escape.md')
    fs.mkdirSync(path.dirname(to), { recursive: true })
    const done = await exporting('note:export-markdown', 'Seed', 'text',
      [{ rel: 'picture.png', as: '../climbed.png' },
        { rel: 'picture.png', as: '/tmp/absolute.png' }], to)
    assert.equal(done.ok, true, 'the note itself still exports')
    assert.equal(done.copied, 0, 'neither attachment was copied')
    assert.equal(fs.existsSync(path.join(OUT, 'climbed.png')), false, 'nothing climbed out')
  })

  await check('a missing attachment does not fail the export', async () => {
    const to = path.join(OUT, 'broken.md')
    const done = await exporting('note:export-markdown', 'Seed', 'text',
      [{ rel: 'not-here.png', as: 'not-here.png' }], to)
    assert.equal(done.ok, true, 'the note exports with its link left broken')
    assert.equal(done.copied, 0)
  })

  await check('a whiteboard exports as the bytes it was handed', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const to = path.join(OUT, 'board.svg')
    const done = await exporting('whiteboard:export', 'Board', 'svg', svg, to)
    assert.equal(done.ok, true, done.error || 'it reported failure')
    assert.equal(fs.readFileSync(to, 'utf8'), svg.toString(), 'byte for byte')

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const alsoTo = path.join(OUT, 'board.png')
    const also = await exporting('whiteboard:export', 'Board', 'png', png, alsoTo)
    assert.equal(also.ok, true, also.error || 'it reported failure')
    assert.deepEqual([...fs.readFileSync(alsoTo)], [...png])
  })

  await check('an export says so rather than throwing when the path is unwritable', async () => {
    const done = await exporting('note:export-html', 'Seed', '<p>x</p>',
      path.join(OUT, 'no-such-folder', 'deep', 'note.html'))
    assert.equal(done.ok, false, 'it did not claim to have written')
    assert.ok(done.error, 'and it says why, for the toast')
  })

  /* The compiled-language pipeline, end to end: compile, publish the binary
     under its cache name, copy it into the execution slot, run it. Those middle
     two steps were `/bin/mv` and `/bin/cp` — paths that do not exist on Windows,
     so every compiled block there failed *after* paying for the compile. They
     are fs calls now, and this is the check that they still do the job: nothing
     short of running the program proves the copy arrived executable.

     C++ rather than Rust because `c++` is the platform compiler and is present
     wherever a toolchain is at all; a machine without one skips instead of
     failing, since an absent compiler is not this project's defect. */
  await check('a compiled block compiles, is staged and runs', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('main created no window to own a run')

    const cpp = spawnSync('c++', ['--version'], { encoding: 'utf8' })
    if (cpp.error || cpp.status !== 0) return   // no toolchain here; not a failure

    /* run:start answers with the id and nothing else — the result arrives later
       as a `run:done` to the owning window. So the window's own send is what
       gets listened to, which is also the path the app really uses. */
    const said = []
    const contents = win.webContents
    const realSend = contents.send.bind(contents)
    contents.send = (channel, payload) => { said.push({ channel, payload }); return realSend(channel, payload) }

    try {
      const source = '#include <cstdio>\nint main() { std::printf("staged ok\\n"); return 0; }\n'
      const started = await handlers.get('run:start')({ sender: contents }, 'cpp', source, null)
      const id = started.id
      /* Whatever names the run has to be a string: it goes back over IPC, and a
         function there is an uncloneable-object throw at the call site. */
      assert.ok(started.cmd === null || typeof started.cmd === 'string',
        'run:start named the run with something IPC can carry')

      const done = await new Promise((resolve, reject) => {
        const until = setTimeout(() => reject(new Error('the run never finished')), 90000)
        const poll = setInterval(() => {
          const hit = said.find((m) => m.channel === 'run:done' && m.payload && m.payload.id === id)
          if (!hit) return
          clearInterval(poll); clearTimeout(until); resolve(hit.payload)
        }, 50)
      })

      assert.equal(done.code, 0, 'the staged binary ran and exited cleanly')
      const out = said.filter((m) => m.channel === 'run:out' && m.payload.id === id)
        .map((m) => m.payload.text).join('')
      assert.match(out, /staged ok/, 'and what it printed came back')
      assert.ok(done.buildMs >= 0, 'the compile was timed as a build')
    } finally {
      contents.send = realSend
    }
  })

  await check('the window is printed to a real PDF', async () => {
    const to = path.join(OUT, 'printed.pdf')
    const done = await exporting('pdf:export', 'Seed', to)
    assert.equal(done.ok, true, done.error || 'it reported failure')
    const head = fs.readFileSync(to).subarray(0, 5).toString('latin1')
    assert.equal(head, '%PDF-', 'what landed is a PDF')
    assert.ok(done.bytes > 0, 'and it counted the bytes')
  })
}
