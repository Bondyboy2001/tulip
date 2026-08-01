/**
 * Pandoc-style citations backed by a BibTeX file.
 *
 * The note keeps the portable source (`[@key, p. 4]`) and the entries come from
 * a `references.bib` beside it. Reading view resolves that source after
 * markdown-it has rendered, because the bibliography lives on disk and the
 * renderer reaches disk asynchronously through the preload bridge.
 */

const CITE_KEY = /@([A-Za-z0-9_:.\/-]+)/

/** A citation cluster beginning at `pos`, or null. */
function citationAt (source, pos) {
  if (source[pos] !== '[') return null
  const end = source.indexOf(']', pos + 1)
  if (end === -1 || source.slice(pos + 1, end).includes('\n')) return null
  const content = source.slice(pos + 1, end)
  if (!CITE_KEY.test(content)) return null
  CITE_KEY.lastIndex = 0
  return { content, end: end + 1 }
}

export function findCitations (source) {
  const text = String(source || '')
  const out = []
  for (let pos = 0; pos < text.length; pos++) {
    const found = citationAt(text, pos)
    if (!found) continue
    out.push({
      from: pos,
      to: found.end,
      content: found.content,
      keys: citationKeys(found.content)
    })
    pos = found.end - 1
  }
  return out
}

/** Every citation key in one Pandoc citation cluster, in written order. */
function citationKeys (content) {
  const out = []
  for (const part of String(content || '').split(';')) {
    const match = CITE_KEY.exec(part)
    CITE_KEY.lastIndex = 0
    if (match && !out.includes(match[1])) out.push(match[1])
  }
  return out
}

export function citationPlugin (md) {
  md.inline.ruler.before('emphasis', 'tulip_citation', (state, silent) => {
    const found = citationAt(state.src, state.pos)
    if (!found) return false
    if (!silent) {
      const token = state.push('tulip_citation', '', 0)
      token.content = found.content
      token.meta = { keys: citationKeys(found.content) }
    }
    state.pos = found.end
    return true
  })

  md.renderer.rules.tulip_citation = (tokens, i) => {
    const token = tokens[i]
    const keys = token.meta.keys.join(' ')
    return `<a class="tk-citation" data-cite-keys="${md.utils.escapeHtml(keys)}">` +
      `[${md.utils.escapeHtml(token.content)}]</a>`
  }
}

const cleanValue = (value) => String(value || '')
  .replace(/[{}]/g, '')
  .replace(/\s+/g, ' ')
  .replace(/\\([&%_#])/g, '$1')
  .trim()

/**
 * A deliberately small BibTeX reader. It balances braces, so titles and
 * author names containing nested TeX groups do not split the entry early.
 */
function parseBibTeX (source) {
  const text = String(source || '')
  const entries = new Map()
  let at = 0

  while (at < text.length) {
    const open = /@([A-Za-z]+)\s*([({])/.exec(text.slice(at))
    if (!open) break
    const type = open[1].toLowerCase()
    const start = at + open.index + open[0].length
    const closeChar = open[2] === '{' ? '}' : ')'
    let depth = 1
    let end = start
    let quote = false
    for (; end < text.length; end++) {
      const ch = text[end]
      if (ch === '"' && text[end - 1] !== '\\') quote = !quote
      if (quote) continue
      if (ch === open[2]) depth++
      else if (ch === closeChar && --depth === 0) break
    }
    if (depth) break

    const body = text.slice(start, end)
    const comma = body.indexOf(',')
    if (comma !== -1 && !['comment', 'preamble', 'string'].includes(type)) {
      const key = body.slice(0, comma).trim()
      const fields = {}
      const rest = body.slice(comma + 1)
      let pos = 0
      while (pos < rest.length) {
        const field = /([A-Za-z][\w-]*)\s*=\s*/y
        field.lastIndex = pos
        const match = field.exec(rest)
        if (!match) { pos++; continue }
        pos = field.lastIndex

        let value = ''
        if (rest[pos] === '{') {
          let level = 1
          const from = ++pos
          while (pos < rest.length && level) {
            if (rest[pos] === '{') level++
            else if (rest[pos] === '}') level--
            pos++
          }
          value = rest.slice(from, Math.max(from, pos - 1))
        } else if (rest[pos] === '"') {
          const from = ++pos
          while (pos < rest.length && (rest[pos] !== '"' || rest[pos - 1] === '\\')) pos++
          value = rest.slice(from, pos++)
        } else {
          const from = pos
          while (pos < rest.length && rest[pos] !== ',') pos++
          value = rest.slice(from, pos)
        }
        fields[match[1].toLowerCase()] = cleanValue(value)
      }
      if (key) entries.set(key, { key, type, ...fields })
    }
    at = end + 1
  }
  return entries
}

function surname (name) {
  const value = cleanValue(name)
  if (!value) return ''
  if (value.includes(',')) return value.split(',')[0].trim()
  return value.split(/\s+/).at(-1)
}

function shortAuthor (entry) {
  const people = String(entry?.author || entry?.editor || '')
    .split(/\s+and\s+/i).map(surname).filter(Boolean)
  if (!people.length) return ''
  if (people.length === 1) return people[0]
  if (people.length === 2) return `${people[0]} & ${people[1]}`
  return `${people[0]} et al.`
}

function citationLabel (entry, key) {
  const who = shortAuthor(entry) || entry?.organization || key
  return `${who} ${entry?.year || 'n.d.'}`
}

function formatCluster (content, entries) {
  const parts = String(content).split(';').map((part) => {
    const found = CITE_KEY.exec(part)
    CITE_KEY.lastIndex = 0
    if (!found) return part.trim()
    const before = part.slice(0, found.index).trim()
    const after = part.slice(found.index + found[0].length).trim()
    return [before, citationLabel(entries.get(found[1]), found[1]), after]
      .filter(Boolean).join(' ').replace(/\s+,/g, ',')
  })
  return `(${parts.join('; ')})`
}

function longReference (entry) {
  const people = cleanValue(entry.author || entry.editor)
    .split(/\s+and\s+/i)
    .filter(Boolean)
    .map((person) => {
      const parts = person.split(',').map((part) => part.trim()).filter(Boolean)
      return parts.length > 1 ? `${parts.slice(1).join(' ')} ${parts[0]}` : person
    })
    .join('; ')
  const title = entry.title ? `“${entry.title.replace(/[.!?]$/, '')}.”` : ''
  const container = (entry.journal || entry.booktitle || entry.publisher || '').replace(/[.!?]$/, '')
  const detail = [
    entry.volume ? `vol. ${entry.volume}` : '',
    entry.number ? `no. ${entry.number}` : '',
    entry.pages ? `pp. ${entry.pages.replace('--', '–')}` : ''
  ].filter(Boolean).join(', ')
  const lead = [people, entry.year].filter(Boolean).join('. ')
  const publication = [container, detail].filter(Boolean).join(', ')
  return [lead && `${lead}.`, title, publication && `${publication}.`]
    .filter(Boolean).join(' ')
}

const safeId = (key) => encodeURIComponent(key).replaceAll('%', '_')

/**
 * Resolve citation slots and append the cited entries. Failure is intentionally
 * soft: unresolved source remains visible as `[@key]`, which is better than a
 * blank reference in a portable note.
 */
export async function dressCitations (root, {
  dir = '', resolve, read
} = {}) {
  const slots = [...root.querySelectorAll('.tk-citation')]
  if (!slots.length) return
  root.querySelector(':scope > .tk-bibliography')?.remove()
  const generation = String((Number(root.dataset.citationGeneration) || 0) + 1)
  root.dataset.citationGeneration = generation

  /* One convention rather than a declaration: `references.bib` beside the note.
     The note used to name its own file in frontmatter, which no longer exists. */
  const paths = [resolve?.('references.bib', dir)].filter(Boolean)
  if (!paths.length) {
    for (const slot of slots) slot.title = 'No bibliography file was found.'
    return
  }

  const entries = new Map()
  await Promise.all(paths.map(async (path) => {
    try {
      for (const [key, entry] of parseBibTeX(await read(path))) entries.set(key, entry)
    } catch { /* one broken source must not hide entries from the others */ }
  }))
  if (root.dataset.citationGeneration !== generation) return

  const used = []
  for (const slot of slots) {
    const keys = (slot.dataset.citeKeys || '').split(/\s+/).filter(Boolean)
    const raw = slot.textContent.replace(/^\[|\]$/g, '')
    slot.textContent = formatCluster(raw, entries)
    const first = keys.find((key) => entries.has(key))
    if (first) slot.href = `#ref-${safeId(first)}`
    const missing = keys.filter((key) => !entries.has(key))
    slot.classList.toggle('is-missing', missing.length > 0)
    slot.title = missing.length ? `Missing from bibliography: ${missing.join(', ')}` : ''
    for (const key of keys) if (entries.has(key) && !used.includes(key)) used.push(key)
  }
  if (!used.length) return

  const section = document.createElement('section')
  section.className = 'tk-bibliography'
  const heading = document.createElement('h2')
  heading.textContent = 'References'
  const list = document.createElement('ol')
  for (const key of used) {
    const entry = entries.get(key)
    const item = document.createElement('li')
    item.id = `ref-${safeId(key)}`
    item.textContent = longReference(entry) || key
    const declared = String(entry.url || '').trim()
    const url = /^https?:\/\//i.test(declared)
      ? declared
      : (entry.doi ? `https://doi.org/${entry.doi}` : '')
    if (url) {
      item.append(document.createTextNode(' '))
      const link = document.createElement('a')
      link.href = url
      link.textContent = entry.doi ? 'DOI' : 'Link'
      item.append(link)
    }
    list.append(item)
  }
  section.append(heading, list)
  root.append(section)
}
