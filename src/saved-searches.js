/* Saved queries are smart folders: a name is optional presentation, while the
 * query remains the portable rule that produces the folder's contents. */

export function normalizeSavedSearches (value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const query = String(typeof item === 'string' ? item : item?.query || '').trim()
    if (!query || seen.has(query.toLowerCase())) return []
    seen.add(query.toLowerCase())
    return [{
      id: String(item?.id || `search-${Date.now()}-${seen.size}`),
      name: String(item?.name || query).trim() || query,
      query
    }]
  }).slice(0, 40)
}

export function mountSavedSearches ({ root, onOpen, onChange }) {
  let items = []

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
  return { set, save, items: () => items.map((item) => ({ ...item })) }
}
