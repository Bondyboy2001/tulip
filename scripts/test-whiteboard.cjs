'use strict'

const assert = require('node:assert/strict')
const contract = require('../electron/vault-contract.json')
const {
  emptyWhiteboard,
  whiteboardElementsText,
  whiteboardText
} = require('../electron/whiteboard-data')

assert.equal(contract.whiteboardExtension, '.excalidraw')

const empty = JSON.parse(emptyWhiteboard())
assert.equal(empty.type, 'excalidraw')
assert.equal(empty.version, 2)
assert.deepEqual(empty.elements, [])
assert.deepEqual(empty.files, {})

const scene = JSON.stringify({
  type: 'excalidraw',
  elements: [
    { type: 'text', text: 'Energy systems', originalText: 'Energy systems' },
    { type: 'rectangle', label: { text: 'Evidence' } },
    { type: 'image', fileId: 'large-image', text: 'should not appear' },
    { type: 'rectangle', customData: { tulip: { type: 'note', path: 'Study/ATP.md' } } },
    { type: 'text', originalText: 'Deleted thought', isDeleted: true }
  ],
  files: { 'large-image': { dataURL: `data:image/png;base64,${'x'.repeat(10000)}` } }
})
const indexed = whiteboardText(scene)
assert.match(indexed, /Energy systems/)
assert.match(indexed, /Evidence/)
assert.match(indexed, /Study\/ATP\.md/)
assert.doesNotMatch(indexed, /Deleted thought|should not appear|base64|xxxx/)
assert.equal(whiteboardElementsText(JSON.parse(scene).elements), indexed)
assert.equal(whiteboardElementsText(null), '')
assert.equal(whiteboardText('{bad json'), '')
assert.equal(whiteboardText(JSON.stringify({ type: 'other', elements: [] })), '')

console.log('whiteboard data tests passed')
