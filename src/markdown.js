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
import { escapeHtml } from './blocks.js'
import { mathPlugin } from './math.js'
import { moneyPlugin } from './money.js'
import { citationPlugin } from './citations.js'
import { calloutPlugin } from './callouts.js'
import { rawHtmlPlugin } from './rawhtml.js'
import { blockReferencePlugin } from './headings.js'
import { highlightPlugin } from './marks.js'
import { parseEmbedSuffix } from './assets.js'
import { columnWidthPlugin } from './table.js'

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
  const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: true })

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

  /**
   * `[[target|suffix]]` at `pos`, optionally behind a `!`. Both bracket rules
   * below run on it so they cannot disagree about what ends a link — the offsets
   * are the only thing that differed between them, and they are the easiest
   * thing to get wrong when only one of the two is edited.
   */
  function wikiSpan (src, pos, bang) {
    if (bang && src.charCodeAt(pos) !== 0x21) return null             // !
    const at = pos + (bang ? 1 : 0)
    if (src.charCodeAt(at) !== 0x5B || src.charCodeAt(at + 1) !== 0x5B) return null
    const end = src.indexOf(']]', at + 2)
    if (end === -1) return null
    /* Inside a table cell the source spells the span's own pipes `\|` — a bare
       one would end the cell — so an escaped pipe reads as the separator here. */
    const inner = src.slice(at + 2, end).replace(/\\\|/g, '|')
    if (inner.includes('[')) return null

    const bar = inner.indexOf('|')
    return {
      next: end + 2,
      target: (bar === -1 ? inner : inner.slice(0, bar)).trim(),
      suffix: bar === -1 ? '' : inner.slice(bar + 1).trim()
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
     and a `#` inside code is consumed by the code-span rule first. */
  md.inline.ruler.after('wikilink', 'hashtag', (mdState, silent) => {
    const { src, pos } = mdState
    if (src.charCodeAt(pos) !== 0x23 /* # */) return false
    // Only off a boundary: `and a #tag` is one, `bug#42` is not.
    if (pos > 0 && !/\s/.test(src[pos - 1])) return false
    const match = /^#[\p{L}\p{N}][\p{L}\p{N}/_-]*/u.exec(src.slice(pos))
    if (!match) return false
    if (!silent) {
      const token = mdState.push('hashtag', '', 0)
      token.content = match[0]
    }
    mdState.pos += match[0].length
    return true
  })

  // The editor's own tag class, so the pill is one rule in the stylesheet.
  md.renderer.rules.hashtag = (tokens, i) =>
    `<span class="tk-tag">${md.utils.escapeHtml(tokens[i].content)}</span>`

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
      const first = tokens[i].children[0]
      if (first && first.type === 'text') first.content = first.content.slice(match[0].length)

      // The source line travels with the token so a click can find the exact
      // "[ ]" to flip. Counting checkboxes instead would drift the moment a
      // fenced code block contained something that looked like a task.
      const map = tokens[i - 1].map || tokens[i - 2].map
      const box = new mdState.Token('taskbox', '', 0)
      box.meta = { checked: match[1] !== ' ', line: map ? map[0] : null }
      tokens[i].children.unshift(box)
      tokens[i - 2].attrJoin('class', 'task-item')
      if (box.meta.checked) tokens[i - 2].attrJoin('class', 'is-done')
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
    return renderToken(tokens, i, options)
  }

  md.renderer.rules.taskbox = (tokens, i) => {
    const { checked, line } = tokens[i].meta
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
    return `<a class="wikilink" data-wikilink="${escapeAttr(meta.target)}">${escapeHtml(content)}</a>`
  }

  /**
   * Both embed syntaxes emit the same empty stub, which `dressEmbeds` fills in
   * afterwards. The alternative — building the markup here as a string — would
   * be a second copy of `renderEmbed`, and the two would have to be kept looking
   * and behaving identically by hand. This is how fenced code already works (see
   * `dressCodeBlocks`).
   */
  function embedSlot (src, { alt = '', size = null, syntax = 'wiki' } = {}) {
    return `<span class="embed-slot" data-src="${escapeAttr(src)}" data-alt="${escapeAttr(alt)}"` +
           ` data-syntax="${syntax}"` +
           (size?.width ? ` data-w="${size.width}"` : '') +
           (size?.height ? ` data-h="${size.height}"` : '') +
           '></span>'
  }

  md.renderer.rules.wikiembed = (tokens, i) => {
    const { target, suffix } = tokens[i].meta
    const { alt, size } = parseEmbedSuffix(suffix)
    return embedSlot(target, { alt, size, syntax: 'wiki' })
  }

  /* markdown-it's own `![alt](src)`. Its default rule would emit the src
     untouched, which the page's CSP will not load and which would not resolve
     against the note's folder anyway. */
  md.renderer.rules.image = (tokens, i) => {
    const token = tokens[i]
    const src = token.attrGet('src') || ''
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
