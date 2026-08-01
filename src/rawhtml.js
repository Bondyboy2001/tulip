/* ================================================================ raw html
   Notes hold HTML. A README pasted whole, a page saved into the vault, a
   `<div align="center">` somebody wrote because markdown has no way to centre
   anything — markdown-it used to be told `html: false`, so all of it arrived as
   text and the reading view showed the angle brackets. Worse, typographer had
   already been over it: `align="center"` came out with curly quotes, so what
   you read was not even the markup you wrote.

   markdown-it is now told `html: true` and everything below decides which of
   those tags is allowed to become an element.

   Why an allowlist rather than simply letting it through. The reading view
   writes its result with innerHTML into the app's own document, and that
   document's preload bridge can read and write the vault. The page CSP is
   strict — no 'unsafe-inline' in script-src — so an `onerror=` handler is dead
   before it runs, and that is the second lock, not the first. It also does not
   cover everything a tag can do: `<webview>` is enabled in this window for the
   YouTube player (see electron/main.js), a `<form>` can post the note's text
   somewhere, and an `id=` can quietly collide with an element the app looks up
   by name. So a note may use the tags named here, with the attributes named
   here, and nothing else survives the trip.

   The rule for anything not on the list: drop the *tag*, keep the text inside
   it, so an unknown wrapper costs you its styling and never its content. The
   four elements whose content is code rather than prose — script, style,
   template, noscript — are dropped whole, contents and all.
   ================================================================== */

/* The same escaper the reading view writes its own markup with. A sanitiser
   holding a private copy of one is a copy that misses the fix. */
import { escapeHtml as escapeAttr } from './blocks.js'
/* And the same schemes the click router will act on — see below. */
import { EXTERNAL_SCHEME as SAFE_SCHEME } from './links.js'

/** Tags a note may use. Chosen as what prose and pasted READMEs actually
 *  contain; anything structural the app owns (form controls, frames, embedded
 *  documents) is deliberately absent. */
const ALLOWED = new Set([
  'div', 'p', 'span', 'br', 'hr', 'section', 'article', 'aside', 'header', 'footer', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'figure', 'figcaption', 'details', 'summary', 'center',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'em', 'strong', 'b', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small',
  'sub', 'sup', 'code', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'time', 'dfn',
  'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr',
  'img', 'picture', 'source', 'video', 'audio', 'track'
])

/* Elements that hold code, not prose: dropping the tag alone would spill a
   stylesheet or a script body into the note as visible text. */
const CODE_ELEMENTS = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi

/* `class` and `id` are missing on purpose. The reading view is a live app
   surface — it looks elements up by id, and walks it for `.embed-slot` and
   `.code-wrap` to dress them afterwards — and a note is not entitled to reach
   into either. `style` covers what a pasted page actually needs. */
const GLOBAL_ATTRS = new Set(['title', 'dir', 'lang', 'align', 'valign', 'style'])

const TAG_ATTRS = {
  /* `target` is absent so the app's own link handling stays in charge of where
     a click goes, exactly as it is for a markdown link. */
  a: ['href', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  source: ['src', 'type', 'media'],
  // `autoplay` is not here: a note that starts making noise when you open it.
  video: ['src', 'poster', 'width', 'height', 'controls', 'loop', 'muted', 'playsinline', 'preload'],
  audio: ['src', 'controls', 'loop', 'muted', 'preload'],
  track: ['src', 'kind', 'srclang', 'label', 'default'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'headers', 'scope'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  table: ['width', 'border', 'cellpadding', 'cellspacing'],
  details: ['open'],
  time: ['datetime'],
  bdo: ['dir'],
  q: ['cite'],
  blockquote: ['cite'],
  ins: ['cite', 'datetime'],
  del: ['cite', 'datetime']
}

/** Attributes holding a URL, which get read rather than copied. */
const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite'])

/* `SAFE_SCHEME` is the router's list, borrowed rather than restated: a scheme
   admitted here that nothing follows is a dead link, and one followed there
   but stripped here could never be clicked. Everything else — `javascript:`
   first among them — is refused.

   `tulip-file:` is deliberately not in it: that is how an *asset* reaches the
   vault, and an `<a href>` wearing it would be a click that navigates the app
   into a vault file — so it is admitted only where an asset loads, below. */
const ASSET_SCHEME = /^tulip-file:/i
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\s]*$/i

/* A style attribute is allowed to say how something looks and nothing else.
   `url()` would fetch, `expression()`/`behavior:`/`-moz-binding:` were all ways
   to run code from a stylesheet, and a fixed or sticky box can be parked over
   the app's own furniture. Any of them voids the whole declaration list —
   partial repair of a hostile string is how sanitisers get bypassed. */
const BAD_STYLE = /url\s*\(|expression\s*\(|@import|behavior\s*:|binding\s*:|position\s*:\s*(?:fixed|sticky)/i

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' }

/**
 * Attribute values arrive HTML-encoded, and a scheme check run over the
 * encoded form is the classic way past one: `java&#115;cript:` is not
 * `javascript:` until you decode it. So values are decoded before they are
 * judged, and re-escaped when they are written back out.
 */
function decodeEntities (s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, body) => {
    const key = body.toLowerCase()
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return NAMED[key] !== undefined ? NAMED[key] : whole
  })
}

/**
 * What a URL-bearing attribute is allowed to end up as.
 *
 * A bare `#anchor` and a relative link are both left exactly as written, so a
 * raw `<a>` behaves like the markdown link next to it — the app resolves those
 * on click. A relative *asset* is different: nothing later walks raw HTML
 * looking for one, so it is resolved here, through the same index the note's
 * own embeds go through, and comes back as a `tulip-file:` URL the CSP admits.
 *
 * @returns {string|null} the value to write, or null to drop the attribute
 */
function safeUrl (value, { tag, isAsset, resolve }) {
  const url = decodeEntities(value).trim()
  /* Judged against a copy with the control characters and spaces taken out,
     because a browser ignores those when it reads a scheme: `java&Tab;script:`
     is a live URL to everything except a check run on the raw string. Only the
     verdict comes from the copy — what gets written is what the note wrote, or
     an anchor like `#4.1 Numbers` would lose the space it needs to be found. */
  const probe = url.replace(/[\u0000-\u0020\u007f]/g, '')
  if (!probe) return null
  if (probe.startsWith('#')) return url
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe)) {
    if (SAFE_SCHEME.test(probe)) return url
    if (isAsset && ASSET_SCHEME.test(probe)) return url
    if (tag === 'img' && DATA_IMAGE.test(probe)) return url
    return null
  }
  // Protocol-relative (`//host/x`) has no base here worth guessing at.
  if (probe.startsWith('//')) return null
  if (!isAsset) return url
  return (resolve && resolve(url)) || null
}

const ATTR = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g

function cleanAttrs (tag, raw, resolve) {
  const permitted = TAG_ATTRS[tag] || []
  const asset = tag === 'img' || tag === 'video' || tag === 'audio' ||
                tag === 'source' || tag === 'track'
  const out = []

  ATTR.lastIndex = 0
  let m
  while ((m = ATTR.exec(raw))) {
    const name = m[1].toLowerCase()
    if (!GLOBAL_ATTRS.has(name) && !permitted.includes(name)) continue

    let value = m[2] || ''
    if (value[0] === '"' || value[0] === "'") value = value.slice(1, -1)

    // A bare attribute (`controls`, `open`) is its own value.
    if (!m[2]) { out.push(name); continue }

    if (URL_ATTRS.has(name)) {
      const url = safeUrl(value, { tag, isAsset: asset && name !== 'href', resolve })
      if (url === null) continue
      value = url
    } else if (name === 'style') {
      if (BAD_STYLE.test(decodeEntities(value))) continue
    }

    out.push(`${name}="${escapeAttr(decodeEntities(value))}"`)
  }
  return out.length ? ' ' + out.join(' ') : ''
}

/* Comments and doctypes go; a closing tag is kept only if its opening tag
   would have been; an opening tag is rebuilt from the attributes that
   survived. The attribute group tolerates a quoted `>` inside a value, which
   is the one place a naive `<[^>]*>` scanner cuts a tag in half. */
const TAG = /<!--[\s\S]*?(?:-->|$)|<[!?][^>]*>|<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)\s*>|<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g

/**
 * @param {string} html   what the note wrote
 * @param {(src: string) => string|null} resolve  vault asset -> URL
 */
function sanitizeHtml (html, resolve) {
  return html.replace(CODE_ELEMENTS, '').replace(TAG, (_whole, closing, opening, attrs) => {
    if (closing) return ALLOWED.has(closing.toLowerCase()) ? `</${closing.toLowerCase()}>` : ''
    if (!opening) return ''                                   // comment, doctype, PI
    const tag = opening.toLowerCase()
    if (!ALLOWED.has(tag)) return ''
    // A self-closing `/` is not part of the last attribute.
    return `<${tag}${cleanAttrs(tag, (attrs || '').replace(/\/\s*$/, ''), resolve)}>`
  })
}

/* Every other block carries the line it began on, so switching views lands you
   in the same place in the note (see the renderToken override in
   src/renderer.js). A custom rule does not get that for free, and there is no
   wrapper to hang it on — wrapping would change the nesting, and markdown-it
   hands out a block's HTML in pieces that need not balance within one token.
   So it goes on the first tag the block opens, which is the element the block
   becomes. */
function withLine (html, line) {
  return html.replace(/<[a-zA-Z][a-zA-Z0-9:-]*/, (tag) => `${tag} data-line="${line}"`)
}

/**
 * @param {object} md
 * @param {{resolve?: (src: string) => string|null}} options
 */
export function rawHtmlPlugin (md, { resolve } = {}) {
  md.renderer.rules.html_block = (tokens, i) => {
    const html = sanitizeHtml(tokens[i].content, resolve)
    return tokens[i].map ? withLine(html, tokens[i].map[0]) : html
  }
  md.renderer.rules.html_inline = (tokens, i) => sanitizeHtml(tokens[i].content, resolve)
}
