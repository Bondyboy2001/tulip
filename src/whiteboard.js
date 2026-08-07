import React from 'react'
import { createRoot } from 'react-dom/client'
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  serializeAsJSON
} from '@excalidraw/excalidraw'
import { whiteboardElementsText } from '../electron/whiteboard-data.js'
import { noteName, WHITEBOARD_EXT } from './vault-paths.js'

const boardName = (path) => String(path).split('/').pop().replace(WHITEBOARD_EXT, '')

/* ------------------------------------------------------------- stylesheet */

/* Excalidraw's stylesheet, linked in rather than imported — see the entry
   point in build.mjs for why. Started when this module is evaluated, which is
   when the first board is opened: the fetch then overlaps the module's own
   evaluation, and there is a lot of that to overlap with. `mountWhiteboard`
   awaits it, so a board is never painted against half a cascade.

   The same `document.baseURI` reasoning as math.js's loadStyles: `dist` is
   where build.mjs puts the file, and `import.meta.url` is wherever esbuild's
   splitting last put *this* module, which is not the same place. */
let loadingStyles = null

function loadStyles () {
  if (loadingStyles) return loadingStyles

  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = new URL('whiteboard.css', document.baseURI).href
  link.dataset.tulipWhiteboard = ''

  loadingStyles = new Promise((resolve, reject) => {
    link.addEventListener('load', resolve, { once: true })
    link.addEventListener('error', () => {
      loadingStyles = null
      // Taken back out so the next attempt starts clean, rather than leaving a
      // dead <link> in the head per board opened.
      link.remove()
      reject(new Error('Whiteboard styles could not be loaded.'))
    }, { once: true })
  })
  document.head.append(link)
  return loadingStyles
}

export { loadStyles as loadWhiteboardStyles }

/* Started now rather than when `mountWhiteboard` is reached, for the overlap
   described above. The `catch` is not error handling — `mountWhiteboard`'s
   caller awaits the same promise and decides there — it is what keeps a
   failure this early from also being reported as an unhandled rejection, which
   would put a console error beside the message the reader is already getting. */
loadStyles().catch(() => {})

const h = React.createElement
const TULIP_NOTE = 'https://tulip.local/note/'

const sceneText = (scene) => serializeAsJSON(
  scene.elements || [], scene.appState || {}, scene.files || {}, 'local'
)

const scenePoint = (api, client = null, host = null) => {
  const app = api.getAppState()
  const zoom = app.zoom?.value || 1
  if (client && host) {
    const box = host.getBoundingClientRect()
    return {
      x: (client.x - box.left) / zoom - app.scrollX,
      y: (client.y - box.top) / zoom - app.scrollY
    }
  }
  return {
    x: -app.scrollX + (app.width || 800) / (2 * zoom),
    y: -app.scrollY + (app.height || 600) / (2 * zoom)
  }
}

const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`

function noteSkeleton (path, point) {
  const name = noteName(path)
  const groupId = uid('tulip-note')
  return [{
    id: uid('note'),
    type: 'rectangle',
    x: point.x - 150,
    y: point.y - 70,
    width: 300,
    height: 140,
    backgroundColor: '#e7f0ff',
    strokeColor: '#4a78a8',
    fillStyle: 'solid',
    roughness: 1,
    roundness: { type: 3 },
    groupIds: [groupId],
    link: `${TULIP_NOTE}${encodeURIComponent(path)}`,
    customData: { tulip: { type: 'note', path } },
    label: {
      text: `${name}\n${path}`,
      fontSize: 20,
      textAlign: 'center',
      verticalAlign: 'middle'
    }
  }]
}

function templateSkeleton (kind, point) {
  const box = (id, x, y, width, height, text, color = '#e7f0ff') => ({
    id, type: 'rectangle', x, y, width, height,
    backgroundColor: color, strokeColor: '#4a6075', fillStyle: 'solid',
    roundness: { type: 3 }, roughness: 1,
    label: { text, fontSize: 20, textAlign: 'center', verticalAlign: 'middle' }
  })

  if (kind === 'mind-map') {
    const center = uid('center')
    const branches = [
      [uid('branch'), -430, -190, 'Question'],
      [uid('branch'), 130, -190, 'Evidence'],
      [uid('branch'), -430, 130, 'Ideas'],
      [uid('branch'), 130, 130, 'Next steps']
    ]
    return [
      box(center, point.x - 140, point.y - 55, 280, 110, 'Main idea', '#fff1c9'),
      ...branches.flatMap(([id, dx, dy, label]) => [
        box(id, point.x + dx, point.y + dy, 300, 110, label),
        { type: 'arrow', x: point.x, y: point.y, start: { id: center }, end: { id } }
      ])
    ]
  }

  if (kind === 'study-plan') {
    return [
      box(uid('study'), point.x - 510, point.y - 210, 300, 420, 'TO LEARN\n\nAdd topics here', '#ffe7d6'),
      box(uid('study'), point.x - 150, point.y - 210, 300, 420, 'LEARNING\n\nMove active work here', '#fff1c9'),
      box(uid('study'), point.x + 210, point.y - 210, 300, 420, 'LEARNT\n\nKeep mastered ideas here', '#dcf2e4')
    ]
  }

  return [
    box(uid('research'), point.x - 520, point.y - 260, 330, 210, 'QUESTION', '#fff1c9'),
    box(uid('research'), point.x - 165, point.y - 260, 330, 210, 'SOURCES', '#e7f0ff'),
    box(uid('research'), point.x + 190, point.y - 260, 330, 210, 'CLAIMS', '#e7f0ff'),
    box(uid('research'), point.x - 520, point.y - 20, 505, 280, 'EVIDENCE', '#dcf2e4'),
    box(uid('research'), point.x + 15, point.y - 20, 505, 280, 'OPEN QUESTIONS', '#ffe7d6')
  ]
}

/** A React island: only the canvas is React; the surrounding Tulip renderer
 *  remains ordinary DOM and receives a small viewer-shaped API. */
export function mountWhiteboard ({
  host, file, exportFile, notes, resolveNote, openNote,
  onDirty, onSaved, onStatus, theme
}) {
  const canvas = document.createElement('div')
  canvas.className = 'whiteboard-canvas'
  host.replaceChildren(canvas)

  const dialog = document.createElement('dialog')
  dialog.className = 'whiteboard-note-dialog'
  const form = document.createElement('form')
  form.method = 'dialog'
  const title = document.createElement('h2')
  title.textContent = 'Add a note'
  const input = document.createElement('input')
  input.placeholder = 'Note name or path…'
  input.setAttribute('aria-label', 'Note name or path')
  input.setAttribute('list', 'whiteboard-note-list')
  const list = document.createElement('datalist')
  list.id = 'whiteboard-note-list'
  const error = document.createElement('p')
  error.className = 'whiteboard-note-error'
  const actions = document.createElement('div')
  actions.className = 'whiteboard-note-actions'
  const cancel = document.createElement('button')
  cancel.value = 'cancel'
  cancel.textContent = 'Cancel'
  const add = document.createElement('button')
  add.value = 'default'
  add.textContent = 'Add note'
  actions.append(cancel, add)
  form.append(title, input, list, error, actions)
  dialog.append(form)
  document.body.append(dialog)

  const root = createRoot(canvas)
  let current = null
  let excalidraw = null
  let latest = null
  let ready = false
  let dirty = false
  let revision = 0
  let savedRevision = 0
  let changeTimer = null
  let saving = null
  let flushRequested = false
  let palette = theme()
  let renderKey = 0

  const setDirty = (next, repeat = false) => {
    if (dirty === next && !repeat) return
    dirty = next
    onDirty(next)
  }

  const settleChange = () => {
    clearTimeout(changeTimer)
    changeTimer = null
    if (!latest || !current) return
    /* A revision is enough to decide whether there is work to save. Comparing
       serialized scenes here used to stringify every embedded image after
       each short pause in drawing, only to stringify it all again on save. */
    setDirty(revision !== savedRevision, true)
  }

  const handleChange = (elements, appState, files) => {
    latest = { elements, appState, files }
    /* The first callback is Excalidraw normalising the file it was handed, not
       a user edit. Capture it immediately so a very quick first stroke cannot
       be mistaken for that initial callback and lost from autosave. */
    if (!ready) {
      ready = true
      return
    }
    revision++
    clearTimeout(changeTimer)
    changeTimer = setTimeout(settleChange, 140)
  }

  const handleLink = (element, event) => {
    if (!element.link?.startsWith(TULIP_NOTE)) return
    event.preventDefault()
    const path = decodeURIComponent(element.link.slice(TULIP_NOTE.length))
    openNote(path)
  }

  const paint = () => {
    if (!current) { root.render(null); return }
    const initialData = current.scene
    root.render(h(Excalidraw, {
      key: `${current.path}:${renderKey}`,
      initialData,
      name: boardName(current.path),
      theme: palette,
      autoFocus: true,
      aiEnabled: false,
      handleKeyboardGlobally: false,
      langCode: 'en',
      excalidrawAPI: (api) => { excalidraw = api },
      onChange: handleChange,
      onLinkOpen: handleLink,
      UIOptions: {
        canvasActions: {
          saveToActiveFile: false,
          loadScene: false,
          export: false
        }
      }
    }))
  }

  const insert = (skeleton, point = null) => {
    if (!excalidraw) return
    const at = point || scenePoint(excalidraw)
    const source = typeof skeleton === 'function' ? skeleton(at) : skeleton
    const made = convertToExcalidrawElements(source, { regenerateIds: false })
    excalidraw.updateScene({
      elements: [...excalidraw.getSceneElementsIncludingDeleted(), ...made],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    })
    excalidraw.scrollToContent(made, { fitToViewport: false, animate: true })
  }

  const addNote = (path, point = null) => {
    const resolved = resolveNote(path)
    if (!resolved) { onStatus(`No note matches “${path}”`); return false }
    insert((at) => noteSkeleton(resolved.path, at), point)
    return true
  }

  const promptNote = () => {
    list.replaceChildren(...notes().map((note) => {
      const option = document.createElement('option')
      option.value = note.path
      option.label = note.name
      return option
    }))
    input.value = ''
    error.textContent = ''
    dialog.showModal()
    input.focus()
  }
  form.addEventListener('submit', (event) => {
    if (event.submitter === cancel) return
    event.preventDefault()
    if (addNote(input.value.trim())) dialog.close()
    else { error.textContent = 'Choose an existing Markdown note.'; input.focus() }
  })

  async function exportScene (ext, to = null) {
    if (!excalidraw || !current) return { ok: false, error: 'Open a whiteboard first.' }
    const elements = excalidraw.getSceneElements()
    if (!elements.length) { onStatus('The whiteboard is empty.'); return { ok: false } }
    const appState = excalidraw.getAppState()
    const files = excalidraw.getFiles()
    let bytes
    if (ext === 'svg') {
      const svg = await exportToSvg({ elements, appState, files })
      bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(svg))
    } else {
      const blob = await exportToBlob({ elements, appState, files, mimeType: 'image/png' })
      bytes = new Uint8Array(await blob.arrayBuffer())
    }
    const name = boardName(current.path)
    const result = await exportFile(name, ext, bytes, to)
    if (result?.ok) onStatus(`Exported ${result.path.split('/').pop()}`)
    else if (!result?.canceled) onStatus(result?.error || 'The export did not finish.')
    return result
  }
  canvas.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('application/x-tulip-note')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })
  canvas.addEventListener('drop', (event) => {
    const path = event.dataTransfer?.getData('application/x-tulip-note')
    if (!path || !excalidraw) return
    event.preventDefault()
    addNote(path, scenePoint(excalidraw, { x: event.clientX, y: event.clientY }, canvas))
  })

  const saveScene = async ({ flush = false } = {}) => {
    if (flush) flushRequested = true
    if (saving) return saving
    saving = (async () => {
      do {
        settleChange()
        if (!current || !latest || !dirty) break
        const writingRevision = revision
        const source = sceneText(latest)
        const indexText = whiteboardElementsText(latest.elements)
        await file.write(current.path, source, { whiteboardText: indexText })
        savedRevision = writingRevision
        /* A stroke can land while the atomic write is in flight. Only the
           exact revision written is clean; close asks this loop to chase the
           latest revision before it tears the canvas down. */
        const clean = revision === writingRevision
        setDirty(!clean, !clean)
        if (clean) onSaved()
      } while (flushRequested && dirty)
      flushRequested = false
      return true
    })()
    try { return await saving } finally { saving = null }
  }

  return {
    async open (path, place = null) {
      const source = await file.read(path)
      let scene
      try { scene = JSON.parse(source) } catch { throw new Error('This whiteboard is not valid JSON.') }
      if (scene?.type !== 'excalidraw' || !Array.isArray(scene.elements)) {
        throw new Error('This is not a valid Excalidraw whiteboard.')
      }
      if (place) {
        scene.appState = {
          ...(scene.appState || {}),
          scrollX: Number(place.x) || 0,
          scrollY: Number(place.y) || 0,
          zoom: { value: Number(place.zoom) || 1 }
        }
      }
      current = { path, scene }
      latest = null
      ready = false
      revision = 0
      savedRevision = 0
      setDirty(false)
      renderKey++
      paint()
    },

    save: saveScene,

    async close () {
      await saveScene({ flush: true })
      clearTimeout(changeTimer)
      current = null
      latest = null
      excalidraw = null
      ready = false
      root.render(null)
    },

    focus () { canvas.querySelector('.excalidraw')?.focus?.() || canvas.focus() },
    place () {
      if (!excalidraw) return null
      const app = excalidraw.getAppState()
      return { x: app.scrollX, y: app.scrollY, zoom: app.zoom?.value || 1 }
    },
    theme () {
      const next = theme()
      if (next === palette) return
      palette = next
      paint()
    },
    /* Tulip's right panes resize the CSS grid rather than the window. Chromium
       updates the host immediately, but Excalidraw also caches its canvas
       offsets; refresh those after the grid has committed its new width. */
    resize () { requestAnimationFrame(() => excalidraw?.refresh()) },
    key (key, options = {}) {
      const target = canvas.querySelector('.excalidraw') || canvas
      target.focus?.()
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key, metaKey: !!options.metaKey, shiftKey: !!options.shiftKey, bubbles: true
      }))
    },
    undo (redo = false) { this.key('z', { metaKey: true, shiftKey: redo }) },
    find () { this.key('f', { metaKey: true }) },
    zoom (step) { this.key(step === 'fit' ? '0' : (step > 0 ? '+' : '-')) },
    export: exportScene,
    context () {
      const elements = excalidraw?.getSceneElements() || []
      const selected = excalidraw?.getAppState()?.selectedElementIds || {}
      const text = (onlySelected) => elements
        .filter((element) => element.type === 'text' && (!onlySelected || selected[element.id]))
        .map((element) => element.originalText || element.text || '')
        .filter(Boolean).join('\n')
      return { selection: text(true), text: text(false), elements: elements.length }
    },
    addNote,
    promptNote,
    insertTemplate: (kind) => insert((at) => templateSkeleton(kind, at)),
    dirty: () => dirty
  }
}
