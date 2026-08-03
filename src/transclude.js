/* ========================================================== transclusion
   One note standing inside another.

   `![[Some Note]]` embeds the note itself — `![[Note#Heading]]` just that
   section, and `![[Note#^block]]` one exact block — while hovering any
   `[[wikilink]]` shows the same rendering in a popover. Both are the same act:
   read the note, render its markdown the way the reading view would, and stand
   the result somewhere. This module is that act, done once, so the frame in a
   note and the card under the pointer cannot drift apart.

   Everything app-shaped arrives through `initTransclusion` rather than being
   imported: the markdown renderer, the resolvers and the open calls live in
   renderer.js, which imports this module *and* assets.js — and assets.js
   dispatches note embeds here — so importing back out of either would tie the
   ring shut. The pure helpers (headings, language chips, highlighting, the
   diagram renderers) are imported like anyone else's.

   A fragment is deliberately lighter than the reading view. Web pages and
   PDFs become links rather than live guests — a popover that spawns browser
   processes is a popover you regret hovering — and code blocks get their chip,
   their colours and their diagrams, but no Run or Draw controls: those write
   files under the note they run in, and the block on show belongs to a
   different note.
   ================================================================== */

import {
  anchoredFragment, anchoredSourceRange, installHeadingFolds, splitAnchor
} from './headings.js'
import { languageChip } from './languages.js'
import { highlightInto } from './highlight.js'
import { attachMermaid, isMermaid } from './mermaid.js'
import { attachSvg, isSvg } from './svg.js'
import { routeFragmentClick } from './links.js'
import { noteName } from './vault-paths.js'

let deps = null

/** Handed the app's own machinery once, at startup — see renderer.js. */
export function initTransclusion (d) { deps = d }

/* Deeper than anyone writes on purpose, shallow enough that a chain of notes
   each embedding the next cannot stack the page to the floor. */
const MAX_DEPTH = 4

const dirOf = (path) => String(path).split('/').slice(0, -1).join('/')

/* The run of line breaks and blank lines a section ends on — everything after
   its last line of text. Anchored at the end, and every branch consumes at
   least one character, so it cannot backtrack its way into the content. */
const TRAILING_BLANK = /(?:\r?\n[ \t]*)+$/

/* ------------------------------------------------------------ fragments */

/** The word from the reading view: a picture alone in its block is a figure. */
const standsAlone = (slot) => {
  const host = slot.parentElement?.closest('p, li')
  return !!host && host.textContent.trim() === '' &&
         host.querySelectorAll('.embed-slot').length === 1
}

function fragmentMessage (text) {
  const p = document.createElement('p')
  p.className = 'transclude-empty'
  p.textContent = text
  return p
}

/**
 * What a fragment must not carry out of its note: line addresses and live
 * checkboxes. Every block the renderer emits names the source line it came
 * from, but these lines belong to the *embedded* note — left on, a click on a
 * transcluded task would flip that line of the note being read, and the
 * scroll-position machinery would treat the fragment as part of the file.
 */
function tame (root) {
  for (const node of root.querySelectorAll('[data-line]')) node.removeAttribute('data-line')
  for (const box of root.querySelectorAll('input.task')) box.disabled = true
  for (const table of root.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'table-wrap'
    table.replaceWith(wrap)
    wrap.append(table)
  }
}

/** The reading view's code dressing, minus everything that runs or draws. */
function dressFragmentCode (root) {
  for (const wrap of root.querySelectorAll('.code-wrap[data-lang]')) {
    const lang = wrap.dataset.lang
    const chip = languageChip(lang)
    let head = null
    if (chip) {
      head = document.createElement('div')
      head.className = 'code-head'
      head.append(chip)
      wrap.prepend(head)
    }
    const code = wrap.querySelector('code')
    if (!code) continue
    if (head && isMermaid(lang)) attachMermaid(wrap, code.textContent)
    else if (head && isSvg(lang)) attachSvg(wrap, code.textContent)
    highlightInto(code, code.textContent, lang).catch(() => {})
  }
}

/**
 * Swap a fragment's embed stubs for the real thing, resolving against the
 * folder the *embedded* note lives in — its relative pictures were written
 * from there, not from wherever it is being shown. `chain` is every note
 * above this fragment, which is what stops `![[A]]` in A.
 */
function dressFragmentEmbeds (root, dir, chain, onReady) {
  const slots = [...root.querySelectorAll('.embed-slot')]
  const figures = new Set(slots.filter(standsAlone))

  for (const slot of slots) {
    const { src, alt, w, h, syntax } = slot.dataset
    const size = w || h ? { width: Number(w) || null, height: Number(h) || null } : null
    const spec = deps.specForEmbed({ src, alt, size, syntax }, {
      resolve: (s) => deps.resolveAsset(s, dir),
      resolveNote: deps.resolveNote
    })

    let embed
    if (spec.kind === 'note') {
      embed = renderTransclusion(spec, onReady, chain)
    } else if (spec.kind === 'pdf') {
      embed = deps.fileChip(spec)
    } else if (spec.kind === 'web') {
      const link = document.createElement('a')
      link.className = 'embed-link'
      link.href = spec.url
      link.textContent = spec.label
      link.title = spec.url
      embed = link
    } else {
      embed = deps.renderEmbed(spec, onReady)
    }
    if (figures.has(slot)) embed.classList.add('is-figure')
    slot.replaceWith(embed)
  }
}

/**
 * Fill `body` with the rendered content of a note, or of one section of it.
 * The one function both the frame and the popover stand their content on.
 */
async function fillFragment (body, { path, anchor, chain, onReady }) {
  let text
  try {
    text = await deps.read(path)
  } catch {
    body.replaceChildren(fragmentMessage('This note could not be read.'))
    onReady()
    return
  }

  let source = text
  if (anchor) {
    const cut = anchoredFragment(text, anchor)
    if (cut === null) {
      body.replaceChildren(
        fragmentMessage(
          String(anchor).startsWith('^')
            ? `No block called “${anchor}” in this note.`
            : `No heading called “${anchor}” in this note.`))
      onReady()
      return
    }
    source = cut
  }

  body.innerHTML = deps.md.render(source, { equations: deps.equationIndex(source) })
  tame(body)
  installHeadingFolds(body)
  dressFragmentEmbeds(body, dirOf(path), [...chain, path], onReady)
  dressFragmentCode(body)
  await deps.dressCitations(body, {
    dir: dirOf(path),
    resolve: deps.resolveAsset,
    read: deps.read
  }).catch(() => {})
  onReady()
}

/* --------------------------------------------------------- the embed

   The frame a `![[Note]]` becomes: a hairline box with the note's name at its
   head — a link, so the embed can be walked into — and the fragment below.
   ================================================================== */

/* Every frame on screen, so a note edited on disk repaints wherever it is
   standing. Pruned of frames whose DOM has gone; CodeMirror discards widgets
   without a word, so the set is tidied here rather than notified there. */
const live = new Set()

/**
 * Redraw mounted transclusions — called when the vault changes.
 *
 * `paths` is what actually moved, and a frame showing a note that is not among
 * them has nothing to redraw. Refilling is not cheap: each one re-reads its
 * note over IPC, renders it through markdown-it, and rebuilds the whole
 * fragment's DOM, images included. Without the filter every autosave of the
 * note being *typed into* rebuilt every frame on the page — the watcher fires
 * for the app's own writes too — several times a minute, throwing away and
 * re-decoding pictures nobody had touched.
 *
 * No list means "something changed but not which" — the fallback the watcher
 * uses after it has been re-armed and cannot say what it missed. Everything is
 * redrawn then, because anything might have.
 */
export function refreshTransclusions (paths = null) {
  const moved = paths?.length ? new Set(paths) : null
  for (const frame of [...live]) {
    if (!frame.el.isConnected) { live.delete(frame); continue }
    if (frame.el.classList.contains('is-editing')) continue
    if (moved && !moved.has(frame.path)) continue
    frame.fill()
  }
}

/**
 * The element a note embed becomes, in either view. `ancestors` is the chain
 * of notes already open above this one — absent for a top-level embed, where
 * the chain starts at the note being read.
 */
export function renderTransclusion (spec, onReady = () => {}, ancestors = null) {
  const chain = ancestors || [deps.currentPath()]

  const box = document.createElement('div')
  box.className = `transclude${spec.anchor ? ' is-anchored' : ''}`

  if (chain.includes(spec.path)) {
    box.classList.add('is-cut')
    box.append(fragmentMessage(`“${noteName(spec.path)}” is already open above — embedding it again would never end.`))
    return box
  }
  if (chain.length > MAX_DEPTH) {
    box.classList.add('is-cut')
    box.append(fragmentMessage('Embeds only go this deep.'))
    return box
  }

  const head = document.createElement('div')
  head.className = 'transclude-head'
  const title = document.createElement('a')
  title.className = 'transclude-title'
  /* Note name and heading are separate spans so the crumb can fade the note it
     came from and hold the section it shows, rather than one flat string. */
  const note = document.createElement('span')
  note.className = 'transclude-crumb'
  note.textContent = noteName(spec.path)
  title.append(note)
  if (spec.anchor) {
    const sep = document.createElement('span')
    sep.className = 'transclude-sep'
    sep.textContent = '›'
    const leaf = document.createElement('span')
    leaf.className = 'transclude-leaf'
    leaf.textContent = spec.anchor
    title.append(sep, leaf)
  }
  title.title = 'Open the note' + (spec.anchor ? ' at this heading' : '')
  /* Opened by path rather than through the wikilink machinery: the name may be
     ambiguous in the vault, but the frame knows exactly which file it shows. */
  title.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    hidePreview()
    deps.open(spec.path, spec.anchor, { newTab: e.metaKey || e.ctrlKey })
  })
  // A section already begins with its own heading or block, so repeating the
  // source note and anchor above it adds a second title. Whole-note embeds do
  // still need the note name to say what the borrowed document is.
  if (!spec.anchor) head.append(title)

  const body = document.createElement('div')
  body.className = 'reading note-fragment'

  box.append(head, body)

  const fill = () => fillFragment(body, { path: spec.path, anchor: spec.anchor, chain, onReady })

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'transclude-edit'
  edit.textContent = 'Edit source'
  edit.title = 'Edit this source section here'
  edit.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (box.classList.contains('is-editing')) return

    let baseline
    try { baseline = await deps.read(spec.path) } catch {
      body.replaceChildren(fragmentMessage('This note could not be read.'))
      return
    }
    const range = anchoredSourceRange(baseline, spec.anchor)
    if (!range) {
      body.replaceChildren(fragmentMessage('This embedded section no longer exists.'))
      return
    }

    /* A heading's range runs to the *start* of the next heading's line, so the
       blank line that separates the two sections sits at the end of it. That
       separator belongs to the note's shape rather than to this section, and
       showing it opens the field on a stray empty line — one the reader quite
       reasonably deletes, which is how the gap before the following heading
       goes missing. Hold it aside here and put it back at save time, so the
       field shows the section and nothing else. */
    const tail = range.source.match(TRAILING_BLANK)?.[0] || ''
    const sectionText = tail ? range.source.slice(0, -tail.length) : range.source

    box.classList.add('is-editing')
    edit.disabled = true
    const field = document.createElement('textarea')
    field.className = 'transclude-source'
    field.value = sectionText
    field.spellcheck = false
    field.setAttribute('aria-label', `Markdown source for ${noteName(spec.path)}${spec.anchor ? ` at ${spec.anchor}` : ''}`)

    const message = document.createElement('span')
    message.className = 'transclude-edit-message'
    const controls = document.createElement('div')
    controls.className = 'transclude-edit-controls'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'is-primary'
    save.textContent = 'Save'
    controls.append(message, cancel, save)
    body.replaceChildren(field, controls)

    /* A textarea does not size itself from its value. Start at the source's
       natural height and keep following it as lines are added or removed,
       stopping at the viewport cap where scrolling takes over. A deliberate
       drag of the native resize corner becomes the new floor, so typing after
       making the box larger does not snap it small again. */
    let manualHeight = null
    const fitSource = () => {
      field.style.height = '0px'
      // scrollHeight excludes the border while the border-box height includes
      // it. Put those two pixels back or a perfectly fitted short field still
      // believes it overflows and paints a redundant scrollbar.
      const border = field.offsetHeight - field.clientHeight
      field.style.height = `${Math.max(field.scrollHeight + border, manualHeight || 0)}px`
      field.style.overflowY = field.scrollHeight > field.clientHeight + 1 ? 'auto' : 'hidden'
    }
    field.addEventListener('input', fitSource)
    field.addEventListener('pointerdown', (event) => {
      const rect = field.getBoundingClientRect()
      if (event.clientX < rect.right - 20 || event.clientY < rect.bottom - 20) return
      window.addEventListener('pointerup', () => {
        manualHeight = field.getBoundingClientRect().height
      }, { once: true })
    })
    requestAnimationFrame(fitSource)

    const finish = () => {
      box.classList.remove('is-editing')
      edit.disabled = false
      fill()
    }
    cancel.addEventListener('click', finish)
    save.addEventListener('click', async () => {
      save.disabled = cancel.disabled = true
      message.textContent = 'Saving…'
      let latest
      try { latest = await deps.read(spec.path) } catch {
        message.textContent = 'Could not read the source note.'
        save.disabled = cancel.disabled = false
        return
      }
      if (latest !== baseline) {
        message.textContent = 'The source changed elsewhere. Cancel and reopen this editor.'
        save.disabled = cancel.disabled = false
        return
      }

      /* The separator the field never showed, restored — and any blank lines
         typed at the end folded into it, so a section cannot grow a taller and
         taller gap below it one save at a time. An emptied field deletes the
         section outright, separator and all. */
      const written = field.value.replace(TRAILING_BLANK, '')
      let replacement = written ? written + tail : ''
      if (range.to < baseline.length && replacement && !replacement.endsWith('\n')) replacement += '\n'
      const next = baseline.slice(0, range.from) + replacement + baseline.slice(range.to)
      try {
        await deps.write(spec.path, next)
        baseline = next
        finish()
        refreshTransclusions()
      } catch {
        message.textContent = 'Could not save this source section.'
        save.disabled = cancel.disabled = false
      }
    })
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish() }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        save.click()
      }
    })
    field.focus()
  })
  head.append(edit)

  // The path travels with the frame so a vault change can tell whether this is
  // one of the notes that moved — see `refreshTransclusions`.
  live.add({ el: box, fill, path: spec.path })
  fill()

  return box
}

/* --------------------------------------------------------- the popover

   Hover a wikilink, in either view, and the note it names appears beside the
   pointer — the whole of it for `[[Note]]`, one section for `[[Note#Heading]]`.
   One popover for the whole app, retargeted as the pointer moves; links inside
   it preview too, which is how a trail is followed without opening anything.
   ================================================================== */

const SHOW_AFTER = 420
const HIDE_AFTER = 240

let pop = null
let popFor = null           // the element the popover is standing for
let showTimer = null
let hideTimer = null
let showTicket = 0          // a slow fill must not outlive the hover it served

function hidePreview () {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  showTimer = hideTimer = null
  showTicket++
  if (pop) pop.remove()
  pop = null
  popFor = null
}

/** Also the popover's own grace: leaving the link for the popover is staying. */
function scheduleHide () {
  clearTimeout(hideTimer)
  hideTimer = setTimeout(hidePreview, HIDE_AFTER)
}

/** Below the link where there is room, above it where there is not. */
function place (rect) {
  const pad = 12
  const x = Math.min(Math.max(pad, rect.left), window.innerWidth - pop.offsetWidth - pad)
  let y = rect.bottom + 8
  if (y + pop.offsetHeight > window.innerHeight - pad) y = rect.top - pop.offsetHeight - 8
  pop.style.left = `${Math.round(x)}px`
  pop.style.top = `${Math.round(Math.max(pad, y))}px`
}

async function showPreview (link) {
  const target = link.dataset.wikilink || ''
  const { name, anchor } = splitAnchor(target)
  const path = deps.resolveNote(name)
  if (!path) return

  const ticket = ++showTicket
  const card = document.createElement('div')
  card.className = 'wiki-preview'

  const head = document.createElement('div')
  head.className = 'wiki-preview-head'
  head.textContent = noteName(path)

  const body = document.createElement('div')
  body.className = 'reading note-fragment'
  // The anchored content names the exact place already; repeating the note
  // and raw anchor above it is the same redundant title removed from embeds.
  if (!anchor) card.append(head)
  card.append(body)

  /* Anything clicked in the popover is routed the way the views route it —
     the popover hangs off <body>, where neither view's own handler reaches. */
  card.addEventListener('click', (e) => routeFragmentClick(e, {
    ...deps,
    // Going anywhere dismisses the popover it was going from.
    after: hidePreview
  }))
  card.addEventListener('pointerenter', () => clearTimeout(hideTimer))
  card.addEventListener('pointerleave', scheduleHide)

  /* The measurement is honest only once the content is in, so the card fills
     off-screen and is placed after. The chain starts at the previewed note:
     the popover is not *in* any note, whatever it happens to float over. */
  card.style.visibility = 'hidden'
  await fillFragment(body, { path, anchor, chain: [path], onReady: () => {} })
  if (ticket !== showTicket) return         // the pointer has moved on

  if (pop) pop.remove()
  pop = card
  popFor = link
  document.body.append(card)
  place(link.getBoundingClientRect())
  card.style.visibility = ''
}

/** One set of listeners for the whole app, both views included. */
export function installNotePreview () {
  document.addEventListener('pointerover', (e) => {
    const link = e.target instanceof Element ? e.target.closest('[data-wikilink]') : null
    if (!link) return
    if (link === popFor) { clearTimeout(hideTimer); return }
    clearTimeout(showTimer)
    showTimer = setTimeout(() => showPreview(link), SHOW_AFTER)
  })

  document.addEventListener('pointerout', (e) => {
    const link = e.target instanceof Element ? e.target.closest('[data-wikilink]') : null
    if (!link) return
    const into = e.relatedTarget instanceof Element ? e.relatedTarget : null
    if (into && (link.contains(into) || pop?.contains(into))) return
    clearTimeout(showTimer)
    showTimer = null
    if (pop) scheduleHide()
  })

  document.addEventListener('pointerdown', (e) => {
    if (pop && e.target instanceof Element && !pop.contains(e.target)) hidePreview()
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop) hidePreview()
  })

  /* The page moving under a fixed popover leaves it floating over the wrong
     words. Scrolling inside the popover is the reader reading it. */
  document.addEventListener('scroll', (e) => {
    if (pop && e.target instanceof Element && !pop.contains(e.target)) hidePreview()
  }, { capture: true, passive: true })
}
