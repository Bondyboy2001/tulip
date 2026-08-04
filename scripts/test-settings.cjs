const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const settings = fs.readFileSync(path.resolve(process.cwd(), 'src/settings.js'), 'utf8')

assert.doesNotMatch(settings, /of \$\{all\.length\} offered/)
assert.match(settings, /const open = opened\.has\(group\.name\)[\s\S]*?: !!query/)
assert.doesNotMatch(settings, /: \(!!query \|\| ticked > 0\)/)

console.log('settings contracts: all checks passed')
