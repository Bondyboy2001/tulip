import { appSession, delay } from './lib/app-session.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
const app = await appSession({ executable: process.argv[2] || null,
 files: { 'Note.md': '# Width check\n\nA paragraph for checking the text column.\n' },
 config: { readableWidth: false, measure: 'normal', zoom: 1, tabs: ['Note.md'], tabIndex: 0, view: 'edit' }
})
let socket
try {
 const first = (await app.targets())[0]
 const endpoint = new URL(first.webSocketDebuggerUrl)
 await app.evaluate('window.tulip.settings.open()')
 const targets = await (await fetch(`http://${endpoint.host}/json/list`)).json()
 const target = targets.find(t => t.url.includes('settings-window.html'))
 socket = new WebSocket(target.webSocketDebuggerUrl)
 await new Promise(r => socket.addEventListener('open',r,{once:true}))
 let id=0
 const cmd=(method,params={})=>new Promise((resolve,reject)=>{
  const n=++id; const receive=({data})=>{const v=JSON.parse(data);if(v.id!==n)return;socket.removeEventListener('message',receive);v.error?reject(v.error):resolve(v.result)}
  socket.addEventListener('message',receive);socket.send(JSON.stringify({id:n,method,params}))
 })
 const run=async expression=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
 await delay(400)
 await cmd('Emulation.setDeviceMetricsOverride',{width:900,height:650,deviceScaleFactor:1,mobile:false})
 await app.command('Emulation.setDeviceMetricsOverride',{width:1500,height:950,deviceScaleFactor:1,mobile:false})
 await run(`[...document.querySelectorAll('.settings-tab')].find(b=>b.textContent==='Editor').click()`)
 assert.equal(await app.evaluate(`document.documentElement.style.getPropertyValue('--measure')`), '100%')
 const widths = []
 for (const [name, measure] of [['Narrow','28rem'],['Normal','34rem'],['Wide','44rem']]) {
  assert.equal(await run(`document.querySelector('[data-setting="measure"] button').disabled`), false)
  await run(`[...document.querySelectorAll('[data-setting="measure"] button')].find(b=>b.textContent===${JSON.stringify(name)}).click()`)
  await delay(200)
  assert.equal(await app.evaluate(`document.documentElement.style.getPropertyValue('--measure')`), measure)
  const config = await app.evaluate('window.tulip.config.get()')
  assert.equal(config.readableWidth, true)
  assert.equal(config.measure, name.toLowerCase())
  widths.push(await app.evaluate(`document.querySelector('.cm-content').getBoundingClientRect().width`))
 }
 assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `Editor must visibly resize: ${widths}`)
 await run(`document.querySelector('[data-setting="readableWidth"] button').click()`)
 await delay(150)
 assert.equal(await app.evaluate(`document.documentElement.style.getPropertyValue('--measure')`), '100%')
 await run(`[...document.querySelectorAll('[data-setting="measure"] button')].find(b=>b.textContent==='Normal').click()`)
 // The harness restarts with SIGKILL; let the normal debounced config write land.
 for (let attempt = 0; attempt < 30; attempt++) {
  const saved = JSON.parse(await readFile(path.join(app.profile, 'config.json'), 'utf8'))
  if (saved.readableWidth === true && saved.measure === 'normal') break
  await delay(100)
 }
 socket.close(); socket = null
 await app.restart()
 assert.equal(await app.evaluate(`document.documentElement.style.getPropertyValue('--measure')`), '34rem')
 assert.equal((await app.evaluate('window.tulip.config.get()')).readableWidth, true)
 console.log(`PASS: width presets re-enable readable length, resize the editor (${widths.join(', ')}px), and persist after restart`)

} finally {socket?.close();await app.dispose()}
