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
 *
 * ONE GUEST PER OPEN FILE, not one for the window. Every website tab keeps its
 * own live page for as long as the tab is open: switching to a note and back
 * used to tear the guest down and fetch the page again from the top, which
 * threw away the scroll position, a half-filled form, a video, and — worst —
 * a sign-in redirect in flight. A tab left is hidden and muted; a tab closed
 * is the only thing that ends a page. `LIVE_PAGES` caps how many may be held
 * at once, because each is a renderer process.
 */

import WEB_PARTITIONS from '../electron/web-partitions.json'
import { stepZoom } from './zoom.js'

/* Named identically in electron/main.js, which is what puts a guest behind the
   fence that lets it be any http(s) page and nothing else. */
const WEB_PARTITION = WEB_PARTITIONS.web

/* How many pages may be alive at once. Each is a Chromium renderer with a
   site's worth of JavaScript in it, so this is a memory number and not a
   nicety. Four covers the shape of the thing people actually do — a couple of
   references open beside the note being written — and the fifth tab evicts the
   page nobody has looked at for longest, which then reloads from its address
   the way it did before any of this. */
const LIVE_PAGES = 4

/* How much of a page's text is worth carrying to the copilot or into a note.
   A long article is tens of kilobytes; a documentation index is hundreds, and
   almost all of it is navigation. */
const MAX_PAGE_TEXT = 120000

/* ---------------------------------------------------------- why it failed */

/* Chromium names its network failures for the people who wrote it:
   `ERR_NAME_NOT_RESOLVED`, or just `Error -105` when even the name is missing.
   Under "This page would not load" that is a second thing to look up, not an
   answer — so each of the ones a reader actually meets says what happened in a
   sentence, and the code goes on the card's tooltip for whoever wants it.

   Keyed by name and by number both, because `did-fail-load` supplies the name
   for most failures and nothing but the number for some. */
const PLAIN_FAILURE = {
  ERR_INTERNET_DISCONNECTED: 'There is no internet connection.',
  '-106': 'There is no internet connection.',
  ERR_NAME_NOT_RESOLVED: 'That address could not be found. It may be mistyped, or the site may no longer exist.',
  '-105': 'That address could not be found. It may be mistyped, or the site may no longer exist.',
  ERR_NAME_RESOLUTION_FAILED: 'That address could not be looked up.',
  '-137': 'That address could not be looked up.',
  ERR_CONNECTION_TIMED_OUT: 'The connection timed out. The site may be down, or the connection slow.',
  '-118': 'The connection timed out. The site may be down, or the connection slow.',
  ERR_TIMED_OUT: 'The connection timed out. The site may be down, or the connection slow.',
  '-7': 'The connection timed out. The site may be down, or the connection slow.',
  ERR_CONNECTION_REFUSED: 'The site refused the connection.',
  '-102': 'The site refused the connection.',
  ERR_CONNECTION_RESET: 'The connection was cut off part-way.',
  '-101': 'The connection was cut off part-way.',
  ERR_CONNECTION_CLOSED: 'The connection was closed before the page arrived.',
  '-100': 'The connection was closed before the page arrived.',
  ERR_CONNECTION_FAILED: 'The connection could not be made.',
  '-104': 'The connection could not be made.',
  ERR_ADDRESS_UNREACHABLE: 'That address cannot be reached from this network.',
  '-109': 'That address cannot be reached from this network.',
  ERR_EMPTY_RESPONSE: 'The site answered with nothing at all.',
  '-324': 'The site answered with nothing at all.',
  ERR_TOO_MANY_REDIRECTS: 'The site kept redirecting and never arrived anywhere.',
  '-310': 'The site kept redirecting and never arrived anywhere.',
  ERR_SSL_PROTOCOL_ERROR: 'The secure connection could not be set up.',
  '-107': 'The secure connection could not be set up.',
  ERR_CERT_COMMON_NAME_INVALID: 'The site’s security certificate is not for this address.',
  ERR_CERT_DATE_INVALID: 'The site’s security certificate has expired, or this computer’s clock is wrong.',
  ERR_CERT_AUTHORITY_INVALID: 'The site’s security certificate is not from an authority this computer trusts.',
  ERR_BLOCKED_BY_CLIENT: 'Something on this computer blocked the page.',
  '-20': 'Something on this computer blocked the page.',
  ERR_BLOCKED_BY_RESPONSE: 'The site would not allow the page to be shown here.',
  '-27': 'The site would not allow the page to be shown here.',
  ERR_UNKNOWN_URL_SCHEME: 'That is not an address this window can open.',
  '-302': 'That is not an address this window can open.',
  ERR_FILE_NOT_FOUND: 'There is nothing at that address.',
  '-6': 'There is nothing at that address.'
}

/** @returns {string} what went wrong, in a sentence. */
function plainFailure (description, code) {
  const named = String(description || '').trim()
  return PLAIN_FAILURE[named] || PLAIN_FAILURE[String(code)] ||
    /* Certificate failures are a run of codes rather than a handful, and any
       one of them means the same thing to the reader. */
    (Number(code) <= -200 && Number(code) >= -220
      ? 'The site’s security certificate could not be trusted.'
      : 'The page could not be reached.')
}

/* ------------------------------------------------------------- the file */

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
export function normaliseAddress (input) {
  const raw = String(input || '').trim()
  if (!raw) return ''

  /* `localhost:8000` is a host and a port, not a scheme and a path — and it is
     precisely what someone running a dev server types. Anything followed by
     digits alone is read as an authority, which no real scheme ever is. */
  const port = /^[a-z][a-z\d+.-]*:\d+(\/|$)/i.test(raw)
  const scheme = port ? null : /^([a-z][a-z\d+.-]*):/i.exec(raw)
  if (scheme && !/^https?$/i.test(scheme[1])) return ''

  try {
    /* http for a server on this machine, https for everything else. The fence
       around a guest allows plain http on loopback and nowhere else (see
       `allowedGuestUrl` in electron/main.js), so `https://localhost:8000` is a
       refusal dressed up as a default. */
    const local = /^(localhost|127(?:\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(raw)
    const url = new URL(scheme ? raw : `${local ? 'http' : 'https'}://${raw}`)
    if (!url.hostname) return ''
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return ''
    return url.toString()
  } catch {
    return ''
  }
}

/**
 * What a website file says: the address, the title, and any other comment
 * lines someone put there.
 *
 * One line of text for the address, so the file is readable and editable by
 * anything — `cat`, a sync client's conflict view, the copilot. A `#` line is
 * a comment, and the *first* of them is the page's title: Tulip writes it when
 * the address is saved so that a search for "Three.js" finds the file, which
 * a file holding nothing but a URL could never answer. Any further comment
 * lines are the reader's own and are carried through a save untouched.
 *
 * The address goes through `normaliseAddress`, not a stricter test of its own.
 * A hand-edited file saying `threejs.org` is a file that means the site — it
 * is exactly what the address bar accepts — and refusing it there while
 * accepting it here was the one way to get "No address yet" out of a file with
 * an address plainly written in it.
 */
export function readAddress (text) {
  const lines = String(text || '').split('\n')
  let url = ''
  let title = ''
  const notes = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) {
      const said = trimmed.replace(/^#+\s*/, '')
      if (!title && !url) title = said
      else if (said) notes.push(said)
      continue
    }
    if (!url) url = normaliseAddress(trimmed)
  }
  return { url, title, notes }
}

/** What that file looks like on disk, for one address and what it is called. */
export function writeAddress ({ url, title = '', notes = [] }) {
  const lines = []
  /* One line, and never a line break: a title is a heading for a file with one
     line of content in it, and a page whose <title> is a paragraph would
     otherwise turn the address into the second thing in a wall of text. */
  const named = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (named) lines.push(`# ${named}`)
  lines.push(url)
  for (const note of notes) lines.push(`# ${note}`)
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------ the viewer */

/**
 * The website on screen, and the state its toolbar is drawn from.
 *
 * @param host     the element the pages fill
 * @param api      window.tulip
 * @param onState  called with a fresh snapshot whenever anything it shows moves
 * @param onFind   called with `{ at, total }` as a find walks the page
 * @param zoom     the size the reader last read the web at
 */
export function mountSite ({ host, api, onState = (_view) => {}, onFind = (_tally) => {}, zoom = 1 }) {
  /* Every open website file, in the order they were last looked at — the last
     entry is the one on screen, so the first is the one to evict. A Map keeps
     insertion order, and re-inserting a key is how a page says it was used. */
  const pages = new Map()

  /** @type {any} the page on screen, or null when the viewer is not showing one */
  let open = null

  /* Kept across documents on purpose, the way the PDF keeps the highlighter
     the reader picked up: someone who reads the web at 125% reads all of it at
     125%, not one site at a time. Written back to the config by the shell, so
     it is also the size they read the web at next week. */
  let scale = Number(zoom) > 0 ? Number(zoom) : 1

  /* ------------------------------------------------------------ one page */

  /**
   * Everything one open `.website` file has: the file's own account of itself,
   * the guest showing it, and whatever is laid over that guest.
   */
  function blankPage (path) {
    return {
      path,
      home: '',        // the address the file names
      title: '',       // what the file calls it, then what the page calls itself
      // the reader's own comment lines, carried through a save
      notes: /** @type {string[]} */ ([]),
      url: '',         // where the page actually is
      pageTitle: '',
      favicon: '',
      loading: false,
      /* Whether what is on screen is still the load of the file's own address
         — including whatever redirects that load went through. It is what says
         a title belongs to this file rather than to a page the reader clicked
         off to; see `keepTitle`. */
      settling: false,
      /** @type {any} */ guest: null,
      /** @type {any} */ card: null,
      find: { query: '', at: 0, total: 0 }
    }
  }

  /* Guest methods exist only once the guest does, and some of them throw until
     its process is up. A toolbar that throws while painting takes the document
     with it, so every question asked of a guest is asked through here. */
  const ask = (page, name, fallback = false) => {
    try { return page?.guest ? page.guest[name]() : fallback } catch { return fallback }
  }

  const snapshotOf = (page) => ({
    path: page?.path || '',
    home: page?.home || '',
    url: page?.url || '',
    title: page?.pageTitle || page?.title || '',
    favicon: page?.favicon || '',
    loading: !!page?.loading,
    canBack: ask(page, 'canGoBack'),
    canForward: ask(page, 'canGoForward'),
    /* Whether the page has wandered from what the file says. The Save button
       is the only thing that reads it, and it is the whole reason that button
       is not on screen the rest of the time. */
    drifted: Boolean(page?.url && page?.home && page.url !== page.home),
    /* Plain http is allowed only on this machine (see `allowedGuestUrl` in
       electron/main.js), and the bar says which of the two this is: a window
       with no lock anywhere is a window that cannot tell the reader when the
       page they are typing into is being carried in the clear. */
    secure: secureOf(page?.url || ''),
    zoom: scale
  })

  /** 'secure' | 'local' | 'plain' | '' — what the address bar's marker says. */
  function secureOf (url) {
    if (!url) return ''
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:') return 'secure'
      return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i.test(parsed.hostname)
        ? 'local'
        : 'plain'
    } catch { return '' }
  }

  const snapshot = () => snapshotOf(open)
  const report = (page) => { if (!page || page === open) onState(snapshot()) }
  const tellFind = (page) => {
    if (page && page !== open) return
    const found = open?.find || { at: 0, total: 0 }
    onFind({ at: found.at, total: found.total })
  }

  /* ------------------------------------------------------------ the guest */

  function wire (page, guest) {
    guest.addEventListener('did-start-loading', () => {
      page.loading = true
      // Whatever the last attempt put up — the blank prompt, a failure — is
      // about the page that is no longer being shown.
      clearCard(page)
      report(page)
    })
    guest.addEventListener('did-stop-loading', () => {
      page.loading = false
      report(page)
      /* The page has arrived and said what it is called, which is a moment
         later than the address was written — a file pointed somewhere by the
         address bar is saved the instant the reader presses Enter, when the
         only thing known about the page is its URL. So the name is filled in
         here, and only for a page still sitting at the address the file names:
         a title is a fact about the file's own page, not about wherever the
         reader has since clicked to. */
      keepTitle(page)
      // Whatever happens next is the reader's doing, not this load's.
      page.settling = false
    })

    /* Both, because a single-page app moves without loading anything: an
       address bar that only followed `did-navigate` would sit there naming the
       page the reader left three clicks ago. */
    const moved = () => {
      page.url = ask(page, 'getURL', page.url) || page.url
      /* A find belongs to the page it was run over. Chromium drops the
         highlight itself on a navigation; without this the tally went on
         claiming `3 / 12` about a document that had been replaced. */
      if (page.find.total) { page.find = { query: page.find.query, at: 0, total: 0 }; tellFind(page) }
      report(page)
    }
    guest.addEventListener('did-navigate', moved)
    guest.addEventListener('did-navigate-in-page', moved)

    guest.addEventListener('page-title-updated', (e) => {
      page.pageTitle = e.title || ''
      report(page)
      /* Here as well as at `did-stop-loading`, because the two arrive in
         either order: a page announces its title when the <head> is parsed,
         which is usually before it has finished loading and occasionally
         after. Writing it is guarded and idempotent, so whichever comes
         second does nothing. */
      keepTitle(page)
    })

    /* The site's own mark, for the address bar. Only over https: the icon is
       fetched by the app's own page rather than by the guest, so it is a
       request made outside the fence, and one made in the clear to a host the
       reader was told was not secure is not a request to make for decoration.
       (The renderer's CSP allows `img-src https:` and nothing else, so this is
       also the only kind it could draw.) */
    guest.addEventListener('page-favicon-updated', (e) => {
      const icon = (e.favicons || []).find((href) => /^https:/i.test(href)) || ''
      if (icon === page.favicon) return
      page.favicon = icon
      report(page)
    })

    // The earliest point the guest answers to anything, and so where the
    // reader's zoom is put back onto a page that has just replaced itself.
    guest.addEventListener('dom-ready', () => {
      try { guest.setZoomFactor(scale) } catch { /* gone already */ }
      report(page)
    })

    guest.addEventListener('did-fail-load', (e) => {
      // -3 is a navigation the page itself abandoned, which is ordinary.
      if (e.errorCode === -3 || !e.isMainFrame) return
      page.loading = false
      showFailure(page, e.errorDescription, e.errorCode)
      report(page)
    })

    /* A guest whose process dies leaves a white rectangle with a toolbar over
       it still claiming it can go back. Chromium says so in one of two ways
       depending on how it died, and neither used to be listened for — so the
       reader was left with a page that was not there and nothing on screen
       admitting it. */
    const died = (why) => {
      page.loading = false
      showCard(page, 'This page stopped responding', why, {
        label: 'Reload the page',
        run: () => { if (page.url) load(page, page.url, { fresh: true }) }
      })
      report(page)
    }
    guest.addEventListener('crashed', () => died('The page’s process ended unexpectedly.'))
    guest.addEventListener('render-process-gone', (e) => died(
      e?.details?.reason === 'oom'
        ? 'The page ran out of memory.'
        : 'The page’s process ended unexpectedly.'))

    guest.addEventListener('found-in-page', (e) => {
      const result = e.result || {}
      page.find.total = Number(result.matches) || 0
      page.find.at = page.find.total ? (Number(result.activeMatchOrdinal) || 0) : 0
      tellFind(page)
    })
  }

  function ensureGuest (page, src) {
    if (page.guest) return page.guest
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
    guest.hidden = page !== open
    wire(page, guest)
    page.guest = guest
    host.prepend(guest)
    return guest
  }

  /** A page's guest and everything laid over it, gone. The record may stay. */
  function destroy (page) {
    clearCard(page)
    if (!page.guest) return
    // A <webview> leaving the DOM takes its process with it; there is nothing
    // else to release.
    page.guest.remove()
    page.guest = null
    page.find = { query: page.find.query, at: 0, total: 0 }
  }

  /** Whether this page's guest may be heard. A tab you have switched away from
   *  is not a tab whose video should go on talking over the note you moved to
   *  — the same rule the file viewer keeps by tearing itself down, which this
   *  one cannot do without throwing the page away. */
  function setMuted (page, muted) {
    try { page.guest?.setAudioMuted(muted) } catch { /* not up yet */ }
  }

  /** Show one page and hide the rest, without disturbing what any of them are
   *  in the middle of. */
  function display (page) {
    for (const other of pages.values()) {
      const showing = other === page
      if (other.guest) other.guest.hidden = !showing
      if (other.card) other.card.hidden = !showing
      setMuted(other, !showing)
    }
    open = page || null
  }

  /* The oldest pages, dropped once there are more than the cap. Only ever
     pages nobody is looking at: the one on screen is the newest entry by
     construction, and a cap that could close the tab in front of the reader
     would be a memory saving nobody asked for. */
  function evict () {
    for (const [path, page] of pages) {
      if (pages.size <= LIVE_PAGES) return
      if (page === open) continue
      destroy(page)
      pages.delete(path)
    }
  }

  /** This page was just used, so it is the last one to be evicted. */
  function touch (page) {
    pages.delete(page.path)
    pages.set(page.path, page)
  }

  /**
   * Put a page somewhere.
   *
   * `loadURL` rather than a fresh guest, so back and forward keep meaning what
   * they meant a moment ago. It is a navigation the app asks for rather than
   * one the page asks for, so it does not pass under main's `will-navigate`
   * guard — which is why nothing reaches here without going through
   * `normaliseAddress` first.
   *
   * @param fresh  after a crash, when the guest that would be told to navigate
   *               is a process that no longer exists
   */
  function load (page, url, { fresh = false } = {}) {
    page.url = url
    page.loading = true
    /* A load of the file's own address, which a redirect to a locale or a
       canonical host does not stop being. Anything the page then calls itself
       is this file's page being named. */
    page.settling = url === page.home
    clearCard(page)
    if (fresh) destroy(page)
    if (page.guest) page.guest.loadURL(url).catch(() => { /* did-fail-load says so */ })
    else ensureGuest(page, url)
  }

  /* ------------------------------------------------------------ the cards

     What stands in for the page when there is not one: a file with no address
     yet, a page that would not load, and a page whose process died. Laid over
     the guest rather than put in its place, so a failure does not cost the
     reader the history they had — and so Chromium's own error page, which is
     what the guest is showing underneath, is not what they are left looking at.
     ================================================================== */

  function clearCard (page) {
    page.card?.remove()
    page.card = null
  }

  function showCard (page, title, detail, action) {
    clearCard(page)
    const card = document.createElement('div')
    card.className = 'site-card'
    card.hidden = page !== open

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

    page.card = card
    host.append(card)
  }

  const showBlank = (page) => showCard(
    page,
    'No address yet',
    'Type one in the bar above and this file will point there.'
  )

  const showFailure = (page, description, code) => {
    showCard(
      page,
      'This page would not load',
      plainFailure(description, code),
      { label: 'Try again', run: () => { if (page.url) load(page, page.url) } }
    )
    // The exact name is still worth having when the plain sentence is not the
    // whole story, so it is where anyone looking for it would look.
    if (page.card) page.card.title = description || `Error ${code}`
  }

  /* -------------------------------------------------------------- opening */

  /**
   * Put a website file on screen.
   *
   * A file already open in another tab is *the same page*, brought back with
   * everything it was in the middle of — that is the whole reason the pages
   * outlive the tab switch. Only a file with no page of its own is read from
   * disk and loaded.
   *
   * @param place  where this tab was last left, as `{ url }` — a page reached
   *               by clicking about is where the reader expects to come back
   *               to, not the address the file names. Only consulted when the
   *               page has to be built again, since a live one is already
   *               further along than any note of where it once was.
   *
   * @param {string} path
   * @param {{ url?: string } | null} [place]
   */
  async function open_ (path, place = null) {
    const held = pages.get(path)
    if (held) {
      touch(held)
      display(held)
      report(held)
      tellFind(held)
      /* The file may have been edited while this tab was away — by hand, by a
         sync, by the copilot. Cheap to check (it is one line) and the file is
         the document, so it is checked. */
      refreshHome(held)
      return
    }

    const page = blankPage(path)
    pages.set(path, page)
    display(page)
    report(page)
    evict()

    let text
    try {
      text = await api.file.read(path)
    } catch {
      pages.delete(path)
      if (open === page) display(null)
      throw new Error('That website file could not be read.')
    }
    /* Read and opened are two moments, and the reader may have moved between
       them: the tab may have been closed, or closed and this file opened again
       in another. A page record is in the table only while it is the live page
       for its path, so its own identity answers both — anything past here
       would be painting into somebody else's tab. */
    if (pages.get(path) !== page) return

    const said = readAddress(text)
    page.home = said.url
    page.title = said.title
    page.notes = said.notes
    const wanted = place?.url || page.home
    if (wanted) load(page, wanted)
    else showBlank(page)
    report(page)
  }

  /** The file's own line, re-read for a page that was already open. */
  async function refreshHome (page) {
    let text
    try { text = await api.file.read(page.path) } catch { return }
    if (pages.get(page.path) !== page) return
    const said = readAddress(text)
    page.notes = said.notes
    if (said.title) page.title = said.title
    if (said.url === page.home) return
    const wasHome = page.url === page.home
    page.home = said.url
    // Only a page still sitting where the file put it follows the file. One the
    // reader clicked away from is theirs, and yanking it back would undo a
    // walk they are in the middle of.
    if (said.url && wasHome) load(page, said.url)
    report(page)
  }

  /**
   * The reader has moved to another document. The page stays alive and stays
   * where it is; it is only taken off the screen and told to be quiet.
   */
  function leave () {
    if (!open) return
    const page = open
    open = null
    if (page.guest) page.guest.hidden = true
    if (page.card) page.card.hidden = true
    setMuted(page, true)
    report(null)
  }

  /** This file is no longer open anywhere: end its page. */
  function forget (path) {
    const page = pages.get(path)
    if (!page) return
    destroy(page)
    pages.delete(path)
    if (open === page) { open = null; report(null) }
  }

  /** The document on screen is being closed. */
  function close () {
    if (!open) return
    forget(open.path)
  }

  /** Every page ended — the window is changing vaults, or shutting. */
  function closeAll () {
    for (const path of [...pages.keys()]) forget(path)
  }

  /**
   * The file changed on disk under an open tab — a hand edit, a sync, the
   * copilot. The file is the document, so the page follows it.
   */
  function rehome (text) {
    if (!open) return
    const said = readAddress(text)
    open.notes = said.notes
    if (said.title) open.title = said.title
    if (said.url === open.home) { report(open); return }
    open.home = said.url
    if (said.url) load(open, said.url)
    else { destroy(open); showBlank(open) }
    report(open)
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
    if (!open) return false
    const url = normaliseAddress(input)
    if (!url) return false
    /* The page being asked for is not the page being left, so nothing the old
       one was called describes it. Cleared rather than left to the first
       `page-title-updated`, which does not come for a document that has none. */
    const page = open
    page.pageTitle = ''
    page.favicon = ''
    load(page, url)
    report(page)
    await saveHome()
    /* Said after the save, not by `load` above: at the moment the page starts
       loading the file still names wherever it pointed a second ago, so the
       test `load` makes — is this the file's own address? — can only answer
       no. It is the file's own address by the time the write lands, and the
       title the page is about to announce is this file's to keep. */
    if (page.url === page.home) {
      page.settling = true
      /* And asked once here, because a small page can be loaded, titled and
         finished before the write above comes back — in which case both of the
         moments that would have kept the title have already gone by. */
      keepTitle(page)
    }
    return true
  }

  /**
   * Write the page's own name into the file, leaving the address alone.
   *
   * This is what makes a website file findable: search reads the `#` line (see
   * `isIndexedDocumentExt` in electron/main.js), so without it a bookmark is
   * reachable only by already knowing what the file was called.
   */
  async function keepTitle (page) {
    if (!page.path || !page.home || !page.settling) return
    const title = page.pageTitle
    if (!title || title === page.title) return
    try {
      await api.file.write(page.path, writeAddress({ url: page.home, title, notes: page.notes }))
    } catch { return }
    if (pages.get(page.path) === page) { page.title = title; report(page) }
  }

  /** Make the file name the page that is actually on screen. */
  async function saveHome () {
    if (!open || !open.path || !open.url) return
    const page = open
    const url = page.url
    const title = page.pageTitle || page.title || ''
    if (url === page.home && title === page.title) return
    try {
      await api.file.write(page.path, writeAddress({ url, title, notes: page.notes }))
    } catch {
      // The page is still on screen and still where the reader put it; only
      // the record of it failed, and the button stays offering to try again.
      return
    }
    if (pages.get(page.path) === page) {
      page.home = url
      page.title = title
      report(page)
    }
  }

  const back = () => { if (ask(open, 'canGoBack')) open.guest.goBack() }
  const forward = () => { if (ask(open, 'canGoForward')) open.guest.goForward() }
  const reload = () => {
    if (!open) return
    if (open.guest) open.guest.reload()
    else if (open.url) load(open, open.url)
  }
  const stop = () => { try { open?.guest?.stop() } catch { /* gone */ } }

  /* ------------------------------------------------------------- finding

     A guest keeps its own text out of reach — which is why ⌘F used to answer
     "find does not reach inside a web page". It does not have to reach: a
     <webview> searches itself and answers with a tally, which is exactly what
     the bar over a PDF shows. So the bar is the same bar, and what differs is
     only who does the looking.
     ================================================================== */

  /** A fresh search over the page. An empty query takes the highlight off. */
  function find (query, { matchCase = false } = {}) {
    if (!open?.guest) return
    const text = String(query || '')
    open.find.query = text
    if (!text.trim()) { clearFind(); return }
    try {
      /* `findNext` is deliberately not passed. Its documented default is
         false — a new search — but passing that value *explicitly* makes
         Chromium answer with no `found-in-page` event at all, so the bar sat
         there with a query and no tally. Omitted, the same call reports the
         match count it always did. Stepping passes `findNext: true`, which is
         the only value that behaves as written. */
      open.guest.findInPage(text, { matchCase })
    } catch { /* the guest is not up yet; the next keystroke asks again */ }
  }

  /** The next or previous match of the search already running. */
  function stepFind (by, { matchCase = false } = {}) {
    if (!open?.guest || !open.find.query.trim()) return
    try {
      open.guest.findInPage(open.find.query, { matchCase, findNext: true, forward: by >= 0 })
    } catch { /* gone */ }
  }

  function clearFind () {
    if (!open) return
    open.find = { query: '', at: 0, total: 0 }
    try { open.guest?.stopFindInPage('clearSelection') } catch { /* gone */ }
    tellFind(open)
  }

  /* -------------------------------------------------------------- reading

     The page's own words, for the copilot and for clipping it into a note.

     This is the one thing in here that reaches *into* a guest, so it is worth
     being exact about what it is: a script that reads `innerText` and returns
     a string. It runs in the page's own world, on the reader's explicit ask,
     and nothing of Tulip's travels the other way — the guest still has no
     preload, no Node and no channel back. What it buys is the difference
     between an assistant that can be asked about the page you are reading and
     one that can only be told its address.
     ================================================================== */

  async function text () {
    if (!open?.guest || !open.url) return null
    try {
      const read = await open.guest.executeJavaScript(`(() => {
        const article = document.querySelector('article, main, [role="main"]')
        const body = (article || document.body)
        return {
          title: document.title || '',
          text: (body && body.innerText) || ''
        }
      })()`)
      const whole = String(read?.text || '').replace(/\n{3,}/g, '\n\n').trim()
      return {
        url: open.url,
        title: read?.title || open.pageTitle || open.title || '',
        text: whole.slice(0, MAX_PAGE_TEXT),
        truncated: whole.length > MAX_PAGE_TEXT
      }
    } catch {
      return null
    }
  }

  /* -------------------------------------------------------------- zoom */

  /**
   * Resize the page, on the stops the window's own zoom uses.
   *
   * Every open page, not only the one on screen: the size is the reader's, not
   * the document's, and a tab coming back at last week's zoom would be the one
   * place in the app where that was not true.
   *
   * @param {1|-1|'fit'} step  in one stop, out one stop, or back to actual size
   */
  function setZoom (step) {
    if (step === 'fit') scale = 1
    else scale = stepZoom(scale, step)
    applyZoom()
    return scale
  }

  /** The size, onto every page there is. */
  function applyZoom () {
    for (const page of pages.values()) {
      try { page.guest?.setZoomFactor(scale) } catch { /* gone */ }
    }
    report(open)
  }

  return {
    open: open_,
    leave,
    close,
    closeAll,
    forget,
    rehome,
    goTo,
    saveHome,
    back,
    forward,
    reload,
    stop,
    setZoom,
    /* The size the reader last left the web at, put back at launch. Not
       `setZoom`, which walks the stops one at a time and would have to be
       called a dozen times to arrive at 175%. */
    restoreZoom: (value) => {
      const wanted = Number(value)
      if (!Number.isFinite(wanted) || wanted <= 0) return
      scale = wanted
      applyZoom()
    },
    find,
    stepFind,
    clearFind,
    text,
    url: () => open?.url || '',
    home: () => open?.home || '',
    /* Where this tab is, for the trail. `url` rather than a scroll offset: a
       page that has had to be rebuilt reloads from scratch, and the one thing
       worth carrying across that is which page it was. */
    place: () => ({ url: open?.url || '' }),
    focus: () => { try { open?.guest?.focus() } catch { /* gone */ } },
    state: snapshot
  }
}
