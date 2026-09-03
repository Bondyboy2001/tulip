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

   The blocks and runs crossing that boundary are one contract, stated at the
   top of electron/docx.js and pinned there by the round trips in
   scripts/test-docx.cjs; neither side's fields move without the other's.
   ================================================================== */

import { el } from './dom.js'

/* Word says nine heading levels and HTML has six. Anything deeper is still a
   heading — it is simply drawn at the smallest one. */
const headingTag = (level) => `h${Math.min(Math.max(level, 1), 6)}`

/* An A4 sheet at 96 dots to the inch, with the inch of margin Word leaves, and
   the gap between one sheet and the next. The page is drawn at this size and
   scaled down to fit the pane, never reflowed: a page that grew with the window
   would not be a page. */
const SHEET = { width: 794, height: 1123, margin: 96, gap: 28 }
const STRIDE = SHEET.height + SHEET.gap
const SHEET_TEXT = SHEET.height - 2 * SHEET.margin

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
/** What the browser's own editing leaves in a paragraph that a save cannot
 *  read as it stands: one of the tags above, or an inline style. */
const BROWSER_MARKUP = ['[style]', ...Object.keys(TAG_MARKS).map((tag) => tag.toLowerCase())].join(', ')

/** What a run says, as the one string that decides whether it still says it.
 *  A paragraph whose signature has not moved is a paragraph the file already
 *  holds, and is put back as the bytes it arrived as. */
const signature = (runs) => runs.map((run) => (run.raw
  ? `raw:${run.raw.length}`
  : [run.break ? '\n' : run.text, run.rpr || '', run.vert || '',
      run.breakType || '', run.breakClear || '',
      run.highlight || '', run.colour || '',
      run.hyper?.id || '', run.hyper?.anchor || '', run.fld?.instr || '',
      ...MARKS.map(([key]) => (run[key] ? key[0] : ''))].join(''))).join('')

/* Word's highlighter is a pen with sixteen inks, each of them named, and the
   name is what `w:highlight` states. The hex values are what those names have
   always meant on screen; they are held in both directions so that a colour
   Chromium hands back as `rgb(255, 255, 0)` can be recognised as the yellow it
   started out as. */
const HIGHLIGHTS = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#00008b',
  darkCyan: '#008b8b',
  darkGreen: '#006400',
  darkMagenta: '#8b008b',
  darkRed: '#8b0000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#d3d3d3',
  black: '#000000',
  white: '#ffffff'
}

/** `#rrggbb` (or a highlight name) as the `rgb(r, g, b)` string Chromium
 *  answers an inline style with. */
function asRgb (value) {
  const hex = HIGHLIGHTS[value] || String(value || '')
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!match) return String(value || '')
  return `rgb(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)})`
}

/** The highlight name an inline background stands for, or nothing. */
const highlightOf = (css) => Object.keys(HIGHLIGHTS)
  .find((name) => asRgb(name) === css || HIGHLIGHTS[name] === css) || null

/** An inline colour as the `#rrggbb` a `w:color` wants, or nothing. */
function hexOf (css) {
  if (/^#[0-9a-f]{6}$/i.test(String(css || ''))) return String(css).toLowerCase()
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(css || ''))
  if (!match) return null
  return `#${match.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Mount the viewer into `host`. One instance for the life of the window, like
 * every other viewer here.
 *
 * @param host          the pane this draws into
 * @param docx          `api.docx` — `read` and `write`
 * @param openExternal  a link out of the app, for the document's own links
 * @param ask           the app's own way of asking, for the one question
 *                      editing a Word document has to ask
 * @param onDirty       told when the page and the file stop matching
 * @param onSaved       told that a write landed
 * @param onConflict    the file changed on disk under unsaved edits; answers
 *                      whether to write the page over it regardless
 * @param onStatus      told what the status bar should say about the document
 * @param onWarn        told when something the reader asked for did not happen
 */
export function mountDocx ({
  host, docx, openExternal,
  ask = /** @type {(q: any) => Promise<boolean>} */ (async () => true),
  onDirty = /** @type {(dirty: boolean) => void} */ (() => {}),
  onSaved = /** @type {() => void} */ (() => {}),
  onConflict = /** @type {(path: string) => Promise<boolean>} */ (async () => false),
  onStatus = /** @type {(text: string) => void} */ (() => {}),
  onWarn = /** @type {(text: string) => void} */ (() => {})
}) {
  /** @type {any} */
  let current = null
  /** @type {any} */
  let page = null
  /* The sheets drawn under the page, and the frame that scales them both. */
  /** @type {any} */
  let sheets = null
  /** @type {any} */
  let frame = null
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
  /** @type {{ ppr: string[], rpr: string[], raw: string[], hyper: any[], fld: any[], tables: any[] }} */
  let kept = { ppr: [], rpr: [], raw: [], hyper: [], fld: [], tables: [] }
  /* What a carried run *means*, keyed by its index in `kept.raw`: the picture
     it draws, or the note mark it stands for. Held beside the bytes rather
     than in them, because it is the bytes that go back into the file and the
     meaning that decides what the page shows for them. */
  /** @type {Map<number, any>} */
  let rawInfo = new Map()

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

  /** One run: its text, its picture, the break it stands for, or the thing it
   *  carries that this app can only put back. */
  function drawRun (run) {
    if (run.break) {
      /* A page or column break is not a line break, and it is drawn as the
         seam it is — a labelled rule the caret cannot land inside — so that
         the reader can see the document's own pagination and delete it like a
         character. A plain break stays the <br> it has always been. */
      if (run.breakType) {
        const seam = document.createElement('span')
        seam.className = 'docx-break'
        seam.contentEditable = 'false'
        seam.dataset.break = run.breakType
        if (run.breakClear) seam.dataset.clear = run.breakClear
        seam.style.cssText = 'display:block; border-top: 1px dashed currentColor; opacity: 0.35; ' +
          'font-size: 9px; line-height: 1.6; text-align: center; user-select: none;'
        seam.textContent = run.breakType === 'page' ? 'page break' : `${run.breakType} break`
        return seam
      }
      /* Marked as the file's own, so that a bare <br> is known to be one the
         browser put there — see the reading of both in `runsIn`. */
      const br = document.createElement('br')
      br.dataset.br = '1'
      return br
    }
    if (run.image && run.image.src) {
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
      if (run.raw) {
        const at = keep(kept.raw, run.raw)
        img.dataset.raw = String(at)
        rawInfo.set(at, { image: run.image })
      }
      return img
    }
    if (run.raw) {
      /* Something carried rather than drawn: a footnote mark, half a field, a
         bookmark's ends, a picture in a format no browser has. It is one
         uneditable token on the page — deletable whole, like a character — and
         the bytes it stands for go back into the file exactly as they came. */
      const at = keep(kept.raw, run.raw)
      rawInfo.set(at, { image: run.image || null, note: run.note || null })
      const node = document.createElement('span')
      node.className = 'docx-keep'
      node.contentEditable = 'false'
      node.dataset.raw = String(at)
      if (run.note) {
        /* The mark a footnote or a comment leaves in the sentence. The number
           Word draws is the file's to assign, so the page shows the kind. */
        node.style.cssText = 'vertical-align: super; font-size: 0.7em; opacity: 0.7;'
        node.textContent = run.note.kind === 'comment' ? '💬' : `[${run.note.kind}]`
        node.title = `A ${run.note.kind} mark — its text is at the foot of the document.`
      } else if (run.image) {
        /* A picture that is in the file and cannot be drawn: a Windows
           metafile, a picture too large to hand over, or a part that is not
           there. A broken-image icon says the document is damaged; a labelled
           space says what is actually true. */
        node.style.cssText = 'display:inline-block; border: 1px dashed currentColor; opacity: 0.6; ' +
          'padding: 4px 10px; font-size: 12px; user-select: none;'
        node.textContent = run.image.missing === 'format'
          ? `${(run.image.format || 'image').toUpperCase()} picture — Tulip cannot draw this format`
          : run.image.missing === 'size'
            ? 'Picture too large to show'
            : 'Missing picture'
        if (run.image.alt) node.title = run.image.alt
        if (run.image.width) node.style.width = `${run.image.width}px`
        if (run.image.height) node.style.minHeight = `${Math.min(run.image.height, 240)}px`
      }
      return node
    }

    const marks = MARKS.filter(([key]) => run[key]).map(([, className]) => className)

    const node = document.createElement(run.vert === 'sup' || run.vert === 'sub' ? run.vert : 'span')
    node.textContent = run.text || ''
    if (marks.length) node.className = marks.join(' ')
    node.dataset.rpr = String(keep(kept.rpr, run.rpr || ''))
    /* The two valued marks, said twice: the dataset carries the file's own
       word for them, and the inline style is what the reader sees. */
    if (run.highlight) {
      node.dataset.highlight = run.highlight
      node.style.backgroundColor = HIGHLIGHTS[run.highlight] || run.highlight
    }
    if (run.colour) {
      node.dataset.colour = run.colour
      node.style.color = run.colour
    }
    /* A field's result, marked so a save can put the `w:fldSimple` back around
       it — and tinted, because its words are Word's to recompute. */
    if (run.fld?.instr) node.dataset.fld = String(keep(kept.fld, run.fld))

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
    // nothing in it has no height — nor anywhere to put a caret. Marked,
    // because it is the room for a caret and not a break the document holds:
    // read back as one, an empty paragraph gained a <w:br/> every time it was
    // saved, and a blank line in Word became two.
    if (!runs.length) {
      const filler = document.createElement('br')
      filler.dataset.filler = '1'
      parent.append(filler)
    }
  }

  const isList = (node) => node?.tagName === 'UL' || node?.tagName === 'OL'
  const listsIn = (node) => [...node.children].filter(isList)

  /** Draw a paragraph's runs again in place. The sub-list an item holds is
   *  not among its runs, and a redraw that emptied the item took the sub-list
   *  with it — off the page, and off the next save. */
  function redrawRuns (node, runs) {
    const lists = listsIn(node)
    node.replaceChildren()
    drawRuns(node, runs)
    node.append(...lists)
  }

  /** The sub-list an item held goes with it when the item is built afresh:
   *  inside it where it is still an item, after it where it is a paragraph
   *  now — a paragraph cannot hold a list, and the file reads the same. */
  function carryLists (from, to) {
    const lists = listsIn(from)
    if (!lists.length) return
    if (to.tagName === 'LI') to.append(...lists)
    else to.after(...lists)
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
    /* The table's stated width, and its cells' looks below, are read from the
       file for the screen only; the save never writes any of it back, because
       the table's own properties are carried whole. */
    if (block.look?.width) table.style.width = block.look.width

    /* Which <td> is growing down each grid column. A vertically merged cell is
       a continuation row after row, and every continuation is one more row the
       originating cell spans — without which the cells to its right all
       slid one column left, which is how a merged timetable drew with the
       Friday lessons under Thursday. */
    /** @type {Map<number, any>} */
    const growing = new Map()

    block.rows.forEach((row, r) => {
      const tr = document.createElement('tr')
      /* Each row bumps a spanning cell at most once, however many grid columns
         it covers. */
      const bumped = new Set()
      let column = 0
      row.cells.forEach((cell, c) => {
        const wide = cell.span > 1 ? cell.span : 1
        // A cell continuing a vertical merge holds nothing; the cell above it
        // is drawn spanning down instead. It still goes back into the file, so
        // the model keeps it — see `tableItem`.
        if (cell.continues) {
          const above = growing.get(column)
          if (above && !bumped.has(above)) {
            above.rowSpan = (above.rowSpan || 1) + 1
            bumped.add(above)
          }
          column += wide
          return
        }
        const td = document.createElement(row.head ? 'th' : 'td')
        if (cell.span > 1) td.colSpan = cell.span
        td.dataset.cell = `${r}.${c}`
        /* How the file says this cell is drawn: its borders, its fill, its
           width. Without them every Word table looked like the same plain
           grid, whatever its author had done to it. */
        const look = cell.look || {}
        if (look.top) td.style.borderTop = look.top
        if (look.bottom) td.style.borderBottom = look.bottom
        if (look.left) td.style.borderLeft = look.left
        if (look.right) td.style.borderRight = look.right
        if (look.background) td.style.backgroundColor = look.background
        if (look.width) td.style.width = look.width
        drawBlocks(td, cell.blocks)
        tr.append(td)
        for (let reach = column; reach < column + wide; reach++) growing.set(reach, td)
        column += wide
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

  /** A content control standing where a paragraph would — a table of contents,
   *  a cover page. Drawn for reading and closed to editing: what is inside a
   *  `w:sdt` is Word's to rebuild, and a save puts the whole of it back as the
   *  bytes it arrived as. */
  function drawSdt (block) {
    const node = el('div', 'docx-sdt')
    node.contentEditable = 'false'
    if (block.at) node.dataset.at = block.at.join(',')
    node.dataset.sdt = '1'
    node.title = 'A Word content control — edit it in Word.'
    drawBlocks(node, block.blocks || [])
    return node
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
    /** @type {{ level: number, ordered: boolean, numId: string|null, node: any }[]} */
    let open = []

    const closeTo = (depth) => { open = open.slice(0, Math.max(depth, 0)) }

    for (const block of blocks) {
      const list = block.type === 'paragraph' ? block.list : null
      if (!list) {
        open = []
        parent.append(block.type === 'table'
          ? drawTable(block)
          : block.type === 'sdt' ? drawSdt(block) : drawParagraph(block))
        continue
      }

      // A level deeper than the one before it starts a list inside the last
      // item; the same level or shallower continues or closes back to one.
      closeTo(list.level + 1)
      let top = open[open.length - 1]
      /* A different `numId` is a different list, even at the same level: two
         numbered lists with a heading's worth of nothing between them used to
         fold into one <ol> and number straight through. */
      if (!top || top.level !== list.level || top.ordered !== list.ordered ||
        (top.numId ?? null) !== (list.numId ?? null)) {
        closeTo(open.length - (top && top.level === list.level ? 1 : 0))
        const node = document.createElement(list.ordered ? 'ol' : 'ul')
        node.className = 'docx-list'
        /* What the numerals are, and where they start. `w:numFmt` and `w:start`
           are the file's; CSS and the `start` attribute are near enough for the
           screen, and the save never reads either. */
        const styles = {
          decimal: 'decimal',
          lowerRoman: 'lower-roman',
          upperRoman: 'upper-roman',
          lowerLetter: 'lower-alpha',
          upperLetter: 'upper-alpha',
          none: 'none'
        }
        if (list.ordered && list.format && styles[list.format]) {
          node.style.listStyleType = styles[list.format]
        }
        if (list.ordered && Number(list.start) > 1) {
          node.setAttribute('start', String(list.start))
        }
        const into = open.length ? open[open.length - 1].node.lastElementChild : null
        ;(into || parent).append(node)
        top = { level: list.level, ordered: list.ordered, numId: list.numId ?? null, node }
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

  /* --------------------------------------------------- reading it back

     The other direction: the page as the runs and blocks a save is built from.
     Everything an editable page can do to itself has to be read here — a span
     the browser split in two, a <b> its own bold command left behind, a bare
     text node typed into an empty paragraph. */

  /** The runs of one paragraph element, gathering marks from every ancestor
   *  between the text and the paragraph. */
  function runsIn (node, inherited = /** @type {any} */ ({}), alone = true) {
    /** @type {any[]} */
    const runs = []
    /* Whether `node` holds one thing and nothing else — a sub-list and empty
       text aside — and everything above it did too. A bare <br> in that
       position is the placeholder Chromium leaves in a paragraph emptied by
       Backspace or a cut, and it stands for the same nothing the marked one
       below does. Read as a break, an emptied paragraph was saved with a
       `w:br` in it, and a blank line in Word became two. */
    const content = [...node.childNodes].filter((kid) =>
      !(kid.nodeType === Node.TEXT_NODE && !kid.nodeValue) && !isList(kid))
    const lone = alone && content.length === 1

    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue) runs.push({ ...inherited, text: child.nodeValue })
        continue
      }
      if (!(child instanceof HTMLElement)) continue

      if (child.tagName === 'BR') {
        // The <br> an empty paragraph is drawn with stands for the caret's
        // room rather than for a line break — see `drawRuns` — and so does
        // the one the browser leaves behind on its own when a paragraph is
        // emptied. The file's own break is marked, and read back whole.
        if (child.dataset.filler || (!child.dataset.br && lone)) continue
        runs.push({ ...inherited, break: true })
        continue
      }
      if (child.dataset.break) {
        // The seam a page or column break is drawn as — see `drawRun`.
        runs.push({
          ...inherited,
          break: true,
          breakType: child.dataset.break,
          ...(child.dataset.clear ? { breakClear: child.dataset.clear } : {})
        })
        continue
      }
      if (child.dataset.raw !== undefined) {
        /* A carried run — a picture, a footnote mark, a bookmark's end. The
           bytes go back as they came, and the meaning rides beside them so
           that a redraw of the paragraph still knows what to show. */
        const at = Number(child.dataset.raw)
        const raw = kept.raw[at] || ''
        if (raw) runs.push({ raw, ...(rawInfo.get(at) || {}) })
        continue
      }
      // A nested list is a block of its own, not part of this paragraph.
      if (isList(child)) continue

      const style = { ...inherited }
      if (TAG_MARKS[child.tagName]) style[TAG_MARKS[child.tagName]] = true
      for (const [key, className] of MARKS) if (child.classList.contains(className)) style[key] = true
      /* Chromium's own commands sometimes say it in CSS rather than a tag. */
      const css = child.style
      if (css.fontWeight) style.bold = css.fontWeight === 'bold' || Number(css.fontWeight) >= 600
      if (css.fontStyle) style.italic = css.fontStyle === 'italic'
      if (css.textDecorationLine) {
        /* Added to what the run already carries rather than replacing it: one
           property says both marks, so a span Chromium wrote `line-through` on
           inside an underlined paragraph would otherwise be written back
           struck through and no longer underlined. `none` is the one form that
           means the marks are off. */
        const off = css.textDecorationLine.includes('none')
        style.underline = !off && (style.underline || css.textDecorationLine.includes('underline'))
        style.strike = !off && (style.strike || css.textDecorationLine.includes('line-through'))
      }
      if (child.tagName === 'SUP') style.vert = 'sup'
      if (child.tagName === 'SUB') style.vert = 'sub'
      /* The two valued marks. The dataset is the file's own word for them; an
         inline colour with no dataset is what one of Chromium's commands (or a
         paste) just applied, and it is read back into the nearest thing the
         file can say. */
      if (child.dataset.highlight) { style.mark = true; style.highlight = child.dataset.highlight }
      else if (css.backgroundColor) {
        const named = highlightOf(css.backgroundColor)
        if (named) { style.mark = true; style.highlight = named }
        else if (css.backgroundColor === 'transparent') { delete style.mark; delete style.highlight }
      }
      if (child.dataset.colour) style.colour = child.dataset.colour
      else if (css.color) {
        const hex = hexOf(css.color)
        if (hex) style.colour = hex
      }
      if (child.dataset.rpr !== undefined) style.rpr = kept.rpr[Number(child.dataset.rpr)] || ''
      if (child.dataset.hyper !== undefined) style.hyper = kept.hyper[Number(child.dataset.hyper)]
      if (child.dataset.fld !== undefined) style.fld = kept.fld[Number(child.dataset.fld)]

      runs.push(...runsIn(child, style, lone))
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
   *  put back in place. A table nobody edited is kept whole — and inside one
   *  somebody did edit, every row and cell they did not touch is kept as the
   *  range of the file it still is, so a word typed into one cell cannot cost
   *  the table its bookmarks, its `w:tblPrEx` rows or the wrappers between its
   *  cells. */
  function tableItem (frame) {
    const original = kept.tables[Number(frame.dataset.tbl)]
    const at = frame.dataset.at ? frame.dataset.at.split(',').map(Number) : null
    const edited = new Map()
    for (const found of frame.querySelectorAll('[data-cell]')) {
      const cell = /** @type {any} */ (found)
      edited.set(cell.dataset.cell || '', cell)
    }
    let changed = false

    const rows = original.rows.map((row, r) => {
      let rowChanged = false
      const cells = row.cells.map((cell, c) => {
        const drawn = edited.get(`${r}.${c}`)
        // A continuation cell is never drawn, so nothing can have happened to
        // it; it goes back as the bytes (or the paragraphs) it arrived as.
        const items = drawn
          ? itemsIn(drawn)
          : cell.blocks.map((block) => ({ at: block.at, keep: true }))
        const untouched = items.every((item) => item.keep)
        if (!untouched) { changed = true; rowChanged = true }
        /* The whole cell as the range it was read from, where it has one and
           nothing in it moved. A cell read from an older save may not carry a
           range, and then its paragraphs are kept one by one as before. */
        if (untouched && cell.at) return { at: cell.at, keep: true }
        return { tcpr: cell.tcpr, items }
      })
      if (!rowChanged && row.at) return { at: row.at, keep: true }
      return { trpr: row.trpr, cells, at: row.at || null }
    })

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
      if (child.classList.contains('docx-table-frame')) { take(tableItem(child), child); continue }
      if (child.dataset.sdt) {
        /* A content control kept whole. Nothing inside it is editable, so the
           only two things that can have happened to it are nothing and
           deletion — and a deleted one is simply not here to be taken. */
        const at = child.dataset.at ? child.dataset.at.split(',').map(Number) : null
        if (at) take({ at, keep: true }, child)
        continue
      }
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
  /** @type {{ clone: any, html: string | null, caret: { start: number, end: number } | null } | null} */
  let previous = null
  let lastKind = ''
  let lastChangeAt = 0

  /* Without their pictures. A snapshot used to be the page's innerHTML whole,
     data-URL images included — so a document with a dozen photographs held
     eighty copies of each of them, and the history alone was hundreds of
     megabytes. The bytes of a picture never change between snapshots (this app
     cannot edit one), so the snapshot keeps the `data-raw` key and the source
     is put back from `rawInfo` on restore. */
  const snapshot = () => {
    if (!page) return null
    return { clone: page.cloneNode(true), html: null, caret: offsetsIn(page) }
  }

  /* A snapshot is a clone until something needs it as a string: the copy is
     a third of the cost of the serialisation, and during a burst of typing a
     snapshot is taken on every keystroke and replaced on the next without
     ever being read. Only the one a burst ends on is pushed, and it is
     written out then, once. */
  const html = (entry) => {
    if (entry.html === null) {
      for (const img of entry.clone.querySelectorAll('img[data-raw]')) img.removeAttribute('src')
      entry.html = entry.clone.innerHTML
      entry.clone = null
    }
    return entry.html
  }
  const remember = (stack, entry) => { html(entry); stack.push(entry) }

  function restore (entry) {
    if (!page || !entry) return
    page.innerHTML = html(entry)
    for (const img of page.querySelectorAll('img[data-raw]')) {
      const info = rawInfo.get(Number(/** @type {any} */ (img).dataset.raw))
      if (info?.image?.src) /** @type {any} */ (img).src = info.image.src
    }
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
      remember(past, previous)
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
    if (here) remember(redo ? past : future, here)
    restore(entry)
    ensureParagraph()
    paginate()
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

  /**
   * The page holds at least one paragraph, and nothing outside one.
   *
   * Chromium will take the last paragraph out of a `contenteditable` — select
   * the whole document and press Backspace twice — and leave an <article> with
   * nothing in it. Every command on the bar acts on the paragraph the caret is
   * in, so with no paragraph to be in, all of them silently did nothing; and
   * what was typed afterwards went in as a bare text node, which `itemsIn`
   * reads past and a save therefore threw away. A document has a paragraph,
   * and so does the page drawing it.
   */
  function ensureParagraph () {
    if (!page) return
    const make = (runs) => {
      const made = drawParagraph({
        type: 'paragraph',
        runs,
        align: null,
        style: '',
        /* Nowhere in the file it came from: it is written out rather than
           spliced, which is what puts the paragraph back into the document as
           well as onto the page. */
        ppr: '',
        at: null
      })
      restamp(made)
      return made
    }

    /** @type {any} */
    /** @type {HTMLElement|null} */
    let landed = null
    /* Text the browser left loose in the page rather than in a paragraph. It
       is what was typed into a document with none, and it is the one thing
       here that a save would otherwise lose. */
    for (const node of [...page.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue
      const text = node.nodeValue || ''
      if (!text) { node.remove(); continue }
      landed = make([{ text, rpr: '' }])
      node.replaceWith(landed)
    }
    if (!page.children.length) {
      landed = make([])
      page.append(landed)
    }
    /* The caret was inside what was just replaced, so it has to be put
       somewhere — but only when it was in this page to begin with. */
    if (landed && document.activeElement === page) {
      placeCaret(landed, landed.textContent?.length || 0)
    }
  }

  /** Something changed. Every editing path here ends in this, so the dirty
   *  flag, the word count, the history and the autosave cannot disagree.
   *
   *  `kind` is what the history coalesces on: a run of typing is one step, and
   *  anything else is a step of its own. */
  function touched (kind = 'edit') {
    ensureParagraph()
    record(kind)
    paginate(kind === 'type' ? hereBlock() : null)
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
    if (done !== 2) {
      /* Nothing to land in. An empty paragraph holds one <br>, and a caret put
         *after* it is one Chromium draws on a line of its own — so the caret
         goes before it, where the first letter typed will go. */
      range.selectNodeContents(node)
      range.collapse(done === 0 && !node.textContent)
    }
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

  /** Every paragraph the selection spans, in page order — or the one the caret
   *  is in, for a collapsed selection or a command reached from the palette.
   *  A style asked for over a selection belongs to every line it covers, not
   *  only the one its anchor happened to land in. */
  function selectedParagraphs () {
    const selection = window.getSelection()
    const range = selection && !selection.isCollapsed &&
        page?.contains(selection.anchorNode)
      ? selection.getRangeAt(0)
      : null
    if (!range) return [hereParagraph()].filter(Boolean)
    /* Its own words, not its sub-list's. `intersectsNode` is true of every
       ancestor of a selection, so an item holding the sub-list the selection
       is inside was converted along with it — and taken out of its list, it
       took the sub-list with it. */
    const hit = [...page.querySelectorAll('.docx-p, .docx-h, .docx-li')]
      .filter((node) => [...node.childNodes].some((kid) => !isList(kid) && range.intersectsNode(kid)))
    /* A selection that ends at the very start of the paragraph after — which
       is where a triple-click, or ⇧↓ from the start of a line, leaves its end
       — has selected nothing of it. */
    const last = hit[hit.length - 1]
    if (hit.length > 1 && last.contains(range.endContainer)) {
      const tail = range.cloneRange()
      tail.selectNodeContents(last)
      tail.setEnd(range.endContainer, range.endOffset)
      if (!tail.toString() && !tail.cloneContents().querySelector('img')) hit.pop()
    }
    return hit.length ? hit : [hereParagraph()].filter(Boolean)
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
    redrawRuns(node, runs)
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
    /* With nothing selected the command sets the style the next typing takes,
       and redrawing the paragraph now would throw that away — the <b> the
       typing leaves behind is read back, by `runsIn`, when it is typed. */
    if (window.getSelection()?.isCollapsed) return
    normalize(node)
    touched()
  }

  /* ---------------------------------------------------- more of the bar

     Alignment, the highlighter, the pen, and the one break Word draws a page
     with. Each is written the way the rest of this file writes: the file's own
     vocabulary into `ppr` or the run, the screen's into the element, and a
     restamp so the save knows the paragraph moved. */

  /** How CSS's names for an alignment read in `w:jc`. */
  const JC = { left: 'left', center: 'center', right: 'right', justify: 'both' }

  /** A paragraph's properties with its alignment replaced — or removed, since
   *  "left" is what no `w:jc` at all already means. */
  function withAlign (ppr, align) {
    const inner = String(ppr || '')
      .replace(/^<w:pPr>/, '').replace(/<\/w:pPr>$/, '')
      .replace(/<w:jc[^>]*\/>/, '')
    const jc = align && align !== 'left' ? `<w:jc w:val="${JC[align]}"/>` : ''
    if (!jc) return inner ? `<w:pPr>${inner}</w:pPr>` : ''
    /* `w:jc` comes late in the schema's sequence for `w:pPr` — after the
       numbering, the spacing and the indents, before only the paragraph mark's
       own run properties. Before `w:rPr` where there is one is exactly right;
       the end is right otherwise. */
    const props = /<w:rPr[\s>]/.exec(inner)
    const at = props ? props.index : inner.length
    return `<w:pPr>${inner.slice(0, at)}${jc}${inner.slice(at)}</w:pPr>`
  }

  /** Align every paragraph the selection covers. */
  async function setAlign (align) {
    if (!editable() || !(await allowed())) return
    const nodes = selectedParagraphs()
    if (!nodes.length) return
    const where = offsetsIn(nodes[nodes.length - 1])
    for (const node of nodes) {
      const at = Number(node.dataset.ppr)
      node.dataset.ppr = String(keep(kept.ppr, withAlign(kept.ppr[at] || '', align)))
      node.style.textAlign = align && align !== 'left' ? align : ''
      restamp(node)
    }
    if (where) placeCaret(nodes[nodes.length - 1], where.start, where.end)
    touched()
  }

  /**
   * Highlight the selection in one of Word's sixteen inks, or take the
   * highlight off (`null`). The browser's own command does the splitting, and
   * `normalize` reads its inline background back into the named ink — see
   * `runsIn`, which recognises exactly the palette this writes.
   */
  async function setHighlight (name) {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    if (!node) return
    if (name && !HIGHLIGHTS[name]) { onWarn('Word has no such highlighter.'); return }
    document.execCommand('hiliteColor', false, name ? HIGHLIGHTS[name] : 'transparent')
    if (window.getSelection()?.isCollapsed) return
    normalize(node)
    restamp(node)
    touched()
  }

  /** Colour the selection's text, or put it back (`null`). The same bargain as
   *  the highlighter, through `foreColor`. */
  async function setColour (hex) {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    if (!node) return
    if (hex && !/^#[0-9a-f]{6}$/i.test(hex)) { onWarn('A colour is six hex digits.'); return }
    document.execCommand('foreColor', false, hex || 'inherit')
    if (window.getSelection()?.isCollapsed) return
    normalize(node)
    /* Taking a colour off leaves `inherit`, which `runsIn` cannot read as a
       hex value and rightly drops — but the spans it sits on are still there. */
    if (!hex) for (const span of node.querySelectorAll('[style]')) span.style.color = ''
    normalize(node)
    restamp(node)
    touched()
  }

  /**
   * The runs of a paragraph with `make` applied to everything between two
   * character offsets — the shape a link, and anything else aimed at a
   * stretch of a sentence, is written with. Runs are split at the edges so
   * that half a word can be what changes.
   */
  function overRange (runs, start, end, make) {
    const out = []
    let at = 0
    for (const run of runs) {
      const length = run.text ? run.text.length : 1
      const from = Math.max(at, start)
      const to = Math.min(at + length, end)
      if (to <= from) { out.push(run) } else if (run.text) {
        const head = run.text.slice(0, from - at)
        const middle = run.text.slice(from - at, to - at)
        const tail = run.text.slice(to - at)
        if (head) out.push({ ...run, text: head })
        if (middle) out.push(make({ ...run, text: middle }))
        if (tail) out.push({ ...run, text: tail })
      } else {
        out.push(make(run))
      }
      at += length
    }
    return out
  }

  /**
   * Make the selection a link to `url`, or take the link off (`null`).
   *
   * The relationship a link needs lives in a part the page has never seen, so
   * the page writes the same sort of placeholder a new list does —
   * `TULIP_LINK:<url>` — and the save resolves it against the document being
   * written into. See `resolveLinks` in electron/docx.js. With nothing
   * selected, the URL itself is inserted as the link's text.
   */
  async function insertLink (url) {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    const where = node && offsetsIn(node)
    if (!node || !where) return
    if (url && !/^https?:/i.test(url)) { onWarn('A link starts with http:// or https://.'); return }

    const link = url ? { href: url, hyper: { id: `TULIP_LINK:${url}`, anchor: '' } } : null
    let runs = runsIn(node, { rpr: '' })
    let caret = { start: where.start, end: where.end }
    if (where.start === where.end) {
      if (!url) return
      // Nothing selected: the address is the text, which is what Word does.
      const before = []
      const after = []
      let at = 0
      for (const run of runs) {
        const length = run.text ? run.text.length : 1
        if (at + length <= where.start) before.push(run)
        else if (at >= where.start) after.push(run)
        else if (run.text) {
          before.push({ ...run, text: run.text.slice(0, where.start - at) })
          after.push({ ...run, text: run.text.slice(where.start - at) })
        }
        at += length
      }
      runs = [...before, { text: url, rpr: '', ...link }, ...after]
      caret = { start: where.start + url.length, end: where.start + url.length }
    } else {
      runs = overRange(runs, where.start, where.end, (run) => {
        const made = { ...run }
        delete made.href
        delete made.hyper
        return link ? { ...made, ...link } : made
      })
    }
    node.replaceChildren()
    drawRuns(node, runs)
    restamp(node)
    placeCaret(node, caret.start, caret.end)
    touched()
  }

  /** Put a page break where the caret is — Word's ⌘⏎. */
  async function insertPageBreak () {
    if (!editable() || !(await allowed())) return
    const node = hereParagraph()
    const where = node && offsetsIn(node)
    if (!node || !where) return
    const runs = runsIn(node, { rpr: '' })
    const spliced = []
    let at = 0
    let put = false
    const breakRun = { break: true, breakType: 'page', rpr: '' }
    for (const run of runs) {
      const length = run.text ? run.text.length : 1
      if (!put && at >= where.start) { spliced.push(breakRun); put = true }
      if (!put && run.text && at + length > where.start) {
        spliced.push({ ...run, text: run.text.slice(0, where.start - at) })
        spliced.push(breakRun)
        spliced.push({ ...run, text: run.text.slice(where.start - at) })
        put = true
      } else {
        spliced.push(run)
      }
      at += length
    }
    if (!put) spliced.push(breakRun)
    node.replaceChildren()
    drawRuns(node, spliced)
    restamp(node)
    placeCaret(node, where.start + 1)
    touched()
  }

  /**
   * A list item one level deeper or shallower — Tab and ⇧Tab inside a list.
   *
   * Word's rule, kept: the first item of a list cannot be indented (there is
   * no item for it to be a sub-item of), and an item at the top level cannot
   * be outdented into not being a list item — that is what the list button is
   * for.
   */
  async function indentItem (deeper) {
    if (!editable() || !(await allowed())) return false
    const node = hereParagraph()
    if (!node || !node.dataset.li) return false
    const list = node.parentElement
    if (!list) return false
    const where = offsetsIn(node)

    if (deeper) {
      const above = node.previousElementSibling
      if (!above || above.tagName !== 'LI') return false
      /* Into a sub-list at the end of the item above — joined where one is
         already there, begun where it is not. */
      let sub = [...above.children].reverse()
        .find((kid) => kid.tagName === 'UL' || kid.tagName === 'OL')
      if (!sub) {
        sub = document.createElement(list.tagName)
        sub.className = 'docx-list'
        above.append(sub)
      }
      sub.append(node)
    } else {
      const holder = list.parentElement
      if (!holder || holder.tagName !== 'LI') return false
      /* Out beside the item that holds this list — and everything under it in
         the sub-list stays a sub-list, now of the moved item. */
      const following = [...list.children].slice([...list.children].indexOf(node) + 1)
      if (following.length) {
        const rest = document.createElement(list.tagName)
        rest.className = list.className
        rest.append(...following)
        node.append(rest)
      }
      holder.after(node)
      if (!list.children.length) list.remove()
    }

    /* The file's half: the same numbering, one level up or down. A paragraph
       whose numbering is its own carries a `w:numPr` to rewrite; one that was
       made here carries a placeholder, and the level rides beside it either
       way. */
    const depth = (element) => {
      let steps = -1
      for (let walk = element; walk && walk !== page; walk = walk.parentElement) {
        if (walk.tagName === 'UL' || walk.tagName === 'OL') steps++
      }
      return Math.max(steps, 0)
    }
    const level = depth(node)
    const ppr = String(kept.ppr[Number(node.dataset.ppr)] || '')
    const relevelled = /<w:numPr>/.test(ppr)
      ? ppr.replace(/<w:numPr>([\s\S]*?)<\/w:numPr>/, (whole, inner) => {
          const cleaned = inner.replace(/<w:ilvl[^>]*\/>/, '')
          return `<w:numPr><w:ilvl w:val="${level}"/>${cleaned}</w:numPr>`
        })
      : withList(ppr, list.tagName === 'OL' ? 'ordered' : 'bullet', level)
    node.dataset.ppr = String(keep(kept.ppr, relevelled))
    restamp(node)
    if (where) placeCaret(node, where.start, where.end)
    touched()
    return true
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
    const nodes = selectedParagraphs()
    if (!nodes.length) return
    if (nodes.some(node => node.dataset.li)) {
      onWarn('A list item cannot be a heading.'); return
    }
    const styleId = level ? current.headingStyles[level] : ''
    if (level && !styleId) {
      onWarn(`This document has no Heading ${level} style for Tulip to apply.`)
      return
    }

    /* `w:pStyle` is the first child `w:pPr` may have, so putting the new one at
       the front is not a shortcut — it is where the schema says it goes. */
    const where = offsetsIn(nodes[nodes.length - 1])
    /** @type {HTMLElement|null} */
    let landed = null
    for (const node of nodes) {
      const rest = String(kept.ppr[Number(node.dataset.ppr)] || '')
        .replace(/^<w:pPr>/, '').replace(/<\/w:pPr>$/, '')
        .replace(/<w:pStyle[^>]*\/>/, '')
      const inner = (styleId ? `<w:pStyle w:val="${styleId}"/>` : '') + rest

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
      if (node === nodes[nodes.length - 1]) landed = drawn
    }
    if (where && landed) placeCaret(landed, where.start, where.end)
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

  /** The sort of list a paragraph is in, or nothing where it is not in one. */
  const listOf = (node) => node.dataset.li
    ? (node.parentElement?.tagName === 'OL' ? 'ordered' : 'bullet')
    : null

  /**
   * Make what is selected a list, or ordinary paragraphs again.
   *
   * Every paragraph the selection covers, not only the one the anchor landed
   * in: selecting four lines and pressing the bullet button means four bullets
   * in Word, and it meant one here. The same rule `setHeading` follows, and for
   * the same reason — a command aimed at a selection is about the selection.
   *
   * @param {'bullet' | 'ordered' | null} sort
   */
  async function setList (sort) {
    if (!editable() || !(await allowed())) return
    const nodes = selectedParagraphs()
    if (!nodes.length) return

    /* Asking for the list they are already in means asking to leave it, which
       is what the same button does in Word and what the pressed state on the
       bar has to mean for it to be worth showing. Over a selection it takes
       all of them to mean that: a mix of bullets and plain lines is somebody
       making the whole of it a list, not leaving one. */
    if (nodes.every((node) => listOf(node) === sort)) sort = null
    if (!sort && !nodes.some((node) => node.dataset.li)) return

    /* Where to leave the caret. The last paragraph's own offsets, since that is
       where a selection ends — the same place setHeading puts it back. */
    const where = offsetsIn(nodes[nodes.length - 1])
    /** @type {HTMLElement|null} */
    let landed = null

    for (const node of nodes) {
      const inList = Boolean(node.dataset.li)
      // Already what it is being asked to be, in the mixed selection above.
      if (!sort && !inList) {
        if (node === nodes[nodes.length - 1]) landed = node
        continue
      }

      /* Built afresh rather than reclassed: a list item is drawn inside its
         list and a paragraph is not, so the two are different elements in
         different places, carrying the same runs and the same properties. */
      const drawn = drawParagraph({
        type: 'paragraph',
        runs: runsIn(node, { rpr: '' }),
        align: null,
        style: '',
        ppr: withList(kept.ppr[Number(node.dataset.ppr)] || '', sort),
        at: node.dataset.at ? node.dataset.at.split(',').map(Number) : null
      })
      restamp(drawn)

      let made = drawn
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
        made = item
        if (inList) unwrapItem(node, item, sort)
        else wrapInList(node, item, sort)
        /* Each item is converted where it stands, so a run of them arrives as a
           run of one-item lists — and two adjacent lists draw as two, with the
           numbering starting over at the second. Folding each into the one
           above puts the selection back together as the single list it looks
           like it should be. */
        joinPrevious(item.parentElement)
      }
      carryLists(node, made)
      if (node === nodes[nodes.length - 1]) landed = made
    }

    if (where && landed) placeCaret(landed, where.start, where.end)
    touched()
  }

  /** Fold a list into the one directly above it, where that is a list of the
   *  same sort. What a `.docx` holds is a run of paragraphs each naming a
   *  numbering — the list elements are this viewer's own — so joining two of
   *  them changes what is drawn and nothing about what is saved. */
  function joinPrevious (list) {
    const above = list?.previousElementSibling
    if (!above || above.tagName !== list.tagName) return
    if (!above.classList.contains('docx-list') || !list.classList.contains('docx-list')) return
    above.append(...list.children)
    list.remove()
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
      /* A paragraph cannot sit inside a list item, so one made out of an item
         in a sub-list leaves every list it was inside, and lands after the
         outermost. What followed it at each level continues after it — the
         sub-list's remainder first, then the outer list's — which is the order
         the file states them in, and the shape `drawBlocks` gives a level-one
         item that no level-zero item holds. */
      const chain = []
      for (let held = item, holder = list; holder; held = holder.parentElement, holder = held?.parentElement) {
        chain.push({ list: holder, item: held })
        if (holder.parentElement?.tagName !== 'LI') break
      }
      chain[chain.length - 1].list.after(made)
      let tail = made
      for (const level of chain) {
        const kin = [...level.list.children]
        const following = kin.slice(kin.indexOf(level.item) + 1)
        if (!following.length) continue
        const rest = document.createElement(level.list.tagName.toLowerCase())
        rest.className = level.list.className
        rest.append(...following)
        tail.after(rest)
        tail = rest
      }
      item.remove()
      for (const level of chain) if (!level.list.children.length) level.list.remove()
      return
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

    /* Return on an empty item is how a list ends in Word: the item becomes the
       paragraph after the list, not a second bullet with nothing on it — and
       from a sub-list it climbs one level first, as Word's does. Only with
       nothing selected: Return over a selection replaces the selection, and
       every item it touched used to be taken out of its list instead. */
    if (node.dataset.li && where.start === where.end && !runsIn(node, { rpr: '' }).length) {
      if (node.parentElement?.parentElement?.tagName === 'LI') await indentItem(false)
      else await setList(null)
      return
    }

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

    redrawRuns(node, before)
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
      /* Across the text, which is what Word's own Insert Table does — a table
         sized to its contents would open in Word as three thin slots. */
      props: `<w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>` +
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

  /* ------------------------------------------------------------ find

     ⌘F, on a page CodeMirror has never heard of. The matches are painted with
     the CSS highlight registry rather than by wrapping them in elements,
     because an element inserted into a paragraph would change its signature —
     and a search must never read as an edit. */

  /** @type {any} */
  let findBar = null
  /** @type {Range[]} */
  let found = []
  let foundAt = -1
  let findQuery = ''

  const HIGHLIGHT_STYLE = 'docx-find-style'
  const canHighlight = () => typeof CSS !== 'undefined' && 'highlights' in CSS

  /** A Range over the characters `start`…`end` inside `node` — the walker
   *  `placeCaret` uses, handed back rather than selected. */
  function rangeIn (node, start, end) {
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
    return done === 2 ? range : null
  }

  /** Every match of `query` on the page, paragraph by paragraph. */
  function searchFor (query) {
    found = []
    foundAt = -1
    findQuery = query
    if (!page || !query) { paintFinds(); return 0 }
    const lowered = query.toLowerCase()
    for (const node of page.querySelectorAll('.docx-p, .docx-h, .docx-li')) {
      const text = (node.textContent || '').toLowerCase()
      let from = 0
      for (let hit = text.indexOf(lowered, from); hit >= 0; hit = text.indexOf(lowered, from)) {
        const range = rangeIn(node, hit, hit + query.length)
        if (range) found.push(range)
        from = hit + Math.max(query.length, 1)
      }
    }
    if (found.length) foundAt = 0
    paintFinds()
    return found.length
  }

  /** Show the matches, and where among them the reader is. */
  function paintFinds (scroll = true) {
    if (canHighlight()) {
      if (!document.getElementById(HIGHLIGHT_STYLE)) {
        const style = document.createElement('style')
        style.id = HIGHLIGHT_STYLE
        style.textContent = '::highlight(docx-find) { background: rgba(255, 200, 0, 0.35); }' +
          '::highlight(docx-find-current) { background: rgba(255, 145, 0, 0.75); }'
        document.head.append(style)
      }
      const Painted = /** @type {any} */ (window).Highlight
      CSS.highlights.set('docx-find', new Painted(...found))
      CSS.highlights.set('docx-find-current', foundAt >= 0 ? new Painted(found[foundAt]) : new Painted())
    }
    if (findBar) {
      findBar.querySelector('.docx-find-count').textContent = found.length
        ? `${foundAt + 1} of ${found.length}`
        : (findQuery ? 'no matches' : '')
    }
    if (scroll && foundAt >= 0) {
      const element = found[foundAt].startContainer.parentElement
      element?.scrollIntoView({ block: 'center' })
    }
  }

  function stepFind (forward) {
    if (!found.length) return
    foundAt = (foundAt + (forward ? 1 : -1) + found.length) % found.length
    paintFinds()
  }

  /** Swap the current match for `text`, or all of them. The paragraphs a
   *  replacement lands in are redrawn and restamped, so the save sees them. */
  async function replaceFind (text, everywhere = false) {
    if (!editable() || !(await allowed())) return
    if (!found.length || foundAt < 0) return
    const targets = everywhere ? [...found] : [found[foundAt]]
    const touchedNodes = new Set()
    /* Back to front, so that the ranges still to be replaced are not moved by
       the replacements already made. */
    for (const range of targets.reverse()) {
      const home = range.startContainer.parentElement?.closest('.docx-p, .docx-h, .docx-li')
      if (!home) continue
      range.deleteContents()
      if (text) range.insertNode(document.createTextNode(text))
      touchedNodes.add(home)
    }
    for (const node of touchedNodes) { normalize(node); restamp(node) }
    if (touchedNodes.size) touched()
    searchFor(findQuery)
  }

  function closeFind ({ refocus = true } = {}) {
    if (canHighlight()) {
      CSS.highlights.delete('docx-find')
      CSS.highlights.delete('docx-find-current')
    }
    found = []
    foundAt = -1
    findBar?.remove()
    findBar = null
    if (refocus && current) focus()
  }

  /**
   * Open the find bar (⌘F lands here rather than in the editor's own panel).
   *
   * Also the search API: the controller it returns drives the same panel, so a
   * test — or the palette — can search without typing into the field.
   */
  function find () {
    if (!current) return null
    if (!findBar) {
      findBar = el('div', 'docx-find')
      findBar.style.cssText = 'position: sticky; top: 6px; z-index: 4; float: right; ' +
        'margin: 6px; padding: 5px 8px; border: 1px solid currentColor; border-radius: 6px; ' +
        'display: flex; gap: 6px; align-items: center; font-size: 12px; ' +
        'background: var(--background-primary, Canvas); max-width: 90%;'
      const input = document.createElement('input')
      input.className = 'docx-find-input'
      input.type = 'text'
      input.placeholder = 'Find'
      input.style.cssText = 'width: 150px; font: inherit;'
      const swap = document.createElement('input')
      swap.className = 'docx-find-swap'
      swap.type = 'text'
      swap.placeholder = 'Replace'
      swap.style.cssText = 'width: 120px; font: inherit;'
      const count = el('span', 'docx-find-count')
      count.style.cssText = 'opacity: 0.7; min-width: 5em; text-align: center;'
      const button = (label, title, act) => {
        const made = document.createElement('button')
        made.type = 'button'
        made.textContent = label
        made.title = title
        made.style.cssText = 'font: inherit; padding: 1px 6px;'
        made.addEventListener('click', act)
        return made
      }
      findBar.append(
        input, count,
        button('‹', 'Previous match (⇧⏎)', () => stepFind(false)),
        button('›', 'Next match (⏎)', () => stepFind(true)),
        swap,
        button('Replace', 'Replace this match', () => { replaceFind(swap.value) }),
        button('All', 'Replace every match', () => { replaceFind(swap.value, true) }),
        button('✕', 'Close (Esc)', () => closeFind())
      )
      input.addEventListener('input', () => searchFor(input.value))
      findBar.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); stepFind(!event.shiftKey) }
        if (event.key === 'Escape') { event.preventDefault(); closeFind() }
        // The page's own shortcuts have no business firing from the field.
        event.stopPropagation()
      })
      host.prepend(findBar)
    }
    const input = findBar.querySelector('.docx-find-input')
    /* What is selected is what the reader wants found — the same convention as
       the editor's panel. */
    const selection = window.getSelection()
    const said = selection && !selection.isCollapsed && page?.contains(selection.anchorNode)
      ? selection.toString().slice(0, 200)
      : ''
    if (said) { input.value = said; searchFor(said) } else if (input.value) searchFor(input.value)
    input.focus()
    input.select()
    return {
      query: searchFor,
      count: () => found.length,
      at: () => foundAt,
      next: () => stepFind(true),
      prev: () => stepFind(false),
      replace: (text) => replaceFind(text),
      replaceAll: (text) => replaceFind(text, true),
      close: closeFind
    }
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
      const edit = { stamp: current.stamp, body: current.body, after: current.after, items }
      let answer = await docx.write(path, edit)
      /* The file on disk is no longer the one the page was read from. The
         page's edits cannot be spliced into a stranger, and reopening would
         throw them away — so the host is asked to put the disk's version aside
         (a conflict copy, the same as a note gets), and the write goes again
         against the bytes the page was read from. The reader's version is
         kept, and so is theirs. */
      if (!answer?.ok && answer?.stale && current?.path === path && await onConflict(path)) {
        answer = await docx.write(path, { ...edit, force: true })
      }
      if (!answer?.ok) throw new Error(answer?.error || 'That Word document could not be saved.')
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
      } else if (mark.sig != null) {
        mark.node.dataset.sig = mark.sig
      }
    })
  }

  /* ---------------------------------------------------------------- pages

   The document is one editable column, because everything about editing it —
   the caret, the history, the save — wants one. The pages are drawn under that
   column, and the column is made to honour them: any block that would cross
   from one sheet into the next is pushed down to start on the next, by padding
   that the save never reads and the signatures never see. A block taller than
   a sheet has nowhere to go and simply runs across. */

  /** The blocks a page break can fall between, in order. */
  function leaves (root) {
    const out = []
    for (const kid of root.children) {
      const child = /** @type {any} */ (kid)
      if (child.tagName === 'UL' || child.tagName === 'OL') { out.push(...leaves(child)); continue }
      out.push(child)
      if (child.tagName === 'LI') {
        for (const inner of child.children) {
          if (inner.tagName === 'UL' || inner.tagName === 'OL') out.push(...leaves(inner))
        }
      }
    }
    return out
  }

  /** The height of a block's own lines — for a list item, up to its sub-list. */
  function ownHeight (node) {
    const sub = node.querySelector(':scope > ul, :scope > ol')
    return sub ? sub.offsetTop - node.offsetTop : node.offsetHeight
  }

  /** The block the caret is in, as `leaves` lists it, or null if it is not
   *  in one. For a caret in a nested list this is the outer item, which is
   *  listed before its sub-list: earlier than needed, never later. */
  function hereBlock () {
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    if (!page || !anchor || !page.contains(anchor)) return null
    for (const block of leaves(page)) if (block.contains(anchor)) return block
    return null
  }

  /**
   * Lay the blocks out over the sheets, from `from` onwards.
   *
   * A keystroke changes the height of the block it lands in and of nothing
   * before it, so the paddings above that block are still right and the
   * blocks carrying them are left alone: they stay where they are, and the
   * measurements below take them as they stand. Everything after is done
   * again, as it always was. Without `from` — a document just opened, an
   * undo, an edit whose block is not known — every block is.
   */
  function paginate (from = null) {
    if (!page || !sheets) return
    const all = leaves(page)
    const start = from ? all.indexOf(from) : -1
    const blocks = start > 0 ? all.slice(start) : all
    for (const block of blocks) block.style.paddingTop = ''

    /* One read pass, then arithmetic, then one write pass. Reading and
       writing in the same loop laid the page out once per block: a padding
       given to one paragraph moves every paragraph after it, so each read
       was a fresh layout. Everything is measured with the paddings cleared,
       and the shift each padding adds is carried forward as a number. (A
       `while`, because the pass is one layout and n reads — the shape
       eslint-rules/no-layout-thrash.js asks for and does not report.) */
    const measured = []
    let i = 0
    while (i < blocks.length) {
      const block = blocks[i++]
      measured.push({ top: block.offsetTop, own: ownHeight(block), full: block.offsetHeight })
    }
    const pads = new Array(blocks.length).fill(0)
    let shift = 0
    measured.forEach((m, j) => {
      const top = m.top + shift - SHEET.margin
      const sheet = Math.floor(top / STRIDE)
      const end = sheet * STRIDE + SHEET_TEXT
      const inGap = top >= end
      if (inGap || (top + m.own > end && m.own <= SHEET_TEXT)) {
        pads[j] = (sheet + 1) * STRIDE - top
        shift += pads[j]
      }
    })
    blocks.forEach((block, j) => { if (pads[j]) block.style.paddingTop = `${pads[j]}px` })

    const n = blocks.length
    const bottom = n
      ? measured[n - 1].top + (shift - pads[n - 1]) + measured[n - 1].full + pads[n - 1] - SHEET.margin
      : 0
    const count = Math.max(1, Math.floor(Math.max(bottom - 1, 0) / STRIDE) + 1)
    page.style.minHeight = `${count * STRIDE - SHEET.gap}px`
    while (sheets.children.length > count) sheets.lastChild.remove()
    while (sheets.children.length < count) sheets.append(el('div', 'docx-sheet'))
  }

  /** Scale the sheets down to the pane when it is narrower than a page. */
  function fit () {
    if (!frame) return
    const room = host.clientWidth - 48
    const scale = Math.min(1, Math.max(0.25, room / SHEET.width))
    frame.style.zoom = String(scale)
  }

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fit()).observe(host)

  /* -------------------------------------------------------------- opening */

  /** Draw a document that has been read, and remember what saving it takes. */
  async function paint (answer, path, place) {
    kept = { ppr: [], rpr: [], raw: [], hyper: [], fld: [], tables: [] }
    rawInfo = new Map()
    closeFind({ refocus: false })   // the page it would focus is the one going
    host.replaceChildren()

    frame = el('div', 'docx-frame')
    sheets = el('div', 'docx-sheets')
    page = el('article', 'docx-page')
    drawBlocks(page, answer.blocks)
    /* A document whose body holds no paragraph at all — one this app itself
       used to be able to write, before `ensureParagraph` — is drawn with the
       one it needs to be typed into again. */
    ensureParagraph()
    frame.append(sheets, page)

    /* What sits around the body: the headers and footers, the notes, the
       comments. Each is a part of its own in the file and is untouched by any
       save, so all of them are drawn outside the editable page — and outside
       the frame, whose geometry the pagination is counted against — greyed, to
       be read and not written. A document with none of them gets none. */
    const aside = (className, title) => {
      const made = el('aside', className)
      made.contentEditable = 'false'
      made.style.cssText = 'opacity: 0.65; font-size: 0.85em; user-select: text;'
      if (title) {
        const head = el('div', 'docx-aside-title')
        head.style.cssText = 'font-weight: 600; opacity: 0.8; margin: 0.8em 0 0.3em;'
        head.textContent = title
        made.append(head)
      }
      return made
    }
    const band = (list, kind) => {
      const said = (list || []).filter((one) => one.kind === kind)
      if (!said.length) return null
      const made = aside(`docx-${kind}s`, '')
      made.style.cssText += 'border: 1px dashed currentColor; border-radius: 4px; ' +
        'padding: 4px 10px; margin: 4px 0; white-space: pre-wrap;'
      made.title = `The document's ${kind} — Word lays it out on every page.`
      for (const one of said) {
        const line = el('div', `docx-${kind}`)
        line.textContent = one.type === 'default' ? one.text : `(${one.type} pages) ${one.text}`
        made.append(line)
      }
      return made
    }
    const header = band(answer.margins, 'header')
    if (header) host.append(header)
    host.append(frame)
    const footer = band(answer.margins, 'footer')
    if (footer) host.append(footer)

    const notes = (list, title, mark) => {
      if (!list?.length) return
      const made = aside('docx-notes', title)
      made.style.cssText += 'margin: 4px 12px;'
      for (const note of list) {
        const line = el('div', 'docx-note')
        line.style.cssText = 'margin: 0.15em 0; white-space: pre-wrap;'
        line.textContent = `${mark(note)} ${note.text}`
        made.append(line)
      }
      host.append(made)
    }
    notes(answer.footnotes, 'Footnotes', (note) => `${note.id}.`)
    notes(answer.endnotes, 'Endnotes', (note) => `${note.id}.`)
    notes(answer.comments, 'Comments', (note) =>
      `${note.author || note.initials || 'someone'}${note.date ? `, ${note.date.slice(0, 10)}` : ''} —`)
    fit()
    paginate()
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
    closeFind()
    current = null
    page = null
    sheets = null
    frame = null
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
    /* Not while an IME is composing. The events a composition fires are the
       browser's own bookkeeping, and interfering with them — normalising the
       paragraph, snapshotting, redrawing — breaks the composition out from
       under someone typing Japanese. `compositionend` below is where the
       finished text is dealt with. */
    if (event.isComposing) return
    if (event.inputType === 'insertParagraph') {
      /* Return is the app's, not the browser's: left alone, Chromium invents a
         <div> or splits the paragraph in a shape of its own, and neither
         carries the style or the numbering the new paragraph inherits. */
      event.preventDefault()
      splitParagraph()
    }
  })

  host.addEventListener('input', (event) => {
    if (!editable()) return
    /* An IME mid-composition owns the paragraph. See `beforeinput`. */
    if (/** @type {InputEvent} */ (event).isComposing) return
    /* Backspace at the start of a paragraph pulls the one above in, and
       Chromium dresses what it moved in inline styles copied from the old
       place — white-space, font, colour — that no save reads and no file
       wants. Redrawn from its runs, it is one paragraph of this page's shape. */
    const type = /** @type {InputEvent} */ (event).inputType || ''
    if (type.startsWith('delete') || type.startsWith('format') || type === 'insertText') {
      /* Likewise the <b> a pending ⌘B wraps the next letter in: read back and
         redrawn, it is a bold run with the caret at its end, so what is typed
         next stays bold. */
      const node = hereParagraph()
      const own = node && [...node.querySelectorAll(BROWSER_MARKUP)]
        .some((found) => found.closest('.docx-p, .docx-h, .docx-li') === node)
      if (own) { normalize(node); restamp(node) }
    }
    /* The one path an ordinary keystroke takes. `allowed` may put the document
       back into its reading view — the reader said take it to Word instead —
       and in that case the keystroke already in the page is undone by drawing
       the document again from the file. */
    allowed().then((yes) => {
      if (yes) touched('type')
      else if (current) open(current.path, { top: host.scrollTop }).catch(() => {})
    })
  })

  /* -------------------------------------------------------------- pasting

     Pasting brings the formatting of wherever it came from: fonts, colours,
     and a stylesheet's worth of things this app would have to write into a
     Word document as something. What is kept is the part a Word document can
     say in this app's own vocabulary — paragraphs, bold, italics, underline,
     strikethrough, links — and nothing else. Left to the plain-text path,
     three pasted paragraphs became one paragraph with two `w:br`s in it, which
     is neither what was copied nor what Word would have done. */

  /** The clipboard's HTML as paragraphs of runs — this app's own shape. */
  function pastedBlocks (html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    /** @type {any[][]} */
    const paragraphs = []
    /** @type {any[]} */
    let line = []
    const breakLine = () => { if (line.length) { paragraphs.push(line); line = [] } }

    const walk = (node, style) => {
      for (const kid of node.childNodes) {
        if (kid.nodeType === Node.TEXT_NODE) {
          // The clipboard's own indentation between elements is not content.
          const text = (kid.nodeValue || '').replace(/[\r\n\t]+/g, ' ')
          if (text.trim()) line.push({ ...style, text })
          continue
        }
        if (!(kid instanceof HTMLElement)) continue
        const tag = kid.tagName
        if (tag === 'BR') { line.push({ ...style, break: true }); continue }
        if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'HEAD') continue

        const next = { ...style }
        if (TAG_MARKS[tag]) next[TAG_MARKS[tag]] = true
        if (tag === 'A' && kid.getAttribute('href')) {
          const href = kid.getAttribute('href') || ''
          if (/^https?:/i.test(href)) {
            next.href = href
            /* The placeholder the save resolves into a real relationship — the
               same bargain a pasted link strikes as an inserted one. */
            next.hyper = { id: `TULIP_LINK:${href}`, anchor: '' }
          }
        }
        /* Block elements end the line before and after themselves; everything
           else is inline and carries on. A list item is a paragraph here — the
           list's own numbering is not the pasted text's to bring along. */
        const block = /^(P|DIV|LI|H[1-6]|TR|TABLE|UL|OL|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER|FIGURE)$/.test(tag)
        if (block) breakLine()
        walk(kid, next)
        if (block) breakLine()
      }
    }
    walk(parsed.body, { rpr: '' })
    breakLine()
    return paragraphs
  }

  /** Plain text as the same shape: one paragraph per line. */
  const pastedText = (text) => String(text).replace(/\r\n?/g, '\n').split('\n')
    .map((one) => (one ? [{ text: one, rpr: '' }] : []))

  /**
   * Put pasted paragraphs into the page at the caret.
   *
   * The first pasted paragraph joins the one the caret is in; each further one
   * is a paragraph of its own, in the same style, the way Word pastes — not a
   * stack of `w:br`s inside one paragraph, which is what `insertText` made of
   * a multi-line clipboard.
   */
  function insertPasted (paragraphs) {
    /* Whatever was selected is what the paste replaces — taken out first, so
       that the paragraph and the offset below are read from the page the paste
       actually lands in. A selection spanning paragraphs collapses them the
       way typing over one would. */
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && page?.contains(selection.anchorNode)) {
      selection.deleteFromDocument()
    }
    const node = hereParagraph()
    const where = node && offsetsIn(node)
    if (!node || !where || !paragraphs.length) return

    const runs = runsIn(node, { rpr: '' })
    const before = []
    const after = []
    let at = 0
    for (const run of runs) {
      const length = run.text ? run.text.length : 1
      if (at + length <= where.start) before.push(run)
      else if (at >= where.start) after.push(run)
      else if (run.text) {
        const head = run.text.slice(0, where.start - at)
        const tail = run.text.slice(where.start - at)
        if (head) before.push({ ...run, text: head })
        if (tail) after.push({ ...run, text: tail })
      }
      at += length
    }

    const [first, ...rest] = paragraphs
    node.replaceChildren()
    drawRuns(node, [...before, ...first, ...(rest.length ? [] : after)])
    restamp(node)

    let landedIn = node
    let landedAt = before.reduce((sum, run) => sum + (run.text ? run.text.length : 1), 0) +
      first.reduce((sum, run) => sum + (run.text ? run.text.length : 1), 0)
    let tail = node
    rest.forEach((line, i) => {
      const last = i === rest.length - 1
      /* Every pasted paragraph is the kind the caret's is — the same list, the
         same properties — the way `splitParagraph` makes its second half. */
      const made = document.createElement(node.tagName)
      made.className = node.className
      made.dataset.ppr = node.dataset.ppr || '0'
      if (node.dataset.li) made.dataset.li = '1'
      restamp(made)
      drawRuns(made, last ? [...line, ...after] : line)
      tail.after(made)
      tail = made
      if (last) {
        landedIn = made
        landedAt = line.reduce((sum, run) => sum + (run.text ? run.text.length : 1), 0)
      }
    })
    placeCaret(landedIn, landedAt)
    touched()
  }

  host.addEventListener('paste', (event) => {
    if (!editable()) return
    event.preventDefault()
    const html = event.clipboardData?.getData('text/html') || ''
    const text = event.clipboardData?.getData('text/plain') || ''
    allowed().then((yes) => {
      if (!yes) return
      const paragraphs = html ? pastedBlocks(html) : (text ? pastedText(text) : [])
      // One line of plain text with no formatting is the common case, and the
      // browser's own insertion handles the caret and the selection best.
      if (paragraphs.length === 1 && paragraphs[0].every((run) =>
        run.text && !run.href && !run.bold && !run.italic && !run.underline && !run.strike)) {
        document.execCommand('insertText', false, paragraphs[0].map((run) => run.text).join(''))
        return
      }
      if (paragraphs.length) insertPasted(paragraphs)
    })
  })

  /* The composition's end is the one moment the finished text is real: it is
     dealt with there the way a keystroke is dealt with in `input`, and not a
     moment earlier. */
  host.addEventListener('compositionend', () => {
    if (!editable()) return
    allowed().then((yes) => {
      if (yes) touched('type')
      else if (current) open(current.path, { top: host.scrollTop }).catch(() => {})
    })
  })

  host.addEventListener('keydown', (event) => {
    if (!editable()) return
    // Enter (and everything else) mid-composition is the IME's, not this app's.
    if (event.isComposing) return
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
    /* ⌘⏎ is Word's page break, and it is this page's too. */
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      insertPageBreak()
      return
    }
    /* Tab inside a list item indents it, ⇧Tab outdents — Word's own gesture.
       Outside a list, Tab is left to the browser (and to the focus order):
       a document is not a place where Tab types a tab, because a `w:tab` is a
       tab *stop* and this app lays none out. */
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const here = hereParagraph()
      if (here?.dataset.li) {
        event.preventDefault()
        indentItem(!event.shiftKey)
        return
      }
    }
    if (event.key === 'Escape' && findBar) { closeFind(); return }
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
  const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*|[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/gu
  /* Each block's count, against the text it was counted from. A keystroke
     changes one paragraph; the count used to gather the whole document into
     one string and run the word pattern over all of it — two milliseconds a
     key on a long report, for a number that differed by one. Now the pattern
     runs over the paragraph that changed, and the rest are looked up. */
  const wordCounts = new WeakMap()
  const wordsIn = (node, line) => {
    const hit = wordCounts.get(node)
    if (hit && hit.text === line) return hit.words
    let words = 0
    WORD.lastIndex = 0
    while (WORD.exec(line)) words++
    wordCounts.set(node, { text: line, words })
    return words
  }
  function countWords () {
    let total = 0
    eachLine((node, line) => { total += wordsIn(node, line) })
    return total
  }

  /**
   * The document as plain text, for the copilot and for the count above.
   *
   * Read off the page rather than the blocks it was drawn from: the blocks are
   * what the file said and the page is what the reader is looking at. A heading
   * keeps its hashes and a table row its tabs, because a run of cells folded
   * into one line is not what the table says.
   */
  const paragraphText = (child) => {
    const hashes = child.classList.contains('docx-h')
      ? `${'#'.repeat(Math.min(Number(child.tagName.slice(1)) || 1, 6))} `
      : ''
    const own = [...child.childNodes]
      .filter((kid) => !(kid instanceof HTMLElement) ||
        (kid.tagName !== 'UL' && kid.tagName !== 'OL'))
      .map((kid) => (kid instanceof HTMLElement &&
        (kid.tagName === 'BR' || /** @type {any} */ (kid).dataset?.break)
        ? '\n'
        : kid.textContent || '')).join('')
    return hashes + own
  }

  /** Every line of the page, in order, with the element it is read from. */
  function eachLine (visit) {
    if (!page) return
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName === 'TR') {
          visit(child, [...child.children].map((cell) => cell.textContent?.trim() || '').join('\t'))
          continue
        }
        if (child.classList.contains('docx-p') || child.classList.contains('docx-li') ||
          child.classList.contains('docx-h')) {
          /* A list item holds its sub-list, whose text belongs to the items
             below rather than to this one. A break is a line break here as
             well: it is one on screen, and the agent is being told what is on
             screen. */
          visit(child, paragraphText(child))
          /* Only an item holds a sub-list, and only an item is looked in for
             one: a selector query per paragraph was most of what a word
             count cost on a long document. */
          if (child.tagName !== 'LI' || !child.querySelector('ul, ol')) continue
        }
        walk(child)
      }
    }
    walk(page)
  }

  function text () {
    const lines = []
    eachLine((_node, line) => lines.push(line))
    return lines.join('\n')
  }

  /** A compact view around the paragraph the reader is editing. */
  function context () {
    if (!page) return { text: '', selection: '', paragraphs: 0, at: 0, focus: 0, title: '', words: 0 }
    const blocks = [...page.querySelectorAll('.docx-p, .docx-li, .docx-h')]
    const active = hereParagraph()
    const index = Math.max(0, blocks.indexOf(active))
    const from = Math.max(0, Math.min(Math.max(0, blocks.length - 9), index - 4))
    const lines = blocks.slice(from, from + 9).map(paragraphText)
    const relative = Math.max(0, index - from)
    const focus = lines.slice(0, relative).reduce((size, line) => size + line.length + 1, 0)
    const selected = window.getSelection()
    const anchor = selected?.anchorNode
    const selection = selected && !selected.isCollapsed && anchor && page.contains(anchor)
      ? selected.toString()
      : ''
    return {
      text: lines.join('\n'),
      selection,
      paragraphs: blocks.length,
      at: blocks.length ? index + 1 : 0,
      focus,
      title: title(),
      words: words()
    }
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

  /**
   * What the caret is sitting in, for the toolbar to show.
   *
   * Read from the page rather than from `document.queryCommandState`, which
   * answers about the browser's own idea of bold and knows nothing about a run
   * whose weight came out of a `w:rPr`. Asked on every selection change, so it
   * walks one paragraph and no further.
   */
  function format () {
    const node = hereParagraph()
    if (!node) return { level: 0, list: null, table: false, editable: editable() }
    const marks = new Set()
    const selection = window.getSelection()
    const at = selection?.anchorNode
    let walk = at instanceof HTMLElement ? at : at?.parentElement
    while (walk && walk !== node) {
      for (const [key, className] of MARKS) if (walk.classList?.contains(className)) marks.add(key)
      if (TAG_MARKS[walk.tagName]) marks.add(TAG_MARKS[walk.tagName])
      walk = walk.parentElement
    }
    return {
      level: node.classList.contains('docx-h') ? Number(node.tagName.slice(1)) || 0 : 0,
      list: node.dataset.li ? (node.parentElement?.tagName === 'OL' ? 'ordered' : 'bullet') : null,
      table: Boolean(hereCell()),
      marks: [...marks],
      editable: editable()
    }
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
    context,
    setReadonly,
    history,
    setList,
    format,
    mark,
    setHeading,
    setAlign,
    setHighlight,
    setColour,
    insertLink,
    insertPageBreak,
    indentItem,
    /** ⌘F. Opens the page's own find-and-replace bar and returns a controller
     *  ({ query, count, at, next, prev, replace, replaceAll, close }) for the
     *  palette and the tests; `null` while no document is open. */
    find,
    closeFind,
    insertTable,
    editTable,
    /** Whether the caret is in a table — the palette asks, so that the rows and
     *  columns are only offered where they mean something. */
    inTable: () => Boolean(hereCell()),
    save: saveFile,
  }
}
