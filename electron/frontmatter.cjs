'use strict'

/* ================================================================ frontmatter
   The one reader and writer of a note's YAML head, shared by everything that
   treats properties as data rather than as prose: the reading view's block,
   the editing view's properties widget, and the search's `prop:` filter.

   Deliberately not a YAML library. A note's frontmatter is, in practice, a
   flat list of `key: value` lines with the occasional list — which is all this
   writes — and a dependency-free reader was the working arrangement long
   before properties were a feature (see src/lint.js and src/language-table.js,
   which each parse the lines they care about by hand). What this module adds
   over those is the *writer*: emitting YAML that round-trips, and carrying
   lines it does not understand — a nested mapping, a folded string — as
   verbatim entries in their original position, so editing the flat properties
   of a note that also holds complex YAML moves nothing.

   CommonJS rather than ESM because it is required from electron/main.js and
   bundled into the renderer — the same arrangement as vault-contract.json, but
   for code.
   ================================================================== */

/* Where a note's frontmatter begins and ends, as character offsets — or null
   when the note opens with none.
 *
 * Only ever the very first line of the file: the same rule the linter uses
 * (its `frontmatterEnd`), which is Obsidian's rule too, so a vault moved over
 * loses nothing. The closing line may be `---` or `...`, because YAML says so
 * and notes written elsewhere use it. Offsets are characters: the markdown
 * parser slices with them, and the editing view's line numbers are derived
 * from them. */
function frontmatterRange (text) {
  const src = String(text || '')
  if (!/^---[ \t]*\r?\n/.test(src)) return null
  const bodyFrom = src.indexOf('\n') + 1
  /* Line by line rather than one regex over the whole head: a line is also
     the unit parsing wants, and a note's head has no size limit worth
     trusting a quantifier against. */
  let at = bodyFrom
  while (at < src.length) {
    let lineEnd = src.indexOf('\n', at)
    if (lineEnd === -1) lineEnd = src.length
    const line = src.slice(at, lineEnd).replace(/\r$/, '')
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) {
      return { bodyFrom, bodyTo: at, end: Math.min(lineEnd + 1, src.length) }
    }
    at = lineEnd + 1
  }
  return null
}

/** A scalar as text: what the search filter compares and what a row shows. */
function scalarText (value) {
  if (value == null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** One bare or quoted scalar, parsed into its typed form. */
function parseScalar (raw) {
  const text = raw.trim()
  if (text === '') return { value: null, type: 'text' }
  if (/^(true|false)$/i.test(text)) return { value: /^true$/i.test(text), type: 'boolean' }
  /* A number only when it round-trips character for character: "1.0", "007"
     and "1." all stay text, because the writer must not come back having
     decided `1.0` was `1` — versions, IDs and zero-padded codes are digits,
     but they are not arithmetic. */
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text)
    if (Number.isFinite(n) && String(n) === text) return { value: n, type: 'number' }
    return { value: text, type: 'text' }
  }
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?)?$/.test(text)) {
    return { value: text, type: 'date' }
  }
  /* A quoted string: the quotes are YAML's, not the value's. */
  if (text.length > 1 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    const inner = text.slice(1, -1)
    return { value: text[0] === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'"), type: 'text' }
  }
  return { value: text, type: 'text' }
}

/* Splitting a flow list's items: commas outside quotes. A hand-written
   `[a, "b, c"]` keeps the comma inside its quotes. */
function splitFlowList (inner) {
  const items = []
  let quote = null
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      if (ch === quote && inner[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ',') { items.push(inner.slice(start, i)); start = i + 1 }
  }
  items.push(inner.slice(start))
  return items
    .map((s) => parseScalar(s).value)
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
}

/**
 * A note's frontmatter, as an ordered list of entries — the shape an editor
 * edits. An entry is either a property:
 *
 *   { key, value, type, list, raw }
 *
 *     key    the name as written (consumers match case-insensitively)
 *     value  string | number | boolean | null — or an array of them when list
 *     type   'text' | 'number' | 'boolean' | 'date': the row's control and
 *            the writer's quoting rule
 *     list   written as one: `tags: [a, b]` or the indented `- item` form
 *     raw    the line(s) as found
 *
 * or a verbatim line this grammar has no answer for — `{ raw }` only, no key
 * — carried in place so writing back what was understood disturbs nothing
 * else. Blank lines are verbatim too: a writer that drops them reformats the
 * note's head on every save.
 */
function parseFrontmatter (text) {
  const range = frontmatterRange(text)
  if (!range) return { range: null, entries: [] }
  const body = String(text).slice(range.bodyFrom, range.bodyTo)
  const lines = body.replace(/\r/g, '').split('\n')

  const entries = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*):[ \t]*(.*)$/.exec(line)
    if (!m) { entries.push({ raw: line }); continue }

    const key = m[1]
    /* A trailing `# comment` is YAML's, not the value's — except inside
       quotes, where it is protected. Stripped before the flow test so
       `tags: [a, b] # noted` still parses as a list. */
    const inline = /^["']/.test(m[2].trim()) ? m[2] : m[2].replace(/[ \t]+#.*$/, '')
    const bare = inline.trim()

    if (bare === '') {
      /* `key:` alone is one of three things, and only two of them are a
         property this grammar can hand to an editor.

         The head of a block *mapping* — `nested:` above an indented
         `deep: 1` — is not: its value is the lines under it, which nothing
         here models. Reported as a property it would read as one with an
         empty value, and a writer told to fill that value in would leave the
         indented lines behind it orphaned under a scalar. So it is verbatim,
         like every other line the grammar has no answer for: shown by
         nothing, carried through every write exactly where it was. */
      if (i + 1 < lines.length &&
          /^[ \t]+\S/.test(lines[i + 1]) && !/^[ \t]+-[ \t]/.test(lines[i + 1])) {
        entries.push({ raw: line })
        continue
      }
      // Either an empty value or the head of a block list.
      if (i + 1 < lines.length && /^[ \t]+-[ \t]+\S/.test(lines[i + 1])) {
        const items = []
        const raw = [line]
        while (i + 1 < lines.length && /^[ \t]+-[ \t]+/.test(lines[i + 1])) {
          i++
          raw.push(lines[i])
          items.push(parseScalar(lines[i].replace(/^[ \t]+-[ \t]+/, '')).value)
        }
        entries.push({ key, value: items.filter((v) => v != null), type: 'text', list: true, raw: raw.join('\n') })
      } else {
        entries.push({ key, value: null, type: 'text', list: false, raw: line })
      }
      continue
    }

    const flow = /^\[(.*)\][ \t]*$/.exec(bare)
    if (flow) {
      entries.push({ key, value: splitFlowList(flow[1]), type: 'text', list: true, raw: line })
      continue
    }

    const scalar = parseScalar(bare)
    entries.push({ key, value: scalar.value, type: scalar.type, list: false, raw: line })
  }
  return { range, entries }
}

/** Just the property entries — what the `prop:` filter and the sidebar ask. */
function propsOf (parsed) {
  return (parsed?.entries || []).filter((entry) => entry.key !== undefined)
}

/**
 * The values a property matches against, as lowercase text — one per list
 * item, so `prop:status=reading` finds `status: [reading, review]` as well
 * as `status: reading`.
 */
function propValues (prop) {
  const list = Array.isArray(prop.value) ? prop.value : [prop.value]
  return list.map((v) => scalarText(v).toLowerCase()).filter(Boolean)
}

/* The head's own name for the tag list. Obsidian writes `tags` and accepts the
   singular, and a vault that arrives from it may hold either. */
const TAGS_KEY = /^tags?$/i

/**
 * The tags a note carries in its own head, lowercased and deduplicated.
 *
 * Takes the parsed properties rather than the text, because every caller
 * already holds them — the search filter memoises them against the index entry
 * and the Info pane parses once for the whole panel.
 *
 * Three spellings, all of them real in vaults written elsewhere: the flow list
 * `tags: [a, b]`, the block list under `tags:`, and the bare scalar
 * `tags: a b` or `tags: a, b`. A scalar is split on commas and whitespace
 * because a tag cannot contain either, so the split cannot cut one in half. A
 * leading `#` is stripped: `#book` and `book` are the same tag written twice.
 */
function tagsFromProps (props) {
  const out = new Set()
  for (const prop of props || []) {
    if (prop.key === undefined || !TAGS_KEY.test(prop.key)) continue
    const list = Array.isArray(prop.value) ? prop.value : [prop.value]
    for (const one of list) {
      for (const piece of scalarText(one).split(/[,\s]+/)) {
        const tag = piece.trim().replace(/^#+/, '').toLowerCase()
        if (tag) out.add(tag)
      }
    }
  }
  return [...out]
}

/** The same, from a note's text — for the callers that hold no parse. */
function frontmatterTags (text) {
  return tagsFromProps(propsOf(parseFrontmatter(text)))
}

/** A value as a flow-list item: bare when YAML would read it back as itself,
 *  quoted when it would not. JSON quoting is valid YAML double-quoting. */
function quoteScalar (value) {
  const text = scalarText(value)
  if (text === '') return "''"
  if (/[[\]{}#&*!|>'",:]|^[\s-]|\s$/.test(text)) return JSON.stringify(text)
  return text
}

/**
 * The note's text with one list property set — the writer the module header
 * promises. `values` empty removes the property; removing the last property
 * removes the head's fences too, so a note that gained a head for one alias
 * and lost it again is byte-identical to where it started. Every entry the
 * grammar did not understand is carried verbatim in its place, which is the
 * whole reason the writer rebuilds from `parseFrontmatter`'s entries rather
 * than from a data structure of its own.
 */
function writeListProp (text, key, values) {
  const clean = (values || []).map((v) => String(v).trim()).filter(Boolean)
  return putProp(text, key, clean.length ? `${key}: [${clean.map(quoteScalar).join(', ')}]` : null)
}

/**
 * The same, for a property that is not a list.
 *
 * `null` and `undefined` remove the property; the empty string keeps it as a
 * bare `key:`, because a reader who cleared a value has emptied it rather than
 * deleted it, and a property that vanished when its last character did would
 * be impossible to type a new value into.
 */
function writeScalarProp (text, key, value) {
  if (value === null || value === undefined) return putProp(text, key, null)
  const written = scalarText(value)
  return putProp(text, key, written === '' ? `${key}:` : `${key}: ${quoteScalar(value)}`)
}

/**
 * A property under a new name, keeping its value and its place.
 *
 * Rebuilt from the value rather than by editing the line, so a block list
 * arrives as the flow form the writer emits everywhere else — the same
 * normalisation `writeListProp` has always done to a list it rewrites.
 */
function renameProp (text, from, to) {
  const src = String(text || '')
  const name = String(to || '').trim()
  if (!name || name.toLowerCase() === String(from || '').toLowerCase()) return src
  const prop = propsOf(parseFrontmatter(src))
    .find((entry) => entry.key.toLowerCase() === String(from).toLowerCase())
  if (!prop) return src
  /* Out under the old name first: writing the new one into a head that still
     holds the old would leave both, and the order matters only because
     `putProp` replaces the first match in place. */
  const without = putProp(src, from, null)
  return Array.isArray(prop.value)
    ? writeListProp(without, name, prop.value)
    : writeScalarProp(without, name, prop.value)
}

/**
 * The head with one property's line replaced, added or removed — the single
 * rewrite every writer above goes through.
 *
 * `line` is the finished YAML, or null to take the property out. A property
 * already present is replaced where it stands; a new one lands at the end;
 * duplicates of a replaced key are dropped. Every entry the grammar did not
 * understand is carried verbatim in its place, which is the whole reason this
 * rebuilds from `parseFrontmatter`'s entries rather than from a data structure
 * of its own.
 */
function putProp (text, key, line) {
  const src = String(text || '')
  const parsed = parseFrontmatter(src)
  if (!parsed.range) {
    if (!line) return src
    return `---\n${line}\n---\n${src}`
  }

  const lower = String(key).toLowerCase()
  const kept = []
  let replaced = false
  const entries = [...parsed.entries]
  /* The body ends in a newline, so splitting it leaves one empty line at the
     end that is an artifact of the split, not a blank line in the head. */
  const last = entries[entries.length - 1]
  if (last && last.key === undefined && last.raw === '') entries.pop()
  for (const entry of entries) {
    if (entry.key !== undefined && entry.key.toLowerCase() === lower) {
      if (!replaced && line) { kept.push(line); replaced = true }
      continue
    }
    kept.push(entry.raw)
  }
  if (!replaced && line) kept.push(line)

  if (!kept.some((one) => one.trim() !== '')) return src.slice(parsed.range.end)
  const body = kept.length ? `${kept.join('\n')}\n` : ''
  return src.slice(0, parsed.range.bodyFrom) + body + src.slice(parsed.range.bodyTo)
}

module.exports = {
  frontmatterRange,
  parseFrontmatter,
  propsOf,
  propValues,
  tagsFromProps,
  frontmatterTags,
  scalarText,
  writeListProp,
  writeScalarProp,
  renameProp
}
