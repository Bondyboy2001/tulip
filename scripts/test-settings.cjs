const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const settings = fs.readFileSync(path.resolve(process.cwd(), 'src/settings.js'), 'utf8')

assert.doesNotMatch(settings, /of \$\{all\.length\} offered/)
assert.match(settings, /const open = opened\.has\(group\.name\)[\s\S]*?: !!query/)
assert.doesNotMatch(settings, /: \(!!query \|\| ticked > 0\)/)

// Setup help is optional and lives in one ordinary settings section: it can
// open the portable guide, show the existing readiness doctor, and record a
// timestamp only after the integrity-checked backup bridge succeeds.
assert.match(settings, /id: 'start',[\s\S]{0,900}name: 'Last verified backup'/)
assert.match(settings, /cfg\.lastBackupAt[\s\S]{0,220}No verified backup has been recorded yet/)
assert.match(settings, /'getting-started': \(\) => \{ close\(\); onCommand\('getting-started'\) \}/)
assert.match(settings, /readiness: \(\) => \{ active = 'copilot'; renderRail\(\); renderBody\(\) \}/)
assert.match(settings, /const result = await api\.vault\.backup\(\)[\s\S]{0,180}onChange\('lastBackupAt', Date\.now\(\)\)/)

console.log('settings contracts: all checks passed')
