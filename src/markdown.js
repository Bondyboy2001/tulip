/* ========================================================= markdown
   The reading view's parser: one markdown-it instance, every plugin the vault's
   dialect needs, and the custom rules for the syntax markdown-it has never
   heard of — wikilinks, embeds, hashtags, task lists and fenced code.

   Lifted out of renderer.js, where it sat among two dozen unrelated concerns
   and was the largest run of lines in that file with no reason to be near any
   of them. It reaches for nothing in the app: the one thing it cannot answer
   for itself — where a relative `<img src>` in raw HTML resolves to, which
   depends on the note being rendered — is handed in.
   ================================================================== */

import MarkdownIt from 'markdown-it'
import footnotePlugin from 'markdown-it-footnote'
import { escapeHtml } from './dom.js'
import { isBookmarkLine, bookmarkMarkup } from './bookmark.js'
import { mathPlugin } from './math.js'
import { moneyPlugin } from './money.js'
import { citationPlugin } from './citations.js'
import { calloutPlugin } from './callouts.js'
import { rawHtmlPlugin } from './rawhtml.js'
import { blockReferencePlugin } from './headings.js'
import { highlightPlugin } from './marks.js'
import { parseEmbedSuffix } from './assets.js'
import { columnWidthPlugin } from './table-widths.js'
import { parseFrontmatter } from '../electron/frontmatter.cjs'

/**
 * @param {object} deps
 * @param {(src: string) => string} deps.resolveEmbedSrc
 *   Where a relative `<img src>` in raw HTML points, resolved against the note
 *   being rendered — the one thing this module cannot know on its own.
 */
export function createMarkdown ({ resolveEmbedSrc }) {
  /* `html: true` lets a note's own tags through as tags. What is then allowed to
     survive is src/rawhtml.js's decision, not markdown-it's — see the account of
     the allowlist there. It also settles a smaller nuisance: with html off, an
     attribute was prose as far as typographer was concerned, so `align="center"`
     came back curly-quoted. Raw HTML is its own token now and is left alone. */
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: true })

  md.use(mathPlugin)
  md.use(moneyPlugin)
  md.use(citationPlugin)
  md.use(calloutPlugin)
  md.use(blockReferencePlugin)
  md.use(highlightPlugin)
  /* A column dragged wider in the editing view is a fact about the note, so
     the reading view sets the table to the same measurements — see the account
     of the marker line in src/table.js. */
  md.use(columnWidthPlugin)
  /* A relative `<img src>` in raw HTML is resolved the way the note's own embeds
     are — same index, same folder — because nothing downstream walks raw HTML
     looking for attachments the way `dressEmbeds` walks the slots. */
  md.use(rawHtmlPlugin, { resolve: resolveEmbedSrc })
  /* Footnotes are ordinary prose furniture that markdown-it does not ship. The
     plugin renders them where every other markdown tool puts them: a rule and a
     numbered list at the foot of the note, each entry linking back to its mark. */
  md.use(footnotePlugin)

  /* ------------------------------------------------------------- properties

     A note's frontmatter. Left to markdown-it's own rules it was a thematic
     break followed by a run of raw YAML set as a heading — the second `---`
     is a setext underline to it, because frontmatter is a convention of note
     editors, not of Markdown. Claimed at the block level, first, and only
     ever at the very head of the file: a `---` anywhere else stays the
     divider it always was (the parser's own rule — see frontmatterRange —
     which is also the linter's and Obsidian's).

     Claimed and then not rendered: the properties are shown and edited in the
     sidebar's Info pane, which is where a fact about the note belongs. See the
     renderer rule below for why the block is still claimed at all.
  */

  md.block.ruler.before('hr', 'frontmatter', (mdState, startLine, _endLine, silent) => {
    if (startLine !== 0) return false
    const range = parseFrontmatter(mdState.src).range
    if (!range) return false
    if (silent) return true

    // The line the closing fence sits on: the one past every line the head
    // consumed. bMarks are byte… character offsets, so a straight count works.
    const head = mdState.src.slice(0, range.end)
    /* Only count the newline the closing fence sits on if it is there: a note
       that ends on `---` with nothing after it has one fewer, and a count short
       by one leaves the parser standing on the fence — which it then reads as
       the thematic break it would have been anywhere else. */
    const lines = head.split('\n').length - (head.endsWith('\n') ? 1 : 0)
    const token = mdState.push('frontmatter', '', 0)
    token.map = [0, lines]
    token.content = mdState.src.slice(range.bodyFrom, range.bodyTo)
    mdState.line = lines
    return true
  })

  /* Nothing is drawn for it. The head is metadata about the note, and it is
     shown as such in the sidebar's Info pane — a table of it at the top of the
     rendered page was the first thing anyone read on the way to the note, and
     the one thing on the page that was not the note. Claiming the block is
     still this rule's job: unclaimed, markdown-it reads it as a thematic break
     under a setext heading, which is what a `---` pair is anywhere else. */
  md.renderer.rules.frontmatter = () => ''

  /* The bookmark — see src/bookmark.js. Claimed ahead of html_block, which is
     what a comment on a line of its own would otherwise be, and drawn as the
     ribbon the editing view draws for it. The row carries its line so the
     reopened note can be scrolled to the ribbon itself. */
  md.block.ruler.before('html_block', 'bookmark', (mdState, startLine, _endLine, silent) => {
    const line = mdState.src.slice(mdState.bMarks[startLine], mdState.eMarks[startLine])
    if (!isBookmarkLine(line)) return false
    if (silent) return true
    const token = mdState.push('bookmark', '', 0)
    token.map = [startLine, startLine + 1]
    mdState.line = startLine + 1
    return true
  })
  md.renderer.rules.bookmark = (tokens, i) =>
    `<div class="bookmark-mark" data-line="${tokens[i].map?.[0] ?? 0}" role="separator" aria-label="Bookmark">${bookmarkMarkup()}</div>\n`

  /**
   * `[[target|suffix]]` at `pos`, optionally behind a `!`. Both bracket rules
   * below run on it so they cannot disagree about what ends a link — the offsets
   * are the only thing that differed between them, and they are the easiest
   * thing to get wrong when only one of the two is edited.
   *
   * The fast path is two character reads: at any other position one of the two
   * rules bails on the first and the other on the second, so prose pays almost
   * nothing. Only a `[[` pays for the `]]` search, and only a closed span pays
   * for the walk over its inside.
   */
  function wikiSpan (src, pos, bang) {
    if (bang && src.charCodeAt(pos) !== 0x21) return null             // !
    const at = pos + (bang ? 1 : 0)
    if (src.charCodeAt(at) !== 0x5B || src.charCodeAt(at + 1) !== 0x5B) return null
    const end = src.indexOf(']]', at + 2)
    if (end === -1) return null
    /* One walk over the inside, no tail allocated: a `[` anywhere rejects the
       span, and the first pipe — bare or `\|`-escaped — is the separator. The
       escaped form reads as the separator because that is what the old
       slice-then-replace-then-indexOf did (inside a table cell the source
       spells the span's own pipes `\|`, a bare one would end the cell), and an
       escape elsewhere changes nothing: a `\[` still rejects, exactly as the
       old `includes('[')` on the replaced string did. */
    let bar = -1
    let escaped = false
    for (let i = at + 2; i < end; i++) {
      const c = src.charCodeAt(i)
      if (c === 0x5B) return null                                     // [
      if (bar !== -1) continue
      if (c === 0x7C) bar = escaped ? i - 1 : i                       // |
      escaped = c === 0x5C                                            // \
    }
    const cut = (from, to) => src.slice(from, to).replace(/\\\|/g, '|').trim()
    if (bar === -1) {
      const target = cut(at + 2, end)
      return { next: end + 2, target, suffix: '' }
    }
    return {
      next: end + 2,
      target: cut(at + 2, bar),
      suffix: cut(bar + (src.charCodeAt(bar) === 0x5C ? 2 : 1), end)
    }
  }

  /* Embeds are claimed before markdown-it's own image rule gets to the `!`, and
     therefore before the wikilink rule below can read `![[x]]` as a link with a
     stray exclamation mark in front of it. */
  md.inline.ruler.before('image', 'wikiembed', (mdState, silent) => {
    const span = wikiSpan(mdState.src, mdState.pos, true)
    if (!span) return false
    if (!silent) {
      const token = mdState.push('wikiembed', '', 0)
      token.meta = span
    }
    mdState.pos = span.next
    return true
  })

  md.inline.ruler.after('emphasis', 'wikilink', (mdState, silent) => {
    const span = wikiSpan(mdState.src, mdState.pos, false)
    if (!span) return false
    if (!silent) {
      const token = mdState.push('wikilink', '', 0)
      token.content = span.suffix || span.target
      token.meta = { target: span.target }
    }
    mdState.pos = span.next
    return true
  })

  /* `#tag`, matched exactly the way the editor's tag pass matches it (see the
     tag loop in src/editor.js) so the two views agree on what is a tag. A
     heading's `#` never arrives here — the block parser has already taken it —
     and a `#` inside code is consumed by the code-span rule first.
     Sticky, not sliced: the old `exec` on `src.slice(pos)` copied the rest of
     the line at every `#`, which is quadratic across a note full of them. */
  const HASHTAG_SCAN = /#[\p{L}\p{N}][\p{L}\p{N}/_-]*/uy
  md.inline.ruler.after('wikilink', 'hashtag', (mdState, silent) => {
    const { src, pos } = mdState
    if (src.charCodeAt(pos) !== 0x23 /* # */) return false
    // Only off a boundary: `and a #tag` is one, `bug#42` is not.
    if (pos > 0 && !/\s/.test(src[pos - 1])) return false
    HASHTAG_SCAN.lastIndex = pos
    const match = HASHTAG_SCAN.exec(src)
    if (!match) return false
    if (!silent) {
      const token = mdState.push('hashtag', '', 0)
      token.content = match[0]
    }
    mdState.pos += match[0].length
    return true
  })

  /* The editor's own tag class, so the pill is one rule in the stylesheet.
     `data-tag` carries the name without its `#`, which is the spelling the
     vault search wants — see the tag branch in routeFragmentClick. Focusable
     and given a role for the same reason wikilinks are: a tag that only a
     mouse can follow is a note only a mouse can read. */
  md.renderer.rules.hashtag = (tokens, i) => {
    const name = tokens[i].content.replace(/^#/, '')
    return `<span class="tk-tag" role="link" tabindex="0" ` +
           `data-tag="${escapeAttr(name)}">${md.utils.escapeHtml(tokens[i].content)}</span>`
  }

  /* markdown-it has no task lists, which would leave the reading view showing a
     literal "[x]" where the editor shows a checkbox. */
  md.core.ruler.after('inline', 'task_lists', (mdState) => {
    const tokens = mdState.tokens
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline') continue
      if (tokens[i - 1].type !== 'paragraph_open') continue
      if (tokens[i - 2].type !== 'list_item_open') continue

      const match = /^\[([ xX])\]\s+/.exec(tokens[i].content)
      if (!match) continue

      tokens[i].content = tokens[i].content.slice(match[0].length)
      const first = tokens[i].children?.[0]
      if (first && first.type === 'text') first.content = first.content.slice(match[0].length)

      // The source line travels with the token so a click can find the exact
      // "[ ]" to flip. Counting checkboxes instead would drift the moment a
      // fenced code block contained something that looked like a task.
      const map = tokens[i - 1].map || tokens[i - 2].map
      const box = new mdState.Token('taskbox', '', 0)
      box.meta = { checked: match[1] !== ' ', line: map ? map[0] : null }
      tokens[i].children?.unshift(box)
      tokens[i - 2].attrJoin('class', 'task-item')
      if (box.meta.checked) tokens[i - 2].attrJoin('class', 'is-done')
    }
  })

  /* CSS counters are attractive here, but style containment makes their value
     depend on which part of a long reading page has been laid out. Give each
     ordered item the number it already has in the Markdown token stream instead.
     The small continuation case below mirrors the renderer's old counter-reset
     workaround for a list resumed after a fenced block. */
  md.core.ruler.after('task_lists', 'ordered_list_numbers', (mdState) => {
    const tokens = mdState.tokens
    const lists = []
    /* The list a fence-interrupted numbering resumes from: the ordered list
       whose close sits directly under the fence (`..._close, fence,
       ..._open`). Counted as it was walked — each `list_item_open` ticks its
       own innermost open — so resuming is a lookup, not a walk back plus a
       slice-and-filter over everything the list held. One pass either way. */
    /** @type {any} */
    let lastClose = null

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.type === 'ordered_list_open' || token.type === 'bullet_list_open') {
        let next = Number(token.attrGet('start')) || 1
        if (next === 1 && token.type === 'ordered_list_open' &&
            tokens[i - 1]?.type === 'fence' && lastClose?.index === i - 2 &&
            lastClose.count > 0) {
          next = lastClose.count + 1
        }
        lists.push({ ordered: token.type === 'ordered_list_open', next, count: 0 })
      } else if (token.type === 'ordered_list_close' || token.type === 'bullet_list_close') {
        const open = lists.pop()
        lastClose = token.type === 'ordered_list_close' && open
          ? { index: i, count: open.count }
          : null
      } else if (token.type === 'list_item_open') {
        const list = lists.at(-1)
        if (list) {
          list.count++
          if (list.ordered) {
            token.meta = { ...token.meta, orderedNumber: list.next++ }
          }
        }
      }
    }
  })

  /* Every block carries the line of the file it started on. Switching views has
     to land you in the same place in the note, and a pixel offset cannot say
     where that is — the two views are different scroll containers laying the
     same text out differently. A line number is the one address both understand.
     (markdown-it fills `token.map` for block tokens; inline tokens have none.) */
  const renderToken = md.renderer.renderToken.bind(md.renderer)
  md.renderer.renderToken = (tokens, i, options) => {
    const token = tokens[i]
    if (token.map && token.nesting !== -1) token.attrSet('data-line', String(token.map[0]))
    if (token.type === 'ordered_list_open') token.attrJoin('class', 'tk-ordered-list')
    return renderToken(tokens, i, options)
  }

  md.renderer.rules.list_item_open = (tokens, i, options) => {
    const token = tokens[i]
    const opening = md.renderer.renderToken(tokens, i, options)
    const number = token.meta?.orderedNumber
    if (number === undefined) return opening
    return `${opening}<span class="tk-olnum" aria-hidden="true">${number}</span>`
  }

  md.renderer.rules.taskbox = (tokens, i) => {
    const { checked, line } = /** @type {{ checked: boolean, line: number | null }} */ (tokens[i].meta)
    // Without a source line there is nothing to write back to, so the box stays
    // inert rather than pretending to work.
    const hook = line === null ? ' disabled' : ` data-line="${line}"`
    return `<input class="task" type="checkbox"${checked ? ' checked' : ''}${hook}> `
  }

  /* The fence carries its language forward as an attribute; the header and the
     highlighted spans are built from the DOM afterwards, where the language pack
     can be loaded without blocking the render. */
  md.renderer.rules.fence = (tokens, i) => {
    const info = (tokens[i].info || '').trim()
    const lang = info.split(/\s+/)[0]
    // Everything after the language is kept: a manim block names its scene there.
    const rest = info.slice(lang.length).trim()
    // Built as a string rather than from attrs, so it has to carry its own line.
    const line = tokens[i].map ? ` data-line="${tokens[i].map[0]}"` : ''
    // The fence's content keeps its closing newline, which renders as a blank
    // final line inside the box.
    const code = tokens[i].content.replace(/\n$/, '')
    const lines = code.split('\n')
    // The gutter is a sibling of the code, not part of it: re-highlighting
    // replaces the <code> contents wholesale, and numbers inside would go with
    // it. Being a sibling also keeps them still while the code scrolls.
    const numbers = lines.map((_, n) => n + 1).join('\n')

    return `<div class="code-wrap"${line}${lang ? ` data-lang="${escapeAttr(lang)}"` : ''}` +
           `${rest ? ` data-info="${escapeAttr(rest)}"` : ''}>` +
           '<div class="code-body">' +
           `<pre class="code-nums" aria-hidden="true">${numbers}</pre>` +
           `<pre class="code-text"><code>${escapeHtml(code)}</code></pre>` +
           '</div></div>'
  }

  md.renderer.rules.wikilink = (tokens, i) => {
    const { content, meta } = tokens[i]
    /* No `href` — the click is taken over in JavaScript, and a real one would
       let a note navigate the window away from itself. Which means the anchor
       is not focusable and has no role of its own either, so both are stated:
       a link that only a mouse can follow is a note only a mouse can read. */
    return `<a class="wikilink" role="link" tabindex="0" ` +
           `data-wikilink="${escapeAttr(/** @type {{ target: string }} */ (meta).target)}">${escapeHtml(content)}</a>`
  }

  /**
   * Both embed syntaxes emit the same empty stub, which `dressEmbeds` fills in
   * afterwards. The alternative — building the markup here as a string — would
   * be a second copy of `renderEmbed`, and the two would have to be kept looking
   * and behaving identically by hand. This is how fenced code already works (see
   * `dressCodeBlocks`).
   *
   * @param {string} src
   * @param {{ alt?: string, size?: { width: number, height: number | null } | null, syntax?: string }} [opts]
   */
  function embedSlot (src, { alt = '', size = null, syntax = 'wiki' } = {}) {
    return `<span class="embed-slot" data-src="${escapeAttr(src)}" data-alt="${escapeAttr(alt)}"` +
           ` data-syntax="${syntax}"` +
           (size?.width ? ` data-w="${size.width}"` : '') +
           (size?.height ? ` data-h="${size.height}"` : '') +
           '></span>'
  }

  md.renderer.rules.wikiembed = (tokens, i) => {
    const { target, suffix } = /** @type {{ target: string, suffix: string }} */ (tokens[i].meta)
    const { alt, size } = parseEmbedSuffix(suffix)
    return embedSlot(target, { alt, size, syntax: 'wiki' })
  }

  /* markdown-it's own `![alt](src)`. Its default rule would emit the src
     untouched, which the page's CSP will not load and which would not resolve
     against the note's folder anyway. */
  md.renderer.rules.image = (tokens, i) => {
    const token = tokens[i]
    const src = /** @type {string} */ (token.attrGet('src') || '')
    /* The alt text carries the same `|400` suffix rule as a wiki embed — the form
       drag-resizing writes — so it goes through the one parser for it, on the same
       terms the editing view's scanner reads it (`bareSize: false`: a caption that
       happens to be a number is a caption). The pipe arrives escaped when the
       embed sits in a table cell. */
    const { alt, size } = parseEmbedSuffix(
      (token.content || '').replace(/\\\|/g, '|'),
      { bareSize: false }
    )
    /* A remote target goes down the same path as a local one. It used not to —
       it was turned into a bare link, because the CSP of the day admitted no
       remote images — but the CSP now admits them (see index.html) and
       `embedSpec` has known what to do with a URL since. Leaving the special
       case in meant `![](https://…/cat.jpg)` was a picture in the editing view
       and a wall of URL in the reading view: the exact disagreement between the
       two scanners that src/assets.js exists to prevent, reintroduced here. */
    return embedSlot(src, { alt, size, syntax: 'md' })
  }

  /* An attribute value and an element body need the same five characters out of
     the way, so they are the same call under two names — the second one is there
     to say, at the call site, which of the two is being written. */
  const escapeAttr = escapeHtml

  return md
}
