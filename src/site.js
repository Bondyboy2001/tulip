/**
 * Websites in the vault.
 *
 * A `.website` file holds one thing — an address — and the vault opens it as
 * the page rather than as the line of text it is on disk. That is the whole
 * feature: a site you keep going back to is filed beside the notes about it,
 * and clicking the row puts the live page on screen with everything the page
 * does still working, because what is looking at it is a browser.
 *
 * The page is a <webview> guest, behind the same fence an embedded page in a
 * note sits behind (see src/assets.js): its own process, its own persistent
 * session, no preload and no Node. electron/main.js decides at attach time
 * whether a guest may exist and where it may go afterwards — nothing in this
 * module is load-bearing for that. What is here is the address, the state the
 * chrome around it reads, and the bookkeeping between the file and the page.
 *
 * The file is the *home* address, not a log of where you have been. Following
 * a link moves the page and leaves the file alone; typing in the address bar
 * is what points the file somewhere else, and the Save button is for when a
 * few clicks have landed you on the page you actually meant to keep.
 */

import WEB_PARTITIONS from '../electron/web-partitions.json'
import { stepZoom } from './zoom.js'

/* Named identically in electron/main.js, which is what puts a guest behind the
   fence that lets it be any http(s) page and nothing else. */
const WEB_PARTITION = WEB_PARTITIONS.web

/* ------------------------------------------------------------- the file */

/**
 * The address a website file names.
 *
 * One line of text, so the file is readable and editable by anything — `cat`,
 * a sync client's conflict view, the copilot. A `#` line is a comment,
 * which is what lets a file carry a note to itself about what the page is
 * without that note being mistaken for the address.
 */
function readAddress (text) {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    return /^https?:\/\//i.test(trimmed) ? trimmed : ''
  }
  return ''
}

/** What that file looks like on disk, for the one address it holds. */
const writeAddress = (url) => `${url}\n`

/**
 * What someone typed, as an address, or '' if it is not one.
 *
 * `threejs.org` is what people type and `https://threejs.org/` is what they
 * mean, so a missing scheme is filled in. A scheme that is present is taken at
 * its word or refused outright: a guest may only ever be an http(s) page, and
 * quietly turning `file:///etc/passwd` into `https://file:///etc/passwd` would
 * be a stranger answer than saying no. A bare word with no dot in it is a typo
 * rather than a host — except the one everybody types.
 */
function normaliseAddress (input) {
  const raw = String(input || '').trim()
  if (!raw) return ''

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(raw)
  if (scheme && !/^https?$/i.test(scheme[1])) return ''

  try {
    const url = new URL(scheme ? raw : `https://${raw}`)
    if (!url.hostname) return ''
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return ''
    return url.toString()
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------ the viewer */

/**
 * The website on screen, and the state its toolbar is drawn from.
 *
 * @param host     the element the page fills
 * @param api      window.tulip
 * @param onState  called with a fresh snapshot whenever anything it shows moves
 */
export function mountSite ({ host, api, onState = () => {} }) {
  const state = {
    path: '',        // the .website file open
    home: '',        // the address that file names
    url: '',         // where the page actually is
    title: '',
    loading: false,
    /* Bumped on every open. A file read that resolves after the reader has
       moved on belongs to a document no longer on screen, and the only thing
       standing between that and a page loading into the wrong tab is this. */
    epoch: 0,
    /* Kept across documents on purpose, the way the PDF keeps the highlighter
       the reader picked up: someone who reads the web at 125% reads all of it
       at 125%, not one site at a time. */
    zoom: 1
  }

  let view = null
  let card = null

  /* Guest methods exist only once the guest does, and some of them throw until
     its process is up. A toolbar that throws while painting takes the document
     with it, so every question asked of the guest is asked through here. */
  const ask = (name, fallback = false) => {
    try { return view ? view[name]() : fallback } catch { return fallback }
  }

  const snapshot = () => ({
    path: state.path,
    home: state.home,
    url: state.url,
    title: state.title,
    loading: state.loading,
    canBack: ask('canGoBack'),
    canForward: ask('canGoForward'),
    /* Whether the page has wandered from what the file says. The Save button
       is the only thing that reads it, and it is the whole reason that button
       is not on screen the rest of the time. */
    drifted: Boolean(state.url && state.home && state.url !== state.home),
    zoom: state.zoom
  })

  const report = () => onState(snapshot())

  /* ------------------------------------------------------------ the guest */

  function wire (guest) {
    guest.addEventListener('did-start-loading', () => {
      state.loading = true
      // Whatever the last attempt put up — the blank prompt, a failure — is
      // about the page that is no longer being shown.
      clearCard()
      report()
    })
    guest.addEventListener('did-stop-loading', () => { state.loading = false; report() })

    /* Both, because a single-page app moves without loading anything: an
       address bar that only followed `did-navigate` would sit there naming the
       page the reader left three clicks ago. */
    const moved = () => { state.url = ask('getURL', state.url) || state.url; report() }
    guest.addEventListener('did-navigate', moved)
    guest.addEventListener('did-navigate-in-page', moved)

    guest.addEventListener('page-title-updated', (e) => {
      state.title = e.title || ''
      report()
    })

    // The earliest point the guest answers to anything, and so where the
    // reader's zoom is put back onto a page that has just replaced itself.
    guest.addEventListener('dom-ready', () => {
      try { guest.setZoomFactor(state.zoom) } catch { /* gone already */ }
      report()
    })

    guest.addEventListener('did-fail-load', (e) => {
      // -3 is a navigation the page itself abandoned, which is ordinary.
      if (e.errorCode === -3 || !e.isMainFrame) return
      state.loading = false
      showFailure(e.errorDescription || `Error ${e.errorCode}`)
      report()
    })
  }

  function ensureView (src) {
    if (view) return view
    const guest = document.createElement('webview')
    guest.className = 'site-view'
    guest.setAttribute('partition', WEB_PARTITION)
    // The guest's own PDF viewer, for a file that names a document.
    guest.setAttribute('plugins', '')
    /* Without this a <webview> does not merely refuse a popup — it suppresses
       window.open before anything is consulted about it, so the page's own
       handler gets a null back and main's setWindowOpenHandler is never called
       at all. That is why "Continue with Google" did nothing and said nothing:
       federated sign-in is a popup, and the popup was being dropped on the
       floor a layer below the one that decides such things.
       What may then be opened is still main's decision, not the page's — see
       setWindowOpenHandler in main.js, which is now reachable. */
    guest.setAttribute('allowpopups', '')
    /* Set before it is attached, because that is when it is decided whether
       this guest may exist at all — see will-attach-webview in main.js. */
    guest.setAttribute('src', src)
    wire(guest)
    view = guest
    host.prepend(guest)
    return guest
  }

  function teardown () {
    if (!view) return
    // A <webview> leaving the DOM takes its process with it; there is nothing
    // else to release.
    view.remove()
    view = null
  }

  /**
   * Put the page somewhere.
   *
   * `loadURL` rather than a fresh guest, so back and forward keep meaning what
   * they meant a moment ago. It is a navigation the app asks for rather than
   * one the page asks for, so it does not pass under main's `will-navigate`
   * guard — which is why nothing reaches here without going through
   * `normaliseAddress` first.
   */
  function load (url) {
    state.url = url
    state.loading = true
    clearCard()
    if (view) view.loadURL(url).catch(() => { /* did-fail-load says so */ })
    else ensureView(url)
  }

  /* ------------------------------------------------------------ the cards

     What stands in for the page when there is not one: a file with no address
     yet, and a page that would not load. Laid over the guest rather than put
     in its place, so a failure does not cost the reader the history they had
     — and so Chromium's own error page, which is what the guest is showing
     underneath, is not what they are left looking at.
     ================================================================== */

  function clearCard () {
    card?.remove()
    card = null
  }

  function showCard (title, detail, action) {
    clearCard()
    card = document.createElement('div')
    card.className = 'site-card'

    const heading = document.createElement('p')
    heading.className = 'site-card-title'
    heading.textContent = title

    const note = document.createElement('p')
    note.className = 'site-card-detail'
    note.textContent = detail

    card.append(heading, note)

    if (action) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'site-card-go'
      button.textContent = action.label
      button.addEventListener('click', action.run)
      card.append(button)
    }

    host.append(card)
  }

  const showBlank = () => showCard(
    'No address yet',
    'Type one in the bar above and this file will point there.'
  )

  const showFailure = (why) => showCard(
    'This page would not load',
    why,
    { label: 'Try again', run: () => { if (state.url) load(state.url) } }
  )

  /* -------------------------------------------------------------- opening */

  /**
   * Put a website file on screen.
   *
   * @param place  where this tab was last left, as `{ url }` — a page reached
   *               by clicking about is where the reader expects to come back
   *               to, not the address the file names.
   */
  async function open (path, place = null) {
    const epoch = ++state.epoch
    teardown()
    clearCard()

    state.path = path
    state.home = ''
    state.url = ''
    state.title = ''
    state.loading = false
    report()

    let text
    try {
      text = await api.file.read(path)
    } catch {
      throw new Error('That website file could not be read.')
    }
    // Read and opened are two moments, and the reader may have moved between
    // them. Anything past here would be painting into somebody else's tab.
    if (epoch !== state.epoch) return

    state.home = readAddress(text)
    const wanted = place?.url || state.home
    if (wanted) load(wanted)
    else showBlank()
    report()
  }

  function close () {
    // Anything still in flight for the document being closed lands after this
    // and finds an epoch that has moved on.
    state.epoch++
    teardown()
    clearCard()
    Object.assign(state, { path: '', home: '', url: '', title: '', loading: false })
    report()
  }

  /**
   * The file changed on disk under an open tab — a hand edit, a sync, the
   * copilot. The file is the document, so the page follows it.
   */
  function rehome (text) {
    const next = readAddress(text)
    if (next === state.home) return
    state.home = next
    if (next) load(next)
    else { teardown(); showBlank() }
    report()
  }

  /* ---------------------------------------------------------- navigating */

  /**
   * Go where the reader typed, and point the file there.
   *
   * Typing an address into the bar of a *file* is asking the file to be about
   * that page — unlike clicking a link, which is asking to look at something.
   * The two are the whole distinction this feature rests on.
   *
   * @returns whether it was an address at all
   */
  async function goTo (input) {
    const url = normaliseAddress(input)
    if (!url) return false
    load(url)
    report()
    await saveHome()
    return true
  }

  /** Make the file name the page that is actually on screen. */
  async function saveHome () {
    if (!state.path || !state.url || state.url === state.home) return
    const wrote = state.path
    const url = state.url
    try {
      await api.file.write(wrote, writeAddress(url))
    } catch {
      // The page is still on screen and still where the reader put it; only
      // the record of it failed, and the button stays offering to try again.
      return
    }
    if (state.path === wrote) { state.home = url; report() }
  }

  const back = () => { if (ask('canGoBack')) view.goBack() }
  const forward = () => { if (ask('canGoForward')) view.goForward() }
  const reload = () => { if (view) view.reload(); else if (state.url) load(state.url) }
  const stop = () => { try { view?.stop() } catch { /* gone */ } }

  /* -------------------------------------------------------------- zoom */

  /**
   * Resize the page, on the stops the window's own zoom uses.
   *
   * @param {1|-1|'fit'} step  in one stop, out one stop, or back to actual size
   */
  function setZoom (step) {
    if (step === 'fit') state.zoom = 1
    else state.zoom = stepZoom(state.zoom, step)
    try { view?.setZoomFactor(state.zoom) } catch { /* gone */ }
    report()
  }

  return {
    open,
    close,
    rehome,
    goTo,
    saveHome,
    back,
    forward,
    reload,
    stop,
    setZoom,
    url: () => state.url,
    home: () => state.home,
    /* Where this tab is, for the trail. `url` rather than a scroll offset: a
       page reloads from scratch when the tab comes back, and the one thing
       worth carrying across that is which page it was. */
    place: () => ({ url: state.url }),
    focus: () => { try { view?.focus() } catch { /* gone */ } },
    state: snapshot
  }
}
