/* Consent, seen from outside the moment it was given.

   Trust is granted by a native dialog at the first run and kept in the config
   as vault paths. This drives the real app: trust a vault the way the app
   would have, take it back over the untrust channel, and prove both the
   config and the main process agree it is gone.

   Run it behind a build: `npm run build && npm run test:trust`. */
import { appSession, delay } from './lib/app-session.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const app = await appSession({
  files: { 'Note.md': '# Note\n\nSome text.\n' },
  config: { tabs: ['Note.md'], tabIndex: 0 }
})
try {
  /* The trust list is main's to write, and the renderer may not set it — that
     is the point of the key. So: stop, write the config a past dialog would
     have left, start again. */
  await app.stop()
  const configPath = path.join(app.profile, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  await writeFile(configPath, JSON.stringify({ ...config, trustedVaults: [app.vault] }))
  await app.restart()
  assert.equal(await app.evaluate(`window.tulip.run.trusted()`), true)

  const listed = await app.evaluate('window.tulip.run.trustedVaults()')
  assert.equal(listed.length, 1, 'the trusted vault is listed')
  assert.equal(listed[0].name, path.basename(app.vault))

  await app.evaluate(`window.tulip.run.untrust(${JSON.stringify(app.vault)})`)

  /* Config writes are coalesced; the revocation is not done until the file
     says so, which is also what a restart would read. */
  for (let attempt = 0; attempt < 50; attempt++) {
    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    if (!(saved.trustedVaults || []).includes(app.vault)) break
    await delay(100)
  }
  const saved = JSON.parse(await readFile(configPath, 'utf8'))
  assert.ok(!(saved.trustedVaults || []).includes(app.vault), 'revoking removes the vault from the config')
  assert.equal(await app.evaluate(`window.tulip.run.trusted()`), false, 'and main stops treating it as trusted')

  console.log('PASS: revoking a trusted vault takes effect')
} finally {
  await app.dispose()
}
