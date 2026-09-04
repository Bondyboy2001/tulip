const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const settings = fs.readFileSync(path.resolve(process.cwd(), 'src/settings.js'), 'utf8')

assert.doesNotMatch(settings, /of \$\{all\.length\} offered/)
assert.match(settings, /const open = opened\.has\(group\.name\)[\s\S]*?: !!query/)
assert.doesNotMatch(settings, /: \(!!query \|\| ticked > 0\)/)

// There is no Setup help section and no Files section: the guide opens from
// the palette and the empty state, backups run from the palette and the menu,
// and notes are written 600ms after the last keystroke with balanced
// durability and history in the app's data folder — none of which gets a row.
assert.doesNotMatch(settings, /id: 'start'/)
assert.doesNotMatch(settings, /Getting started/)
assert.doesNotMatch(settings, /id: 'files'/)
assert.doesNotMatch(settings, /historyInVault/)
assert.doesNotMatch(settings, /'getting-started': \(\)/)
assert.doesNotMatch(settings, /onChange\('lastBackupAt'/)
assert.match(settings, /'clear-models': \(\) => \{ onChange\('aiModels', \[\]\); renderBody\(\) \}/)

console.log('settings contracts: all checks passed')
