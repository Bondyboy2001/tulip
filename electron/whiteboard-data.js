'use strict'

/** Keep Tulip's whiteboards in the upstream Excalidraw format. */
function emptyWhiteboard () {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://tulip.local',
    elements: [],
    appState: { viewBackgroundColor: '#fbfaf8', gridSize: null },
    files: {}
  }, null, 2)
}

/** Extract human-authored text from elements already held by the renderer. */
function whiteboardElementsText (elements) {
  if (!Array.isArray(elements)) return ''
  const lines = []
  for (const element of elements) {
    if (!element || element.isDeleted || element.type === 'image') continue
    const text = element.originalText || element.text || element.label?.text
    if (typeof text === 'string' && text.trim()) lines.push(text.trim())
    const linked = element.customData?.tulip
    if (linked?.type === 'note' && typeof linked.path === 'string') lines.push(linked.path)
  }
  return [...new Set(lines)].join('\n')
}

/** Extract human-authored text for vault search without indexing image data. */
function whiteboardText (source) {
  let scene
  try { scene = JSON.parse(source) } catch { return '' }
  if (scene?.type !== 'excalidraw') return ''
  return whiteboardElementsText(scene.elements)
}

module.exports = { emptyWhiteboard, whiteboardElementsText, whiteboardText }
