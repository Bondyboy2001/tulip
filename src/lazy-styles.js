/* Feature styles are built beside renderer.css and fetched the first time the
   feature itself is requested. Keep one promise per file: two routes can ask
   for the same surface while its link is still loading, and both must wait for
   the same cascade rather than append competing links. */
const loading = new Map()

export function loadFeatureStyles (name) {
  const key = String(name || '').trim()
  if (!key) return Promise.reject(new Error('No feature stylesheet was named.'))
  if (loading.has(key)) return loading.get(key)

  const promise = new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = new URL(`${key}.css`, document.baseURI).href
    link.dataset.tulipFeatureStyle = key
    link.addEventListener('load', () => resolve(link), { once: true })
    link.addEventListener('error', () => {
      link.remove()
      loading.delete(key)
      reject(new Error(`The ${key} stylesheet could not be loaded.`))
    }, { once: true })
    document.head.append(link)
  })
  loading.set(key, promise)
  return promise
}
