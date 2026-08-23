/* Saved queries are smart folders: a name is optional presentation, while the
 * query remains the portable rule that produces the folder's contents. */

export function normalizeSavedSearches (value) {
  const seen = new Set()
  const normalized = []
  for (const item of Array.isArray(value) ? value : []) {
    const query = String(typeof item === 'string' ? item : item?.query || '').trim()
    const key = query.toLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    normalized.push({
      id: String(item?.id || `search-${Date.now()}-${seen.size}`),
      name: String(item?.name || query).trim() || query,
      query
    })
    if (normalized.length === 40) break
  }
  return normalized
}

/* What a saved search is called after someone has typed at it. Out here rather
   than inline because the empty case is a decision and not an oversight: an
   emptied name is not a nameless folder, it is a folder back to being called
   what it has always been called when it had no name of its own. */
function renamedTo (item, typed) {
  return { ...item, name: String(typed || '').trim() || item.query }
}

export function mountSavedSearches ({ root, onOpen, onChange }) {
  let items = []
  /* The row being renamed, held across a repaint so that a rename survives the
     list being rebuilt under it — `paint()` replaces every node, so the input
     has to be put back rather than merely left alone. */
  let renaming = null

  /** Rename in place: the button becomes an input over the same row. */
  function startRename (item, row, open) {
    renaming = item.id
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'saved-search-name'
    input.value = item.name
    input.setAttribute('aria-label', `Rename saved search ${item.name}`)

    let settled = false
    const settle = (keep) => {
      /* Blur fires when Enter and Escape remove the input as well, so without
         this the commit runs twice — once with the typed name and once with
         whatever the second pass reads off a detached node. */
      if (settled) return
      settled = true
      renaming = null
      if (keep) item.name = renamedTo(item, input.value).name
      paint()
      if (keep) onChange(items)
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); settle(true) }
      else if (e.key === 'Escape') { e.preventDefault(); settle(false) }
      /* The sidebar's own key handling would take these otherwise. */
      e.stopPropagation()
    })
    input.addEventListener('blur', () => settle(true))

    row.replaceChild(input, open)
    /* A microtask, because `paint()` re-enters this while the row is still
       being built and is not in the document yet — and focusing a detached
       node does nothing at all, silently. By the time this runs, the
       `replaceChildren` at the end of paint has happened. */
    queueMicrotask(() => {
      if (!input.isConnected) return
      input.focus()
      input.select()
    })
  }

  function paint () {
    root.hidden = !items.length
    const head = document.createElement('div')
    head.className = 'saved-searches-head'
    head.textContent = 'Saved searches'
    const list = document.createElement('div')
    list.className = 'saved-searches-list'

    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'saved-search-row'
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'saved-search-open'
      open.title = item.query
      open.textContent = item.name
      open.addEventListener('click', () => onOpen(item.query))
      /* F2 is what the note tree uses, so the gesture is one gesture; the
         double-click is for anyone who never learned it. */
      open.addEventListener('keydown', (e) => {
        if (e.key !== 'F2') return
        e.preventDefault()
        startRename(item, row, open)
      })
      open.addEventListener('dblclick', (e) => {
        e.preventDefault()
        startRename(item, row, open)
      })
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'saved-search-remove'
      remove.title = `Remove saved search ${item.name}`
      remove.setAttribute('aria-label', `Remove saved search ${item.name}`)
      remove.textContent = '×'
      remove.addEventListener('click', () => {
        items = items.filter((entry) => entry.id !== item.id)
        paint()
        onChange(items)
      })
      row.append(open, remove)
      list.append(row)
      /* Re-entered rather than preserved: the row it was editing no longer
         exists, so the input is built again over the new one. */
      if (renaming === item.id) { renaming = null; startRename(item, row, open) }
    }
    root.replaceChildren(head, list)
  }

  function set (value) {
    items = normalizeSavedSearches(value)
    paint()
  }

  function save (query) {
    const clean = String(query || '').trim()
    if (!clean) return false
    if (items.some((item) => item.query.toLowerCase() === clean.toLowerCase())) return false
    set([...items, { id: `search-${Date.now()}`, name: clean, query: clean }])
    onChange(items)
    return true
  }

  set([])
  return { set, save }
}
