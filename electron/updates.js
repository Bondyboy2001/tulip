// @ts-check
'use strict'

/* Staying current.

   The release workflow has published the metadata for this for a while —
   latest-mac.yml, latest.yml and a .blockmap beside every artifact — and
   package.json names the GitHub repository they describe. Nothing read any of
   it, so every copy of Tulip stayed on whatever version it was downloaded as,
   including through a security fix. This is the reader.

   Deliberately quiet. An update is fetched in the background and mentioned once,
   when it is on disk and one restart away; there is no progress bar, no modal on
   launch, and nothing that interrupts a note being written. The only case that
   speaks up regardless is the one the user asked about by hand, where saying
   nothing would read as a broken menu item.

   Two conditions turn the whole thing off:

   - Not packaged. `electron-updater` reads app-update.yml out of the app
     bundle's resources, which only exists in a built app; in `npm start` there
     is nothing to read and it throws on the first call.
   - Not signed. macOS refuses to install an update whose signature it cannot
     match against the running app, and Windows will warn. Until the certificates
     in release.yml are real, a downloaded update cannot be applied — so it is
     not downloaded either, rather than filling the user's disk with an update
     that will never install. See the signing section in CONTRIBUTING.md. */

const { app, dialog, shell } = require('electron')

const SIX_HOURS = 6 * 60 * 60 * 1000

/* Where a release lives, for the one path that cannot install by itself: an
   unsigned build, where the honest answer is "there is a new version, here is
   where to get it" rather than a button that would fail. */
const RELEASES = 'https://github.com/Bondyboy2001/tulip/releases/latest'

let updater = null
let checking = false
/* A downloaded update is offered once. Without this, the six-hourly check finds
   the same staged update every time and asks again for as long as the app is
   open. */
let offered = false

/**
 * Whether this build is one an update can be applied to at all.
 *
 * Only the packaged question is answerable from here. Whether the build is
 * *signed* is not something Electron exposes, and the platform only answers it
 * at the moment of installing — so an unsigned build downloads the update and
 * is refused at the last step, which `fail` turns into a link to the release
 * rather than an error the user can do nothing with.
 */
const canInstall = () => app.isPackaged

/**
 * A failure nobody asked about.
 *
 * The network being down, GitHub being slow, a signature that will not verify:
 * none of these are the user's problem while they are writing, and none of them
 * are worth a dialog. They go to the log. `manual` is the exception — someone
 * clicked Check for Updates and is owed an answer either way.
 */
function fail (err, manual) {
  console.error('update check failed', err)
  if (!manual) return
  dialog.showMessageBox({
    type: 'info',
    message: 'Could not check for updates.',
    detail: `${err?.message || err}\n\nReleases are also listed on GitHub.`,
    buttons: ['Open Releases', 'Close'],
    defaultId: 1,
    cancelId: 1
  }).then(({ response }) => { if (response === 0) shell.openExternal(RELEASES) })
}

/** The update is on disk. Offer the restart that applies it. */
async function offer (info) {
  if (offered) return
  offered = true
  const version = info?.version ? `Tulip ${info.version}` : 'A new version of Tulip'
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `${version} is ready to install.`,
    detail: 'Restarting takes a few seconds. Unsaved notes are written first.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) return
  /* `quitAndInstall` closes windows itself, and does it without the flush the
     close handler in main.js performs — so the ordinary quit runs first and
     the install happens on the way out, through the `before-quit-for-update`
     path electron-updater installs. */
  updater.quitAndInstall()
}

/**
 * Ask GitHub whether there is a newer release.
 *
 * `manual` marks the check as one somebody asked for, which is the only thing
 * that changes: an automatic check that finds nothing says nothing, and a
 * manual one says so.
 */
async function check ({ manual = false } = {}) {
  if (!canInstall()) {
    if (manual) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: 'This build cannot update itself.',
        detail: 'Automatic updates need a signed, packaged build. Releases are listed on GitHub.',
        buttons: ['Open Releases', 'Close'],
        defaultId: 0,
        cancelId: 1
      })
      if (response === 0) shell.openExternal(RELEASES)
    }
    return
  }

  // Two checks at once would download the same file twice.
  if (checking) return
  checking = true

  try {
    if (!updater) {
      // Required here rather than at the top of the file: an unpackaged run
      // never reaches this line, and the module reads app-update.yml eagerly.
      updater = require('electron-updater').autoUpdater
      updater.autoDownload = true
      // The app decides when to install; electron-updater's own "on quit"
      // default would apply an update the user never heard about.
      updater.autoInstallOnAppQuit = false
      updater.logger = { info: () => {}, warn: console.warn, error: console.error, debug: () => {} }
      updater.on('update-downloaded', offer)
      updater.on('error', (err) => fail(err, false))
    }

    const result = await updater.checkForUpdates()
    if (manual && !result?.updateInfo) {
      dialog.showMessageBox({ type: 'info', message: 'Tulip is up to date.', buttons: ['OK'] })
    }
  } catch (err) {
    fail(err, manual)
  } finally {
    checking = false
  }
}

/**
 * Start watching for releases.
 *
 * The first check waits, rather than running at `whenReady`: launch is already
 * reading the vault, restoring the tab strip and building the note index, and a
 * network round trip competing with all of that buys nothing — the update has
 * been available for however long it has been available, and ten more seconds
 * changes nothing.
 */
function watch () {
  if (!canInstall()) return
  const first = setTimeout(() => check(), 10_000)
  const later = setInterval(() => check(), SIX_HOURS)
  // Neither timer should hold the process open on its own.
  first.unref?.()
  later.unref?.()
}

module.exports = { watch, check }
