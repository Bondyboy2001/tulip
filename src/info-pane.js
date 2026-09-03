/* ============================================================== info pane
   What the sidebar says about the document in front of you, and the two parts
   of it that write back: the note's own YAML head, and the tags of a file that
   has no head to keep them in.

   Its own module because it is the one pane that *edits*. The outline, the
   backlinks and the spelling panel all read the note and draw what they found;
   this one holds the only editor in the app for a note's frontmatter, and
   getting that wrong means writing a note's head incorrectly rather than
   drawing a list badly. Every write here goes through
   electron/frontmatter.cjs — the one reader and writer — and only ever
   replaces the head, never the document.

   ⚠️ WHERE A TAG LIVES. A Markdown note keeps its tags in its own head, as
   `tags:`, because a tag is part of what the note says about itself and a
   vault is meant to be readable by anything. Filing them beside the vault
   instead — which is what Tulip did — made tags the one piece of a note's
   meaning that did not survive being read by another app. The sidecar remains
   for the kinds with nowhere to put one: a PDF, a Word document, a whiteboard.
   `migrateNoteTags` in electron/main.js moved what the sidecar was holding for
   notes into the notes themselves.

   Wired from renderer.js, the composition root, with the handful of things it
   needs — the same arrangement src/transclude.js and src/sidepane.js use.
   ================================================================== */

import {
  parseFrontmatter, frontmatterRange, propsOf, tagsFromProps,
  writeListProp
} from '../electron/frontmatter.cjs'
import { fileSize } from './units.js'
import { when } from './time.js'
import { headings, headingsFor } from './headings.js'

/** @type {any} */
let deps = null

/**
 * @param el          the DOM registry — `infoPane` and `editorHost`
 * @param api         window.tulip
 * @param node        the element builder
 * @param state       the renderer's state object
 * @param paneOpen    (name) => whether that pane is showing
 * @param togglePane  (name, on) => open or close one
 * @param noteText    () => the open note's text
 * @param ensureEditor  () => a promise of an editor, building one if needed
 * @param editorNow   () => the live editor, or null
 * @param viewing     the four "what kind is open" tests the pane branches on
 * @param isNote      (path) => whether the path names a Markdown note
 * @param systemPath  (path) => the platform's word for it, for a copy label
 * @param copyPaths   (paths) => put them on the clipboard
 */
export function initInfoPane (d) {
  deps = d
  deps.el.editorHost.addEventListener('tulip:tags', () => {
    deps.togglePane('info', true)
    requestAnimationFrame(() => {
      deps.el.infoPane.querySelector('.tag-input')?.focus()
    })
  })
}

/* Count CJK writing one character at a time, and alphabetic words as runs.
   Kept to the ES2022 regex surface the application ships to: the equivalent
   Unicode-set subtraction needs the newer `v` flag and would not parse on the
   oldest supported runtime. The first alternative wins for CJK characters,
   even though they are also Unicode letters. */
const INFO_WORD = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]|[\p{L}\p{N}'’-]+/gu

/**
 * @param {string} label
 * @param {string|number} value
 * @param {string} [title]
 * @param {(() => void)|null} [onClick]
 */
function infoRow (label, value, title, onClick = null) {
  const row = deps.node('div', 'info-row')
  row.append(deps.node('span', 'info-label', label))
  const said = deps.node(onClick ? 'button' : 'span', `info-value${onClick ? ' is-copy' : ''}`, String(value))
  if (title) said.title = title
  if (onClick) {
    said.type = 'button'
    said.setAttribute('aria-label', `Copy ${label.toLowerCase()} path`)
    said.addEventListener('click', onClick)
  }
  row.append(said)
  return row
}

function infoSection (title) {
  const section = deps.node('section', 'info-group')
  section.append(deps.node('h3', 'info-head', title))
  return section
}

/* The last note counted, and what the count came to.

   Four whole-document passes — the frontmatter parse, the word count, the
   wikilink scan and the headings — for a panel that is repainted on every
   250ms typing tick. The text is the whole of the question, so the answer keeps
   until it changes. One entry: the pane is about the note in front of you. */
/** @typedef {{words: number, characters: number, headings: number, links: number}} TextFacts */
/** @type {{text: string|null, facts: TextFacts|null}} */
let factsCache = { text: null, facts: null }

/** @param {string} text @returns {TextFacts} */
function textFacts (text) {
  if (factsCache.text === text && factsCache.facts) return factsCache.facts
  const facts = countTextFacts(text)
  factsCache = { text, facts }
  return facts
}

/** @param {string} text @returns {TextFacts} */
function countTextFacts (text) {
  const parsed = parseFrontmatter(text)
  const body = parsed.range ? text.slice(parsed.range.end) : text
  let words = 0
  const matches = body.matchAll(INFO_WORD)
  while (!matches.next().done) words++
  const links = new Set()
  for (const match of body.matchAll(/(^|[^!])\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    links.add(match[2].trim().toLowerCase())
  }
  return {
    words,
    characters: body.length,
    /* From the text this was handed, not from the parsed document: the Info
       pane is painted on the way into every note, and a note opened into the
       reading view has no parsed document to count. */
    headings: (/** @type {any} */ (deps.editorNow()) && deps.noteText() === text
      ? headingsFor(/** @type {any} */ (deps.editorNow()).state.doc) || []
      : headings(text)).length,
    links: links.size
  }
}

let infoToken = 0

export async function renderInfo ({ force = false } = {}) {
  if (!deps.paneOpen('info')) return
  if (!force && deps.el.infoPane.contains(document.activeElement)) return
  const token = ++infoToken
  if (!deps.state.current) {
    deps.el.infoPane.replaceChildren(deps.node('p', 'outline-empty', 'No document is open.'))
    return
  }
  const path = deps.state.current.path
  /* Last-known tags and stat paint immediately — on a typing tick they are
     already right, and holding the whole pane for two IPC round-trips left
     it blank exactly when the reader glanced at it. */
  const cached = infoCache.get(path)
  if (cached) paintInfo(path, cached.tags, cached.stat)
  /* The stat and the tag list are asked for again only when the last answer
     is old enough to have changed. A typing tick comes every quarter second
     and the two round trips were made on each of them, for a size and a
     modified time that move once per autosave. */
  if (!force && cached && Date.now() - cached.at < INFO_REFRESH_MS) return
  /* Not asked for at all when the document keeps its tags in its own head —
     the sidecar has no entry to give, and this runs on the way into every
     note. */
  const [tags, stat] = await Promise.all([
    hasOwnHead(path) ? [] : deps.api.fileTags.get(path).catch(() => []),
    deps.api.file.info(path).catch(() => null)
  ])
  if (token !== infoToken || !deps.paneOpen('info')) return
  const changed = !cached || !sameTags(cached.tags, tags) || !sameStat(cached.stat, stat)
  infoCache.set(path, { tags, stat, at: Date.now() })
  if (changed) paintInfo(path, tags, stat)
}

const infoCache = new Map() // path -> { tags, stat, at } as last painted
const INFO_REFRESH_MS = 2000

const sameTags = (a, b) => a.length === b.length && a.every((tag, i) => tag === b[i])
const sameStat = (a, b) => (!a && !b) || (!!a && !!b &&
  a.ok === b.ok && a.size === b.size && a.created === b.created && a.modified === b.modified)

/* What the pane was last drawn from. A tick that changes none of it — the
   vault watcher firing for another note, a tag list read back unchanged —
   used to rebuild every row and listener anyway. */
let painted = ''

function paintInfo (path, tags, stat) {
  const textual = !deps.viewing.pdf() && !deps.viewing.site() && !deps.viewing.whiteboard()
  const facts = textual ? textFacts(deps.noteText()) : null
  const signature = [
    path, tags.join('\0'), stat?.ok, stat?.size, stat?.created, stat?.modified,
    facts?.words, facts?.characters, facts?.headings, facts?.links, hasOwnHead(path)
  ].join('\u0001')
  if (signature === painted && deps.el.infoPane.firstChild) return
  painted = signature

  const file = infoSection('File')
  file.append(infoRow('Name', path.split('/').pop()))
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  file.append(infoRow('Folder', folder || 'Vault root', `Copy ${deps.systemPath(folder)}`, () => deps.copyPaths([folder])))
  if (stat?.ok) {
    file.append(infoRow('Size', fileSize(stat.size)))
    if (stat.created) file.append(infoRow('Created', when(stat.created), new Date(stat.created).toLocaleString()))
    file.append(infoRow('Modified', when(stat.modified), new Date(stat.modified).toLocaleString()))
  }

  const sections = [file]
  if (facts) {
    const text = infoSection('Text')
    text.append(infoRow('Words', facts.words.toLocaleString()))
    text.append(infoRow('Characters', facts.characters.toLocaleString()))
    if (facts.headings) text.append(infoRow('Headings', facts.headings))
    if (facts.links) text.append(infoRow('Links out', facts.links))
    sections.push(text)
  }

  /* Where a tag goes depends on whether the file has a head to keep it in. A
     Markdown note does, and that is where it belongs: a tag is part of what
     the note says about itself, and filing it beside the vault made it the one
     piece of a note's meaning that did not survive being read by anything but
     Tulip. Every other kind — a PDF, a Word document, a whiteboard — has
     nowhere to put one, and keeps the sidecar. */
  sections.push(hasOwnHead(path) ? headListSection(path, TAG_PROP) : fileTagSection(path, tags))
  deps.el.infoPane.replaceChildren(...sections)
}

/** Whether the open document is one whose own YAML head the Info pane edits. */
const hasOwnHead = (path) =>
  deps.isNote(path) && !deps.viewing.pdf() && !deps.viewing.site() && !deps.viewing.whiteboard() &&
  !deps.viewing.data() && !deps.viewing.notebook()

/**
 * Tags on a file that cannot hold its own — filed against the path in
 * `.tulip/file-tags.json`, which for a PDF or a whiteboard is the only place
 * there is. Markdown notes went through here too once; they now write their
 * own head, and `electron/main.js`'s `migrateNoteTags` moved what this store
 * was holding for them into the notes themselves.
 */
function fileTagSection (path, tags) {
  const section = infoSection('Tags')
  section.classList.add('is-tags')
  const wrap = deps.node('div', 'tags-editor file-tags-editor')
  const chips = deps.node('div', 'tags-chips')
  const commit = async (next) => {
    await deps.api.fileTags.set(path, next)
    if (deps.state.current?.path === path) renderInfo({ force: true })
  }
  for (const [index, tag] of tags.entries()) {
    chips.append(chipFor(`#${tag}`, `Remove #${tag}`, `Remove tag ${tag}`,
      () => commit(tags.filter((_tag, at) => at !== index))))
  }
  wrap.append(chips, chipInput({
    values: tags,
    className: 'tag-input',
    placeholder: tags.length ? 'Add another tag…' : 'Add a tag…',
    label: 'Add tag',
    commitOn: ['Enter', ','],
    clean: (raw) => raw.trim().replace(/^#+/, '').toLowerCase(),
    same: (a, b) => a === b,
    commit
  }))
  section.append(wrap)
  return section
}

/* The list property the Info pane edits in the note's own head.

   `read` takes the whole parse rather than the matched entry because tags have
   three spellings — a flow list, a block list and the bare `tags: a b` — and
   `tagsFromProps` is the one reader that knows all three, shared with the
   search filter in main so the pane and the search cannot disagree about what
   a note is tagged. */
const TAG_PROP = {
  title: 'Tags',
  key: 'tags',
  matches: (key) => /^tags?$/i.test(key),
  read: (parsed) => tagsFromProps(propsOf(parsed)),
  label: (value) => `#${value}`,
  clean: (raw) => raw.trim().replace(/^#+/, '').toLowerCase(),
  same: (a, b) => a === b,
  className: 'tag-input',
  commitOn: ['Enter', ','],
  addOne: 'Add a tag…',
  addMore: 'Add another tag…',
  addLabel: 'Add tag',
  removeTitle: (value) => `Remove #${value}`,
  removeLabel: (value) => `Remove tag ${value}`
}

/**
 * One list property of the note's head, as removable chips with a field to add
 * one — written through the single frontmatter writer, so every line the head
 * holds that is not this list survives the edit untouched.
 */
function headListSection (path, spec) {
  const section = infoSection(spec.title)
  section.classList.add('is-tags')

  const parsed = parseFrontmatter(deps.noteText())
  const existing = parsed.entries.find((entry) =>
    entry.key !== undefined && spec.matches(entry.key))
  const values = spec.read(parsed)

  const commit = (next) => editHead(path, (now) => writeListProp(now, existing?.key || spec.key, next))

  const wrap = deps.node('div', 'tags-editor file-tags-editor')
  const chips = deps.node('div', 'tags-chips')
  for (const [index, value] of values.entries()) {
    chips.append(chipFor(spec.label(value), spec.removeTitle(value), spec.removeLabel(value),
      () => commit(values.filter((_value, at) => at !== index))))
  }
  wrap.append(chips, chipInput({
    values,
    className: spec.className,
    placeholder: values.length ? spec.addMore : spec.addOne,
    label: spec.addLabel,
    commitOn: spec.commitOn,
    clean: spec.clean,
    same: spec.same,
    commit
  }))
  section.append(wrap)
  return section
}

/**
 * One edit to the open note's head, applied through the editor.
 *
 * `change` is handed the note's text and returns it with the head rewritten —
 * always through `electron/frontmatter.cjs`, the one writer, so a line this
 * pane has no control for survives being edited around.
 *
 * Only the head moves. Replacing the whole document would map the caret to the
 * end and turn one property into a full-note change in the history.
 */
async function editHead (path, change) {
  if (deps.state.current?.path !== path) return
  // Editing the head is editing the note, and the palette-less path here can
  // be reached from the reading view, which has no editor standing yet.
  const view = await deps.ensureEditor()
  const now = view.state.doc.toString()
  const updated = change(now)
  if (updated === now) return
  const oldHead = frontmatterRange(now)?.end ?? 0
  const newHead = frontmatterRange(updated)?.end ?? 0
  view.dispatch({ changes: { from: 0, to: oldHead, insert: updated.slice(0, newHead) } })
  renderInfo({ force: true })
}

/** One chip: its label, and the × that takes it off the list. */
function chipFor (text, removeTitle, removeLabel, onRemove) {
  const chip = deps.node('span', 'tag-chip')
  chip.append(deps.node('span', 'tag-chip-label', text))
  const remove = deps.node('button', 'tag-chip-remove', '×')
  remove.type = 'button'
  remove.title = removeTitle
  remove.setAttribute('aria-label', removeLabel)
  remove.addEventListener('click', onRemove)
  chip.append(remove)
  return chip
}

/** The field under a row of chips: Enter (or a comma, where one is a
 *  separator) adds, and Backspace on an empty field takes the last one back. */
function chipInput ({ values, className, placeholder, label, commitOn, clean, same, commit }) {
  const input = deps.node('input', className)
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = placeholder
  input.setAttribute('aria-label', label)
  const add = () => {
    const fresh = clean(input.value)
    if (!fresh || values.some((one) => same(one, fresh))) return false
    input.value = ''
    commit([...values, fresh])
    return true
  }
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (commitOn.includes(event.key)) {
      event.preventDefault()
      add()
    } else if (event.key === 'Backspace' && !input.value && values.length) {
      event.preventDefault()
      commit(values.slice(0, -1))
    }
  })
  input.addEventListener('blur', add)
  return input
}


/** @type {ReturnType<typeof setTimeout>|null} */
let infoTimer = null

/** A repaint on the next quiet moment — the typing tick's door in. */
export function queueInfo () {
  if (!deps.paneOpen('info')) return
  if (infoTimer != null) clearTimeout(infoTimer)
  infoTimer = setTimeout(renderInfo, 250)
}
