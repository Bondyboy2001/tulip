import { mountSettings } from './settings.js'
import { resolveTheme } from './themes.js'

const api = /** @type {any} */ (window).tulip
let config = await api.config.get()
document.documentElement.dataset.theme = resolveTheme(config.theme || 'light')
document.body.classList.toggle('is-mac', api.platform === 'darwin')
const pane = mountSettings({
  el: {
    root: document.getElementById('settings'), rail: document.getElementById('settings-rail'),
    body: document.getElementById('settings-body'), title: document.getElementById('settings-title'),
    close: document.getElementById('settings-close')
  },
  api,
  values: () => config,
  onChange: (key, value) => {
    config = { ...config, [key]: value }
    document.documentElement.dataset.theme = resolveTheme(config.theme || 'light')
    api.config.set({ [key]: value }).catch(() => refresh())
    if (key === 'zoom') api.zoom.set(value)
  }
})
async function refresh () {
  config = await api.config.get()
  document.documentElement.dataset.theme = resolveTheme(config.theme || 'light')
  pane.open()
}
api.on('settings:refresh', refresh)
/* Opened for a particular pane — the copilot's "Set up" arrives here — and
   opened without one, which is the ordinary case and leaves the last pane
   where the reader left it. */
api.on('settings:section', (section) => { if (section) pane.open(section) })
pane.open()
