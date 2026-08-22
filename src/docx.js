/* ================================================================= docx
   A Word document, on screen as the document it is — and editable.

   The reading and the writing are electron/docx.js's: it unzips the file,
   parses WordprocessingML into blocks and runs, and puts a save back together
   out of them. Everything here is the page in between. That split is the
   point: the awkward half (a zip of XML with three levels of indirection
   between a list item and the fact that it is numbered) is testable under
   plain Node, and this half is testable in a window.

   Two things are worth knowing before reading on.

   The first is what a save costs. Tulip does not serialise a Word document
   from its own model — that would drop every part of Word it does not draw.
   It splices: a paragraph nobody touched goes back into the file as the bytes
   it arrived as, and only a paragraph the reader edited is written afresh from
   its properties and its runs. So a save can only lose what was *inside a
   paragraph the reader was editing* — a field, a footnote mark, a comment
   anchor. `fragile` says whether the document holds any of those at all, and
   the reader is told once, before the first keystroke, rather than after the
   save.

   The second is what is editable. The words, their emphasis, and which heading
   a paragraph is. Not the layout: a document's own fonts, sizes, colours,
   spacing and table borders are Word's answer to a page of paper, and they are
   carried through untouched rather than reproduced in Tulip's type and written
   back as something subtly different. Making a list, a table or a picture is
   Word's job too — this edits documents it did not invent.
   ================================================================== */

import { el } from './dom.js'
import { revealLabel } from './platform.js'

/* Word says nine heading levels and HTML has six. Anything deeper is still a
   heading — it is simply drawn at the smallest one. */
const headingTag = (level) => `h${Math.min(Math.max(level, 1), 6)}`

/** The marks a run can carry, as the classes they are drawn with. */
const MARKS = [
  ['bold', 'is-bold'],
  ['italic', 'is-italic'],
  ['underline', 'is-underline'],
  ['strike', 'is-strike'],
  ['mark', 'is-marked']
]

/* What the browser's own bold and italic commands leave behind. They are undone
   into this app's own spans immediately — see `normalize` — so the DOM a save
   reads has exactly one way of saying "this is bold". */
const TAG_MARKS = {
  B: 'bold', STRONG: 'bold', I: 'italic', EM: 'italic', U: 'underline', S: 'strike', STRIKE: 'strike'
}

/** What a run says, as the one string that decides whether it still says it.
 *  A paragraph whose signature has not moved is a paragraph the file already
 *  holds, and is put back as the bytes it arrived as. */
const signature = (runs) => runs.map((run) => (run.raw
  ? `raw:${run.raw.length}`
  : [run.break ? '\n' : run.text, run.rpr || '', run.vert || '',
      run.hyper?.id || '', run.hyper?.anchor || '',
      ...MARKS.map(([key]) => (run[key] ? key[0] : ''))].join(''))).join('')

/**
 * Mount the viewer into `host`. One instance for the life of the window, like
 * every other viewer here.
 *
 * @param host          the pane this draws into
 * @param docx          `api.docx` — `read` and `write`
 * @param file          the renderer's `api.file`, for the two buttons
 * @param openExternal  a link out of the app, for the document's own links
 * @param ask           the app's own way of asking, for the one question
 *                      editing a Word document has to ask
 * @param onDirty       told when the page and the file stop matching
 * @param onSaved       told that a write landed
 * @param onStatus      told what the status bar should say about the document
 * @param onWarn        told when something the reader asked for did not happen
 */
export function mountDocx ({
  host, docx, file, openExternal,
  ask = /** @type {(q: any) => Promise<boolean>} */ (async () => true),
  onDirty = /** @type {(dirty: boolean) => void} */ (() => {}),
  onSaved = /** @type {() => void} */ (() => {}),
  onStatus = /** @type {(text: string) => void} */ (() => {}),
  onWarn = /** @type {(text: string) => void} */ (() => {})
}) {
  /** @type {any} */
  let current = null
  /** @type {any} */
  let page = null
  let readonly = false
  let dirty = false
  /** @type {Promise<any> | null} */
  let saving = null
  /** @type {any} */
  let saveTimer = null
  /* Whether the reader has been told what editing this particular document
     costs. Asked once, at the first edit, and not again while it is open — a
     question repeated is a question people stop reading. */
  let warned = false
  /* Bumped by every edit. A save writes the page as it was at one of these and
     may only call it clean if none has landed since — the same bargain the grid
     and the notebook make with their own buffers. */
  let revision = 0

  /* The parts of the file this app carries rather than understands: paragraph
     properties, run properties, whole runs holding a picture, and the
     relationship a hyperlink names. Held here and referred to from the DOM by
     index, because an index survives what an editable page does to the elements
     holding it — a paragraph split in two keeps the attributes of the one it
     came from, and both halves therefore keep its style. */
  /** @type {{ ppr: string[], rpr: string[], raw: string[], hyper: any[], tables: any[] }} */
  let kept = { ppr: [], rpr: [], raw: [], hyper: [], tables: [] }

  const keep = (list, value) => {
    const at = list.indexOf(value)
    if (at !== -1) return at
    list.push(value)
    return list.length - 1
  }

  /* A signature no paragraph can have, for a paragraph that must be rewritten
     whatever its words now say — one whose style just changed, or one that was
     never in the file to begin with. */
  let stamps = 0
  const restamp = (node) => { node.dataset.sig = `changed:${++stamps}` }

  host.classList.add('docx')

  /* ------------------------------------------------------------- drawing */

  /** One run: its text, its picture, or the break it stands for. */
  function drawRun (run) {
    if (run.break) return document.createElement('br')
    if (run.image) {
      const img = document.createElement('img')
      img.className = 'docx-img'
      img.src = run.image.src
      img.alt = run.image.alt || ''
      /* The size Word laid it out at, as an attribute rather than a style, so
         the stylesheet's `max-width` can still shrink a picture wider than the
         column while the space it will take is known before it decodes. */
      if (run.image.width) img.width = run.image.width
      if (run.image.height) img.height = run.image.height
      /* A picture is carried, never rewritten: the run it came from — drawing,
         anchoring and all — is what goes back into the file. */
      if (run.raw) img.dataset.raw = String(keep(kept.raw, run.raw))
      return img
    }

    const marks = MARKS.filter(([key]) => run[key]).map(([, className]) => className)

    const node = document.createElement(run.vert === 'sup' || run.vert === 'sub' ? run.vert : 'span')
    node.textContent = run.text || ''
    if (marks.length) node.className = marks.join(' ')
    node.dataset.rpr = String(keep(kept.rpr, run.rpr || ''))

    if (!run.href) return node
    /* A link in a Word document points out of the vault, so it is drawn as a
       link and opened the way every other external link in the app is — in the
       browser, not in this window, which has no way back. */
    const link = document.createElement('a')
    link.className = 'docx-link'
    link.href = run.href
    link.title = run.href
    if (run.hyper) link.dataset.hyper = String(keep(kept.hyper, run.hyper))
    link.append(node)
    return link
  }

  const drawRuns = (parent, runs) => {
    for (const run of runs) parent.append(drawRun(run))
    // An empty paragraph is a blank line in the document, and a <p> with
    // nothing in it has no height — nor anywhere to put a caret.
    if (!runs.length) parent.append(document.createElement('br'))
  }

  /** The element a paragraph or heading is drawn as, remembering enough about
   *  where it came from to be put back there. */
  function drawParagraph (block) {
    const node = document.createElement(block.type === 'heading' ? headingTag(block.level) : 'p')
    node.className = block.type === 'heading' ? 'docx-h' : 'docx-p'
    if (block.align) node.style.textAlign = block.align
    /* The two styles that are a shape rather than a name: Word's quote styles
       are how a pulled-out passage is written, and its caption style is what
       sits under a picture. Every other style name is left alone — the
       document's own fonts and colours are not Tulip's to reproduce. */
    if (/quote/i.test(block.style || '')) node.classList.add('is-quote')
    if (/caption/i.test(block.style || '')) node.classList.add('is-caption')
    node.dataset.ppr = String(keep(kept.ppr, block.ppr || ''))
    if (block.at) node.dataset.at = block.at.join(',')
    node.dataset.sig = signature(block.runs)
    drawRuns(node, block.runs)
    return node
  }

  function drawTable (block) {
    const table = el('table', 'docx-table')
    const head = document.createElement('thead')
    const body = document.createElement('tbody')

    block.rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      row.cells.forEach((cell, c) => {
        // A cell continuing a vertical merge holds nothing; the cell above it
        // is drawn spanning down instead. It still goes back into the file, so
        // the model keeps it — see `tableItem`.
        if (cell.continues) return
        const td = document.createElement(row.head ? 'th' : 'td')
        if (cell.span > 1) td.colSpan = cell.span
        td.dataset.cell = `${r}.${c}`
        drawBlocks(td, cell.blocks)
        tr.append(td)
      })
      ;(row.head ? head : body).append(tr)
    })

    if (head.childElementCount) table.append(head)
    table.append(body)
    /* Its own scroller: a Word table is as wide as its author made it, and a
       wide one must not push the whole page sideways. */
    const frame = el('div', 'docx-table-frame')
    /* A table is edited cell by cell and never restructured, so the whole of it
       — its grid, its borders, the cells nobody can see — is held aside, and
       the edited cells are put back into it. */
    frame.dataset.tbl = String(keep(kept.tables, block))
    if (block.at) frame.dataset.at = block.at.join(',')
    frame.append(table)
    return frame
  }

  /**
   * Blocks into elements, gathering runs of list paragraphs into the lists
   * they describe.
   *
   * Word has no list element: each item is an ordinary paragraph that names a
   * numbering and a level, and the list is the run of them. So the nesting is
   * rebuilt here — a stack of open <ul>/<ol>, deepened when the level rises and
   * closed when it falls — which is what makes a sub-list indent rather than
   * appear as another item of its parent.
   */
  function drawBlocks (parent, blocks) {
    /** @type {{ level: number, ordered: boolean, node: any }[]} */
    let open = []

    const closeTo = (depth) => { open = open.slice(0, Math.max(depth, 0)) }

    for (const block of blocks) {
      const list = block.type === 'paragraph' ? block.list : null
      if (!list) {
        open = []
        parent.append(block.type === 'table' ? drawTable(block) : drawParagraph(block))
        continue
      }

      // A level deeper than the one before it starts a list inside the last
      // item; the same level or shallower continues or closes back to one.
      closeTo(list.level + 1)
      let top = open[open.length - 1]
      if (!top || top.level !== list.level || top.ordered !== list.ordered) {
        const node = document.createElement(list.ordered ? 'ol' : 'ul')
        node.className = 'docx-list'
        const into = open.length ? open[open.length - 1].node.lastElementChild : null
        ;(into || parent).append(node)
        top = { level: list.level, ordered: list.ordered, node }
        open.push(top)
      }

      /* An <li> rather than a <p>, but the same paragraph either way: it
         carries the same properties, and its numbering is in them. `data-li` is
         how the rest of this file knows it is inside a list. */
      const drawn = drawParagraph(block)
      const item = document.createElement('li')
      item.className = 'docx-li'
      for (const key of Object.keys(drawn.dataset)) {
        item.dataset[key] = /** @type {any} */ (drawn.dataset)[key]
      }
      item.dataset.li = '1'
      if (block.align) item.style.textAlign = block.align
      item.append(...drawn.childNodes)
      top.node.append(item)
    }
  }

  /** The two things that can always be done with a file Tulip did not invent. */
  function actions (path) {
    const row = el('div', 'docx-actions')

    const open = el('button', 'fileview-btn is-primary', 'Open with default app')
    open.type = 'button'
    open.addEventListener('click', async () => {
      // Word and Tulip must not both hold unsaved versions of one file, so what
      // is on screen goes to disk before the file is handed over.
      await saveFile({ flush: true }).catch(() => {})
      const result = await file.openDefault(path)
      if (!result?.ok) onWarn(result?.error || 'The system could not open that file.')
    })

    const reveal = el('button', 'fileview-btn', revealLabel())
    reveal.type = 'button'
    reveal.addEventListener('click', () => { file.reveal(path).catch(() => {}) })

    row.append(open, reveal)
    return row
  }

  /* --------------------------------------------------- reading it back

     The other direction: the page as the runs and blocks a save is built from.
     Everything an editable page can do to itself has to be read here — a span
     the browser split in two, a <b> its own bold command left behind, a bare
     text node typed into an empty paragraph. */

  /** The runs of one paragraph element, gathering marks from every ancestor
   *  between the text and the paragraph. */
  function runsIn (node, inherited = /** @type {any} */ ({})) {
    /** @type {any[]} */
    const runs = []

    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue) runs.push({ ...inherited, text: child.nodeValue })
        continue
      }
      if (!(child instanceof HTMLElement)) continue

      if (child.tagName === 'BR') { runs.push({ ...inherited, break: true }); continue }
      if (child.tagName === 'IMG') {
        const raw = kept.raw[Number(child.dataset.raw)] || ''
        if (raw) runs.push({ raw })
        continue
      }
      // A nested list is a block of its own, not part of this paragraph.
      if (child.tagName === 'UL' || child.tagName === 'OL') continue

      const style = { ...inherited }
      if (TAG_MARKS[child.tagName]) style[TAG_MARKS[child.tagName]] = true
      for (const [key, className] of MARKS) if (child.classList.contains(className)) style[key] = true
      if (child.tagName === 'SUP') style.vert = 'sup'
      if (child.tagName === 'SUB') style.vert = 'sub'
      if (child.dataset.rpr !== undefined) style.rpr = kept.rpr[Number(child.dataset.rpr)] || ''
      if (child.dataset.hyper !== undefined) style.hyper = kept.hyper[Number(child.dataset.hyper)]

      runs.push(...runsIn(child, style))
    }

    /* Two runs alike side by side are one run. The browser makes them freely —
       typing at the join of two spans, a formatting command splitting one — and
       a file that gained a run boundary per keystroke is a file Word slowly
       fills with noise. */
    const merged = []
    for (const run of runs) {
      const last = merged[merged.length - 1]
      if (last && !last.break && !run.break && !last.raw && !run.raw &&
        signature([{ ...last, text: '' }]) === signature([{ ...run, text: '' }])) {
        last.text = (last.text || '') + (run.text || '')
      } else merged.push({ ...run })
    }
    return merged.filter((run) => run.raw || run.break || (run.text || '') !== '')
  }

  /** One paragraph as the item a save is built from: kept where nothing in it
   *  changed, rewritten where something did. */
  function paragraphItem (node) {
    const runs = runsIn(node, { rpr: '' })
    const at = node.dataset.at ? node.dataset.at.split(',').map(Number) : null
    if (at && node.dataset.sig === signature(runs)) return { at, keep: true }
    return { at, p: { ppr: kept.ppr[Number(node.dataset.ppr)] || '', runs } }
  }

  /**
   * The plan for a save: the items, and for each one the element it was read
   * from and what that element said at the time.
   *
   * The second half is what the write's reply is applied to. A save moves every
   * offset in the file, so each element has to be told where its paragraph now
   * is — and told what it said when the payload was built, so that a keystroke
   * that landed while the write was in flight still reads as a change.
   */
  function plan () {
    /** @type {{ node: any, sig: string }[]} */
    const marks = []
    const items = itemsIn(page, marks)
    return { items, marks }
  }

  /** A table as its item: the original, with whatever was typed into its cells
   *  put back in place. A table nobody edited is kept whole. */
  function tableItem (frame) {
    const original = kept.tables[Number(frame.dataset.tbl)]
    const at = frame.dataset.at ? frame.dataset.at.split(',').map(Number) : null
    const edited = new Map()
    for (const found of frame.querySelectorAll('[data-cell]')) {
      const cell = /** @type {any} */ (found)
      edited.set(cell.dataset.cell || '', cell)
    }
    let changed = false

    const rows = original.rows.map((row, r) => ({
      trpr: row.trpr,
      cells: row.cells.map((cell, c) => {
        const drawn = edited.get(`${r}.${c}`)
        // A continuation cell is never drawn, so nothing can have happened to
        // it; it goes back as the paragraphs it arrived as.
        const items = drawn
          ? itemsIn(drawn)
          : cell.blocks.map((block) => ({ at: block.at, keep: true }))
        if (items.some((item) => !item.keep)) changed = true
        return { tcpr: cell.tcpr, items }
      })
    }))

    if (!changed && at) return { at, keep: true }
    return { at, tbl: { props: original.props, rows } }
  }

  /**
   * Every block inside an element, in the order the document reads them.
   *
   * `marks`, where one is passed, collects the element each item came from and
   * the signature it had — see `plan`. Nothing else needs it, so a cell being
   * read for a table item passes none.
   */
  function itemsIn (node, marks = /** @type {{ node: any, sig: string }[] | null} */ (null)) {
    const items = []
    const take = (item, from) => {
      items.push(item)
      if (marks) marks.push({ node: from, sig: item.p ? signature(item.p.runs) : from.dataset.sig })
    }
    for (const kid of node.children) {
      const child = /** @type {any} */ (kid)
      if (child.classList.contains('docx-actions')) continue
      if (child.classList.contains('docx-table-frame')) { take(tableItem(child), child); continue }
      if (child.tagName === 'UL' || child.tagName === 'OL') {
        for (const item of itemsIn(child, marks)) items.push(item)
        continue
      }
      if (child.tagName === 'LI') {
        /* The item, then whatever list hangs inside it — which is the order the
           file states them in: a sub-list follows the item it belongs to. */
        take(paragraphItem(child), child)
        for (const inner of child.children) {
          if (inner.tagName === 'UL' || inner.tagName === 'OL') {
            for (const item of itemsIn(inner, marks)) items.push(item)
          }
        }
        continue
      }
      take(paragraphItem(child), child)
    }
    return items
  }

  /* ------------------------------------------------------------- history

   The page as it stood before each change, and the caret with it.

   Snapshots rather than the patches the grid keeps, because the thing being
   changed is a DOM and not a list of rows — and because a snapshot is the only
   record that puts back what the *save* needs as well as what the reader sees:
   the ranges, the properties and the signatures all live in the elements, and a
   patch that restored the words alone would leave a paragraph claiming to be a
   part of the file it no longer matches.

   Typing coalesces. Every keystroke as its own step is an undo that has to be
   held down, and neither the editor nor the grid does that; a run of typing
   with no pause longer than a breath is one change. */

  const HISTORY_LIMIT = 80
  const TYPING_PAUSE_MS = 800

  /** @type {{ html: string, caret: { start: number, end: number } | null }[]} */
  let past = []
  /** @type {{ html: string, caret: { start: number, end: number } | null }[]} */
  let future = []
  /* The page as of the last change — which is the page as it stands *before*
     the next one, and therefore what that change has to record. */
  /** @type {{ html: string, caret: { start: number, end: number } | null } | null} */
  let previous = null
  let lastKind = ''
  let lastChangeAt = 0

  const snapshot = () => (page ? { html: page.innerHTML, caret: offsetsIn(page) } : null)

  function restore (entry) {
    if (!page || !entry) return
    page.innerHTML = entry.html
    if (entry.caret) placeCaret(page, entry.caret.start, entry.caret.end)
  }

  /** Record that a change of this kind is about to be made. */
  function record (kind) {
    const at = Date.now()
    const coalesce = kind === 'type' && lastKind === 'type' && at - lastChangeAt < TYPING_PAUSE_MS
    lastChangeAt = at
    lastKind = kind
    // A burst of typing keeps the state it started from and does not replace
    // it; the whole burst is what an undo takes back.
    if (coalesce) return
    if (previous) {
      past.push(previous)
      if (past.length > HISTORY_LIMIT) past.shift()
    }
    future = []
    previous = null
  }

  /** ⌘Z and ⇧⌘Z. Answers whether there was anything to step through. */
  function history (redo) {
    if (!editable()) return false
    const stack = redo ? future : past
    if (!stack.length) return false
    const here = snapshot()
    const entry = stack.pop()
    if (here) (redo ? past : future).push(here)
    restore(entry)
    previous = snapshot()
    lastKind = ''
    revision++
    setDirty(true)
    current.words = countWords()
    onStatus(summary())
    queueSave()
    return true
  }

  /* ------------------------------------------------------------- editing */

  const editable = () => Boolean(current) && !readonly

  function setDirty (next) {
    if (dirty === next) return
    dirty = next
    onDirty(next)
  }

  /** Something changed. Every editing path here ends in this, so the dirty
   *  flag, the word count, the history and the autosave cannot disagree.
   *
   *  `kind` is what the history coalesces on: a run of typing is one step, and
   *  anything else is a step of its own. */
  function touched (kind = 'edit') {
    record(kind)
    previous = snapshot()
    revision++
    setDirty(true)
    current.words = countWords()
    onStatus(summary())
    queueSave()
  }

  /**
   * The one question editing a Word document has to ask, asked before the first
   * edit rather than after it.
   *
   * Only where the answer is not "nothing". A save rewrites the paragraphs that
   * changed and splices the rest back byte for byte, so for most documents
   * there is nothing to lose and nothing to ask about. Where one does hold
   * fields, comments or tracked changes, the reader gets one sentence naming
   * them and the choice of taking it to Word instead.
   */
  async function allowed () {
    if (warned || !current?.fragile?.length) return true
    warned = true
    const yes = await ask({
      title: 'Edit this Word document in Tulip?',
      detail: 'Tulip rewrites only the paragraphs you change and leaves the rest ' +
        'of the file exactly as Word wrote it. What it cannot carry through a ' +
        `paragraph you edit: ${current.fragile.join('; ')}.`,
      go: 'Edit here'
    })
    if (!yes) setReadonly(true)
    return yes
  }

  /** Where the selection is, as character offsets inside `node`. */
  function offsetsIn (node) {
    const selection = window.getSelection()
    if (!selection || !selection.rangeCount) return null
    const range = selection.getRangeAt(0)
    if (!node.contains(range.startContainer)) return null
    const before = range.cloneRange()
    before.selectNodeContents(node)
    before.setEnd(range.startContainer, range.startOffset)
    const start = before.toString().length
    return { start, end: start + range.toString().length }
  }

  /** Put the caret back at a character offset inside `node`. */
  function placeCaret (node, start, end = start) {
    const range = document.createRange()
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let at = 0
    let done = 0
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const length = text.nodeValue?.length || 0
      if (!done && at + length >= start) { range.setStart(text, start - at); done = 1 }
      if (done && at + length >= end) { range.setEnd(text, end - at); done = 2; break }
      at += length
    }
    if (done !== 2) { range.selectNodeContents(node); range.collapse(false) }
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  /* Where the caret was last seen inside the page.
   *
   * Every command that acts on "the paragraph you are in" is reached from the
   * command palette, and opening the palette takes the focus — and the
   * selection — into its own text field. Asking the live selection at that
   * point answers "nowhere", which is why making a list from the palette used
   * to do nothing at all. */
  /** @type {any} */
  let lastParagraph = null
  /** @type {any} */
  let lastCell = null

  document.addEventListener('selectionchange', () => {
    if (!page) return
    const node = window.getSelection()?.anchorNode
    if (!node || !page.contains(node)) return
    const element = node instanceof HTMLElement ? node : node.parentElement
    lastParagraph = element?.closest('.docx-p, .docx-h, .docx-li') || lastParagraph
    lastCell = element?.closest('td, th') || null
  })

  /** The paragraph, list item or table-cell paragraph the caret is in — or the
   *  last one it was in, for a command reached from the palette. */
  function hereParagraph () {
    const node = window.getSelection()?.anchorNode
    const element = node && page?.contains(node)
      ? (node instanceof HTMLElement ? node : node.parentElement)
      : null
    const here = element?.closest('.docx-p, .docx-h, .docx-li')
    if (here) return /** @type {any} */ (here)
    return page?.contains(lastParagraph) ? lastParagraph : null
  }

  /**
   * Redraw one paragraph from what it now says, keeping the selection where it
   * was.
   *
   * Run after the browser's own formatting commands, which leave `<b>` and
   * `<u>` elements behind and split spans wherever the selection ended. Reading
   * the paragraph back and drawing it again turns that into the one shape a
   * save understands — and it is cheap, because it is one paragraph.
   */
  function normalize (node) {
    const where = offsetsIn(node)
    const runs = runsIn(node, { rpr: '' })
    node.replaceChildren()
    drawRuns(node, runs)
    if (where) placeCaret(node, where.start, where.end)
  }

  /** ⌘B, ⌘I, ⌘U and strike-through, over whatever is selected. */
  async function mark (what) {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    if (!node) return
    /* The browser's own command, immediately undone into this app's spelling of
       the same thing. Toggling by hand would mean deciding what a selection
       crossing three runs and half of a fourth means — which `execCommand`
       already decides the way people expect. */
    document.execCommand(what)
    normalize(node)
    touched()
  }

  /**
   * Make the paragraph the caret is in a heading, or an ordinary paragraph
   * again.
   *
   * The style is named, not drawn: "Heading 2" means whatever this document's
   * own stylesheet says it means, which is why a document without one says so
   * rather than writing a name nothing defines.
   */
  async function setHeading (level) {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    if (!node) return
    if (node.dataset.li) { onWarn('A list item cannot be a heading.'); return }
    const styleId = level ? current.headingStyles[level] : ''
    if (level && !styleId) {
      onWarn(`This document has no Heading ${level} style for Tulip to apply.`)
      return
    }

    /* `w:pStyle` is the first child `w:pPr` may have, so putting the new one at
       the front is not a shortcut — it is where the schema says it goes. */
    const rest = String(kept.ppr[Number(node.dataset.ppr)] || '')
      .replace(/^<w:pPr>/, '').replace(/<\/w:pPr>$/, '')
      .replace(/<w:pStyle[^>]*\/>/, '')
    const inner = (styleId ? `<w:pStyle w:val="${styleId}"/>` : '') + rest

    const where = offsetsIn(node)
    const drawn = drawParagraph({
      type: level ? 'heading' : 'paragraph',
      level,
      runs: runsIn(node, { rpr: '' }),
      align: null,
      style: '',
      ppr: inner ? `<w:pPr>${inner}</w:pPr>` : '',
      at: node.dataset.at ? node.dataset.at.split(',').map(Number) : null
    })
    // Its words did not change; its style did, and only a signature that can
    // never match says so to the save.
    restamp(drawn)
    node.replaceWith(drawn)
    if (where) placeCaret(drawn, where.start, where.end)
    touched()
  }

  /* ---------------------------------------------------------------- lists

     Word states a list twice: the paragraph names a numbering, and the
     numbering — in a part of its own — says what the bullets are. Only the
     first half is written here. Which numbering to name is left to the save,
     which resolves it against the document being written into; see
     `numberingFor` in electron/docx.js. That is what lets a document with no
     lists in it gain one without this file knowing what a `w:abstractNum` is. */

  /** The placeholders the save resolves. Kept in step with electron/docx.js by
   *  the contract test, which is the only place the two can be compared. */
  const LIST_PLACEHOLDER = { bullet: 'TULIP_BULLET', ordered: 'TULIP_ORDERED' }

  /** A paragraph's properties, with its numbering taken out or put in. */
  function withList (ppr, sort, level = 0) {
    const inner = String(ppr || '')
      .replace(/^<w:pPr>/, '').replace(/<\/w:pPr>$/, '')
      .replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, '')
    if (!sort) return inner ? `<w:pPr>${inner}</w:pPr>` : ''
    const numPr = `<w:numPr><w:ilvl w:val="${level}"/>` +
      `<w:numId w:val="${LIST_PLACEHOLDER[sort]}"/></w:numPr>`
    /* `w:numPr` follows `w:pStyle` in the schema's sequence, and a style is the
       only one of its earlier siblings this app ever writes. */
    const style = /^<w:pStyle[^>]*\/>/.exec(inner)
    const at = style ? style[0].length : 0
    return `<w:pPr>${inner.slice(0, at)}${numPr}${inner.slice(at)}</w:pPr>`
  }

  /**
   * Make the paragraph the caret is in a list item, or an ordinary paragraph
   * again.
   *
   * @param {'bullet' | 'ordered' | null} sort
   */
  async function setList (sort) {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    if (!node) return
    const inList = Boolean(node.dataset.li)
    if (!sort && !inList) return
    const where = offsetsIn(node)

    /* Built afresh rather than reclassed: a list item is drawn inside its list
       and a paragraph is not, so the two are different elements in different
       places, carrying the same runs and the same properties. */
    const drawn = drawParagraph({
      type: 'paragraph',
      runs: runsIn(node, { rpr: '' }),
      align: null,
      style: '',
      ppr: withList(kept.ppr[Number(node.dataset.ppr)] || '', sort),
      at: node.dataset.at ? node.dataset.at.split(',').map(Number) : null
    })
    restamp(drawn)

    let landed = drawn
    if (!sort) {
      unwrapItem(node, drawn)
    } else {
      const item = document.createElement('li')
      item.className = 'docx-li'
      for (const key of Object.keys(drawn.dataset)) {
        item.dataset[key] = /** @type {any} */ (drawn.dataset)[key]
      }
      item.dataset.li = '1'
      item.append(...drawn.childNodes)
      landed = item
      if (inList) unwrapItem(node, item, sort)
      else wrapInList(node, item, sort)
    }

    if (where) placeCaret(landed, where.start, where.end)
    touched()
  }

  /**
   * Take an item out of its list, and put `made` where it was.
   *
   * `sort` says what to put it back as: a list of that sort where it is given,
   * and a plain paragraph where it is not. Either way the items that followed
   * are left behind in a list of their own — which is what the file will say
   * too, since each of those paragraphs still names the numbering it did.
   */
  function unwrapItem (item, made, sort = /** @type {'bullet' | 'ordered' | null} */ (null)) {
    const list = item.parentElement
    if (!list) return
    const siblings = [...list.children]
    const after = siblings.slice(siblings.indexOf(item) + 1)

    if (sort) {
      const wanted = sort === 'ordered' ? 'ol' : 'ul'
      if (list.tagName.toLowerCase() === wanted && !after.length) {
        // The same sort of list and the last item of it: nothing to split.
        item.replaceWith(made)
        return
      }
      const moved = document.createElement(wanted)
      moved.className = 'docx-list'
      moved.append(made)
      list.after(moved)
      if (after.length) {
        const rest = document.createElement(list.tagName.toLowerCase())
        rest.className = list.className
        rest.append(...after)
        moved.after(rest)
      }
    } else {
      list.after(made)
      if (after.length) {
        const rest = document.createElement(list.tagName.toLowerCase())
        rest.className = list.className
        rest.append(...after)
        made.after(rest)
      }
    }

    item.remove()
    if (!list.children.length) list.remove()
  }

  /** Put a new list around one item, joining the list above it where there is
   *  one of the same sort. */
  function wrapInList (node, item, sort) {
    const wanted = sort === 'ordered' ? 'OL' : 'UL'
    const above = node.previousElementSibling
    if (above?.tagName === wanted && above.classList.contains('docx-list')) above.append(item)
    else {
      const list = document.createElement(sort === 'ordered' ? 'ol' : 'ul')
      list.className = 'docx-list'
      list.append(item)
      node.after(list)
    }
    node.remove()
  }

  /** Return: a second paragraph, in the same style and the same list, holding
   *  whatever was to the right of the caret. */
  async function splitParagraph () {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    const where = node && offsetsIn(node)
    if (!node || !where) return

    const before = []
    const after = []
    let at = 0
    for (const run of runsIn(node, { rpr: '' })) {
      const length = run.text ? run.text.length : 1
      if (at + length <= where.start) before.push(run)
      else if (at >= where.end) after.push(run)
      else if (run.text) {
        const head = run.text.slice(0, Math.max(0, where.start - at))
        const tail = run.text.slice(Math.max(0, where.end - at))
        if (head) before.push({ ...run, text: head })
        if (tail) after.push({ ...run, text: tail })
      }
      at += length
    }

    node.replaceChildren()
    drawRuns(node, before)
    restamp(node)

    /* A heading is a title, and Return at the end of one starts the text under
       it rather than a second title. Everywhere else the new paragraph is the
       same kind as the one it came out of — which is what keeps Return inside a
       list making another item of that list. */
    const heading = node.classList.contains('docx-h')
    const made = document.createElement(heading ? 'p' : node.tagName)
    made.className = heading ? 'docx-p' : node.className
    /* No `data-at`: there is nowhere in the file it came from, so a save writes
       it out rather than looking for it. */
    made.dataset.ppr = heading ? String(keep(kept.ppr, '')) : (node.dataset.ppr || '0')
    if (!heading && node.dataset.li) made.dataset.li = '1'
    restamp(made)
    drawRuns(made, after)
    node.after(made)
    placeCaret(made, 0)
    touched()
  }

  /* --------------------------------------------------------------- tables

     A table Tulip makes is drawn the way Word draws a plain one: single-line
     borders and columns of equal width across the text. Everything after that
     is the same editing as any other table — the cells are paragraphs, and the
     save rebuilds the table around whichever of them changed. */

  /** A cell's worth of nothing: one empty paragraph, which is what a cell is
   *  when a table has just been made. */
  const emptyCell = () => ({
    blocks: [{ type: 'paragraph', runs: [], align: null, list: null, style: '', ppr: '', at: null }],
    span: 1,
    continues: false,
    tcpr: ''
  })

  /* A page of A4 with Word's default margins is 9,360 twentieths of a point
     across. Stating the widths — rather than leaving the table to be measured
     from its contents — is what keeps the columns even in Word. */
  const TABLE_WIDTH = 9360

  function tableModel (rows, columns) {
    const width = Math.floor(TABLE_WIDTH / columns)
    const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')
    const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="auto"/>`).join('')
    return {
      type: 'table',
      at: null,
      props: `<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>` +
        `<w:tblGrid>${grid}</w:tblGrid>`,
      rows: Array.from({ length: rows }, (_, r) => ({
        head: r === 0,
        trpr: r === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '',
        cells: Array.from({ length: columns }, emptyCell)
      }))
    }
  }

  /** Put a table under the paragraph the caret is in. */
  async function insertTable (rows = 3, columns = 3) {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    const frame = drawTable(tableModel(Math.max(rows, 1), Math.max(columns, 1)))
    const list = node?.dataset.li ? node.parentElement : node
    if (list) list.after(frame)
    else page.insertBefore(frame, page.firstChild)
    placeCaret(frame.querySelector('.docx-p') || frame, 0)
    touched()
  }

  /** The table the caret is in, and where in it. */
  function hereCell () {
    const node = window.getSelection()?.anchorNode
    const element = node && page?.contains(node)
      ? (node instanceof HTMLElement ? node : node.parentElement)
      : null
    const cell = element?.closest('td, th') ||
      (page?.contains(lastCell) ? lastCell : null)
    const frame = cell?.closest('.docx-table-frame')
    if (!cell || !frame || !page?.contains(frame)) return null
    const [row, column] = String(/** @type {any} */ (cell).dataset.cell || '0.0').split('.').map(Number)
    return { frame, cell, row, column, table: kept.tables[Number(/** @type {any} */ (frame).dataset.tbl)] }
  }

  /**
   * Add or remove a row or a column of the table the caret is in.
   *
   * The model is changed and the table drawn again from it, rather than the DOM
   * being patched: every cell carries the row and column it is, a save reads
   * those back, and keeping two accounts of that in step by hand is how a table
   * ends up saved with a cell in the wrong place.
   */
  /**
   * Read what has been typed into a table's cells back into the model it was
   * drawn from.
   *
   * Every structural change redraws the table from that model, so anything the
   * model does not know about is a paragraph the redraw would quietly throw
   * away — which is exactly what a cell typed into a moment before adding a row
   * is. A paragraph that still says what it did keeps its place in the file; a
   * paragraph that does not gives it up, because the bytes at that place are no
   * longer what it says.
   */
  function harvest (frame, table) {
    for (const found of frame.querySelectorAll('[data-cell]')) {
      const drawn = /** @type {any} */ (found)
      const [r, c] = String(drawn.dataset.cell || '').split('.').map(Number)
      const cell = table.rows[r]?.cells[c]
      if (!cell) continue
      cell.blocks = [...drawn.children]
        .filter((node) => node.classList.contains('docx-p') || node.classList.contains('docx-h'))
        .map((node) => {
          const paragraph = /** @type {any} */ (node)
          const runs = runsIn(paragraph, { rpr: '' })
          const kept_at = paragraph.dataset.at ? paragraph.dataset.at.split(',').map(Number) : null
          return {
            type: 'paragraph',
            runs,
            align: null,
            list: null,
            style: '',
            ppr: kept.ppr[Number(paragraph.dataset.ppr)] || '',
            at: paragraph.dataset.sig === signature(runs) ? kept_at : null
          }
        })
    }
  }

  async function editTable (change) {
    if (!editable() || !(await allowed())) return
    const here = hereCell()
    if (!here) { onWarn('Put the caret in a table first.'); return }
    const { table, row, column } = here
    harvest(here.frame, table)
    const columns = table.rows[0]?.cells.length || 1

    if (change === 'row') table.rows.splice(row + 1, 0, {
      head: false, trpr: '', cells: Array.from({ length: columns }, emptyCell)
    })
    else if (change === 'column') for (const line of table.rows) line.cells.splice(column + 1, 0, emptyCell())
    else if (change === 'delete-row') {
      if (table.rows.length < 2) { onWarn('A table needs a row.'); return }
      table.rows.splice(row, 1)
    } else if (change === 'delete-column') {
      if (columns < 2) { onWarn('A table needs a column.'); return }
      for (const line of table.rows) line.cells.splice(column, 1)
    }

    /* Redrawn from the model, and no longer the table that is in the file: its
       shape changed, so a save cannot splice the original back. */
    const redrawn = drawTable({ ...table, at: null })
    here.frame.replaceWith(redrawn)
    const landed = redrawn.querySelector(
      `[data-cell="${Math.min(row, table.rows.length - 1)}.${Math.min(column, (table.rows[0]?.cells.length || 1) - 1)}"] .docx-p`)
    if (landed) placeCaret(landed, 0)
    touched()
  }

  /* --------------------------------------------------------------- saving */

  const queueSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveFile().catch((err) => onWarn(err.message)) }, 900)
  }

  /**
   * Write the document back.
   *
   * What goes over is a list of items rather than a document: mostly ranges of
   * the file already on disk, and the handful of paragraphs that changed. See
   * the account at the top of electron/docx.js for why that is the whole of the
   * fidelity argument.
   */
  async function saveFile ({ flush = false } = {}) {
    if (saving) {
      // A flush must not return before the write it asked for has landed.
      await saving.catch(() => {})
      if (!flush) return true
    }
    if (!current || !dirty || readonly) return true
    clearTimeout(saveTimer)

    const writing = revision
    const path = current.path
    const { items, marks } = plan()
    saving = (async () => {
      const answer = await docx.write(path, {
        stamp: current.stamp,
        body: current.body,
        after: current.after,
        items
      })
      if (!answer?.ok) throw new Error(answer.error || 'That Word document could not be saved.')
      // The document may have been closed, or another one opened, while the
      // write was in flight; what came back is then about a file nobody is
      // looking at.
      if (current?.path !== path) return true

      rekey(answer.document, marks)
      const clean = revision === writing
      /* Only a clean write is a saved file. A keystroke that landed while it
         was in flight leaves the page ahead of the file, and saying otherwise
         would put the tab's dot at odds with what is on disk. */
      if (clean) { setDirty(false); onSaved() } else queueSave()
      return true
    })()

    try {
      return await saving
    } finally {
      saving = null
    }
  }

  /**
   * Tell the page where it now is in the file.
   *
   * A save rewrites `word/document.xml`, so every offset the page is holding is
   * an offset into a document that no longer exists. The reply carries the new
   * reading, whose blocks are one for one with the items that were sent, and
   * this walks the two together: each element is told its paragraph's new range
   * and what it said when the payload was built.
   *
   * The page itself is deliberately not redrawn. A redraw would take the caret
   * with it, and — worse — throw away anything typed while the write was in
   * flight, which is exactly the typing an autosave is most likely to collide
   * with. An element that has moved on since the payload keeps its newer text
   * and its older signature, which is what makes the next save rewrite it.
   */
  function rekey (answer, marks) {
    current.stamp = answer.stamp
    current.body = answer.body
    current.after = answer.after
    current.title = answer.title

    answer.blocks.forEach((block, i) => {
      const mark = marks[i]
      if (!mark || !block.at) return
      mark.node.dataset.at = block.at.join(',')
      if (block.type === 'table') {
        /* A table's cells carry ranges of their own, and they have all moved
           too. The block that came back is the table as it now stands, so it
           replaces the one the page was holding. */
        kept.tables[Number(mark.node.dataset.tbl)] = block
      } else {
        mark.node.dataset.sig = mark.sig
      }
    })
  }

  /* -------------------------------------------------------------- opening */

  /** Draw a document that has been read, and remember what saving it takes. */
  async function paint (answer, path, place) {
    kept = { ppr: [], rpr: [], raw: [], hyper: [], tables: [] }
    host.replaceChildren()

    page = el('article', 'docx-page')
    drawBlocks(page, answer.blocks)
    /* Beside the document rather than inside it: the page's contents are
       replaced wholesale by an undo, and a button that went with them would
       come back without its listener. */
    host.append(page, actions(path))
    /* A pixel offset is the only place a document with no caret and no pages
       has to offer, and it is the right one here: nothing about the page moves
       between two reads of the same file. */
    host.scrollTop = place?.top || 0

    current = {
      path,
      words: answer.words,
      title: answer.title,
      stamp: answer.stamp,
      body: answer.body,
      after: answer.after,
      fragile: answer.fragile || [],
      headingStyles: answer.headingStyles || {}
    }
    applyEditable()
    onStatus(summary())
  }

  /**
   * Put the document at `path` on screen, scrolled where it was left. Throws
   * when it cannot be read, which is what hands the tab back to whatever was
   * open before.
   */
  async function open (path, place = /** @type {{ top: number } | null} */ (null)) {
    const answer = await docx.read(path)
    if (!answer?.ok) throw new Error(answer?.error || 'That Word document could not be read.')
    warned = false
    revision = 0
    past = []
    future = []
    lastKind = ''
    setDirty(false)
    await paint(answer, path, place)
    /* The document as it arrived is the first thing an undo can go back to. */
    previous = snapshot()
    return true
  }

  function close () {
    clearTimeout(saveTimer)
    current = null
    page = null
    setDirty(false)
    host.replaceChildren()
  }

  /** Whether the page takes typing. The Reading view says it does not. */
  function applyEditable () {
    if (!page) return
    page.contentEditable = editable() ? 'true' : 'false'
    /* The app underlines misspellings itself, in the editor, from the vault's
       own dictionary. A second set of red lines from Chromium, under a document
       written somewhere else, is noise. */
    page.spellcheck = false
    host.classList.toggle('is-editing', editable())
  }

  function setReadonly (next) {
    if (readonly === next) return
    readonly = next
    applyEditable()
  }

  /* ------------------------------------------------------------- the keys */

  host.addEventListener('beforeinput', (event) => {
    if (!page || !page.contains(event.target)) return
    if (!editable()) { event.preventDefault(); return }
    if (event.inputType === 'insertParagraph') {
      /* Return is the app's, not the browser's: left alone, Chromium invents a
         <div> or splits the paragraph in a shape of its own, and neither
         carries the style or the numbering the new paragraph inherits. */
      event.preventDefault()
      splitParagraph()
    }
  })

  host.addEventListener('input', () => {
    if (!editable()) return
    /* The one path an ordinary keystroke takes. `allowed` may put the document
       back into its reading view — the reader said take it to Word instead —
       and in that case the keystroke already in the page is undone by drawing
       the document again from the file. */
    allowed().then((yes) => {
      if (yes) touched('type')
      else if (current) open(current.path, { top: host.scrollTop }).catch(() => {})
    })
  })

  /* Pasting brings the formatting of wherever it came from: fonts, colours, and
     a stylesheet's worth of things this app would have to write into a Word
     document as something. The words are what is being pasted. */
  host.addEventListener('paste', (event) => {
    if (!editable()) return
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') || ''
    if (text) document.execCommand('insertText', false, text)
  })

  host.addEventListener('keydown', (event) => {
    if (!editable()) return
    /* Return is the app's, not the browser's: left alone, Chromium clones the
       paragraph it is in — attributes and all — and a second paragraph
       claiming to be the same range of the file is one the save would write
       twice. Taken here rather than only in `beforeinput` because preventing
       it at the key is what stops the browser's own split ever starting. */
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      splitParagraph()
      return
    }
    if (!(event.metaKey || event.ctrlKey)) return
    const key = event.key.toLowerCase()
    /* ⌥⌘1…6 for the heading levels and ⌥⌘0 for body text — the chord Word
       itself uses, and the one Tulip's own outline commands leave free. */
    if (event.altKey && key >= '0' && key <= '6') {
      event.preventDefault()
      setHeading(Number(key))
      return
    }
    if (event.altKey) return
    if (event.shiftKey) {
      if (key === 'x') { event.preventDefault(); mark('strikeThrough') }
      return
    }
    if (key === 'b') { event.preventDefault(); mark('bold') }
    else if (key === 'i') { event.preventDefault(); mark('italic') }
    else if (key === 'u') { event.preventDefault(); mark('underline') }
  })

  /* A link is a link while the document is being read, and a piece of text
     while it is being written: clicking one mid-sentence to put the caret in it
     should not open a browser. ⌘-click follows it either way. */
  host.addEventListener('click', (event) => {
    const link = event.target?.closest?.('a.docx-link')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href') || ''
    if ((editable() && !(event.metaKey || event.ctrlKey)) || !/^https?:/i.test(href)) return
    openExternal(href)
  })

  /* --------------------------------------------------------- what it says */

  /** What the foot of the window says about it: its length, like a note's. */
  const summary = () => {
    if (!current) return ''
    const count = current.words
    return `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`
  }

  /** The document's own title, which is not its file name. The copilot is told
   *  it the way it is told a website's — a model cannot see the page. */
  const title = () => current?.title || ''

  const words = () => current?.words || 0

  /** Counted from the page rather than from the file, so an edit moves it. */
  function countWords () {
    const matched = text().match(
      /[\p{L}\p{N}][\p{L}\p{N}'’-]*|[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/gu)
    return matched ? matched.length : 0
  }

  /**
   * The document as plain text, for the copilot and for the count above.
   *
   * Read off the page rather than the blocks it was drawn from: the blocks are
   * what the file said and the page is what the reader is looking at. A heading
   * keeps its hashes and a table row its tabs, because a run of cells folded
   * into one line is not what the table says.
   */
  function text () {
    if (!page) return ''
    const lines = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.classList.contains('docx-actions')) continue
        if (child.tagName === 'TR') {
          lines.push([...child.children].map((cell) => cell.textContent?.trim() || '').join('\t'))
          continue
        }
        if (child.classList.contains('docx-p') || child.classList.contains('docx-li') ||
          child.classList.contains('docx-h')) {
          const hashes = child.classList.contains('docx-h')
            ? `${'#'.repeat(Math.min(Number(child.tagName.slice(1)) || 1, 6))} `
            : ''
          /* A list item holds its sub-list, whose text belongs to the items
             below rather than to this one. A break is a line break here as
             well: it is one on screen, and the agent is being told what is on
             screen. */
          const own = [...child.childNodes]
            .filter((kid) => !(kid instanceof HTMLElement) ||
              (kid.tagName !== 'UL' && kid.tagName !== 'OL'))
            .map((kid) => (kid instanceof HTMLElement && kid.tagName === 'BR'
              ? '\n'
              : kid.textContent || '')).join('')
          lines.push(hashes + own)
          if (!child.querySelector('ul, ol')) continue
        }
        walk(child)
      }
    }
    walk(page)
    return lines.join('\n')
  }

  /**
   * The document is now at another path — it was renamed, or moved.
   *
   * The bytes did not change, so everything the page is holding about where its
   * paragraphs are is still true; only the name of the file to write them back
   * to has moved. Without this a rename mid-edit leaves the viewer saving to a
   * path that no longer exists, which is a failed write and a lost edit.
   */
  function retarget (path) {
    if (current) current.path = path
  }

  /** Where the reader had got to, for the tab's history and for a reread. */
  const place = () => (current ? { top: host.scrollTop } : null)

  const focus = () => (editable() ? page?.focus() : host.focus())

  return {
    open,
    close,
    focus,
    retarget,
    place,
    summary,
    title,
    words,
    text,
    setReadonly,
    history,
    setList,
    insertTable,
    editTable,
    /** Whether the caret is in a table — the palette asks, so that the rows and
     *  columns are only offered where they mean something. */
    inTable: () => Boolean(hereCell()),
    save: saveFile,
    isDirty: () => dirty
  }
}
