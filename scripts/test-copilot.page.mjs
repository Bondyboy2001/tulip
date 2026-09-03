/* The half of the copilot test that runs in the page. See test-copilot-view.mjs.
 *
 * The panel is mounted against a bridge that answers the way main does and
 * writes down every call, and driven the way a reader drives it: text in the
 * box, Enter, clicks on the rows. Events come back through the same `ai:event`
 * channel main uses, tagged with the turn ids the panel handed over — which is
 * the point. Everything checked here is bookkeeping the panel does on its own
 * — which conversation a turn files into, what gets resent, what is asked
 * once — and none of it was reachable by any test before this one.
 */

import { mountCopilot } from '../src/copilot.js'
import { el as element } from '../src/dom.js'

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const settled = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await wait(0)
}

const stage = (what) => { window.__stage = what }

/* The elements the panel asks for, by the names the renderer hands them over
   under. Ids match src/index.html so the stylesheet's selectors would apply,
   though nothing here is measured. */
function buildPanel () {
  const app = document.getElementById('host')
  const panel = element('aside', 'ai')
  const log = element('div', 'ai-log')
  const attachments = element('div', 'ai-attachments')
  const input = document.createElement('textarea')
  const send = element('button', 'ai-go')
  const attach = element('button', 'ai-chip')
  const write = element('button', 'ai-chip ai-mode')
  const writeLabel = element('span', '')
  const configSep = element('span', '')
  const context = element('span', 'ai-context')
  const contextWrap = element('span', 'ai-context-wrap')
  const contextPop = element('span', 'ai-context-pop')
  const menu = element('div', 'ai-menu')
  const config = element('span', 'ai-config')
  const configModel = element('span', '')
  const configEffort = element('span', '')
  write.append(writeLabel)
  contextWrap.append(context, contextPop)
  config.append(configModel, configSep, configEffort)
  panel.append(log, menu, attachments, input, attach, write, contextWrap, config, send)
  app.append(panel)
  return {
    app, panel, log, attachments, input, send, attach, write, writeLabel,
    configSep, context, contextWrap, contextPop, menu, config, configModel, configEffort
  }
}

/** The bridge, as a recorder. `sendPlan` scripts what each `ai.send` answers. */
function buildApi () {
  const calls = { start: [], send: [], stop: [], saves: [] }
  const handlers = new Map()
  const api = {
    calls,
    sendPlan: [],
    on: (channel, fn) => { handlers.set(channel, fn) },
    emit: (channel, event) => handlers.get(channel)?.(event),
    openExternal: () => {},
    config: { set: () => {} },
    trust: { operation: async () => null },
    ai: {
      start: async (opts) => { calls.start.push(opts); return { ok: true } },
      send: async (key, text, context, turnId) => {
        calls.send.push({ key, text, context, turnId })
        return api.sendPlan.length ? api.sendPlan.shift() : { ok: true }
      },
      stop: async (key, turnId) => { calls.stop.push({ key, turnId }); return true },
      models: async () => ({
        opencode: [{ id: 'test/model', label: 'model', group: 'test', efforts: [], effort: '', context: 100000 }]
      }),
      announce: async () => ({ ok: false }),
      attach: async () => null,
      pickAttachments: async () => [],
      history: {
        load: async () => ({}),
        save: async (payload) => { calls.saves.push(payload); return { ok: true } }
      }
    }
  }
  return api
}

export async function run () {
  const el = buildPanel()
  const api = buildApi()
  const seen = { permissions: 0, restores: [], inserted: [], warned: [] }
  let allowInsert = true

  const panel = mountCopilot({
    el,
    api,
    context: async () => ({ note: 'a.md', kind: 'note', excerpt: 'hello', excerptCut: false, noteChars: 5 }),
    files: () => [{ path: 'a.md', name: 'a' }, { path: 'b.md', name: 'b' }],
    onPermission: async () => { seen.permissions++; return true },
    onRestore: async (operation, path) => { seen.restores.push({ id: operation.id, path }) },
    onInsert: (text) => { if (!allowInsert) return false; seen.inserted.push(text); return true },
    onWarn: (message) => { seen.warned.push(message) },
    onOpen: () => {},
    onEditing: () => {},
    onEdited: async () => null
  })

  await panel.restore({ aiModel: 'opencode:test/model', aiMode: 'read', aiEffort: 'none', ai: 'open' })
  await wait(10)   // the catalogue read `open` started
  panel.setNote('a.md')
  await settled()

  const lastTurn = () => api.calls.send[api.calls.send.length - 1]?.turnId
  const busy = () => el.panel.dataset.busy === 'yes'
  const rows = (selector) => [...el.log.querySelectorAll(selector)]
  const texts = (selector) => rows(selector).map((node) => node.textContent)
  const say = async (text) => {
    el.input.value = text
    el.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await wait(20)
  }
  const reply = async (text, extra = {}) => {
    api.emit('ai:event', { k: 'text', text, turnId: lastTurn() })
    api.emit('ai:event', { k: 'turn-end', used: 1000, turnId: lastTurn(), ...extra })
    await wait(5)
    await settled()
  }
  const result = {}

  /* ---------------------------------------------------- an ordinary turn */
  stage('first turn')
  await say('What is this?')
  result.busyAfterSend = busy()
  result.startedOnce = api.calls.start.length
  result.sentOnce = api.calls.send.length
  await reply('It is a note.', { cost: 0.0123 })
  result.idleAfterReply = !busy()
  result.replyDrawn = texts('.msg-bot').some((text) => text.includes('It is a note.'))
  result.costShown = el.contextPop.textContent
  result.insertOffered = rows('.ai-insert').length

  /* ----------------------------------------------------- insert into note */
  stage('insert')
  rows('.ai-insert')[0].click()
  await wait(5)
  result.inserted = seen.inserted.slice()
  allowInsert = false
  rows('.ai-insert')[0].click()
  await wait(5)
  result.insertRefused = seen.warned.slice(-1)[0]
  allowInsert = true

  /* -------------------------------------- queue while busy, drain as one */
  stage('queue')
  await say('First follow-up')
  await say('Second follow-up')
  await say('Third follow-up')
  result.queuedRows = rows('.msg-you.is-queued').length
  result.sentBeforeDrain = api.calls.send.length
  await reply('Answer one.')
  await wait(10)
  result.sentAfterDrain = api.calls.send.length
  result.drainedText = api.calls.send[api.calls.send.length - 1]?.text
  result.queuedRowsAfterDrain = rows('.msg-you.is-queued').length
  await reply('Answer two and three.')

  /* --------------------------------------- an evicted session, restarted */
  stage('gone session')
  api.sendPlan.push({ ok: false, gone: true, error: 'The copilot is not running.' })
  const startsBefore = api.calls.start.length
  const warnsBefore = rows('.msg-warn').length
  await say('Still there?')
  await wait(20)
  result.restartedOnGone = api.calls.start.length - startsBefore
  result.resentOnGone = api.calls.send.slice(-2).every((call) => call.text.endsWith('Still there?'))
  result.noWarningOnGone = rows('.msg-warn').length === warnsBefore
  result.busyAfterRestart = busy()
  await reply('Yes.')

  /* ------------------------------------------------------- a lost thread */
  stage('lost thread')
  await say('Remember me?')
  api.emit('ai:event', { k: 'thread', thread: 'ses_old', turnId: lastTurn() })
  await reply('Of course.')
  /* A settings change is what makes the next message start a copilot again,
     and the start is where the thread to resume is handed over. */
  panel.applyConfig({ aiModel: 'opencode:test/model', aiMode: 'auto', aiEffort: 'none' })
  await say('And now?')
  result.resumedWith = api.calls.start[api.calls.start.length - 1]?.resume ?? '(not restarted)'
  api.emit('ai:event', { k: 'error', message: 'Error: session ses_old not found', lostThread: true, turnId: lastTurn() })
  await wait(5)
  await settled()
  result.lostThreadNoted = texts('.msg-note').some((text) => text.includes('could not be resumed'))
  result.idleAfterLoss = !busy()
  await say('Fresh start?')
  result.resumedAfterLoss = api.calls.start[api.calls.start.length - 1]?.resume
  await reply('Fresh.')

  /* ------------------------------------------------- a review, per file */
  stage('review')
  await say('Fix both notes')
  const operation = { id: 'op-1', changes: [{ path: 'a.md' }, { path: 'b.md' }] }
  api.emit('ai:event', { k: 'review', operation, turnId: lastTurn() })
  await reply('Fixed.')
  result.perFileRejects = rows('.ai-review-file-reject').length
  rows('.ai-review-file-reject')[1].click()
  await wait(5)
  result.restoredOne = seen.restores.slice()
  const single = { id: 'op-2', changes: [{ path: 'a.md' }] }
  await say('Fix one note')
  api.emit('ai:event', { k: 'review', operation: single, turnId: lastTurn() })
  await reply('Fixed one.')
  result.singleFileRejects = rows('.msg-review:last-of-type .ai-review-file-reject').length

  /* ---------------------------------------------------------- /stop */
  stage('/stop')
  await say('Take a long time')
  const stopsBefore = api.calls.stop.length
  await say('/stop')
  await wait(10)
  result.stoppedByCommand = api.calls.stop.length - stopsBefore
  result.idleAfterStop = !busy()
  result.stoppedRow = texts('.msg-note').some((text) => text.startsWith('Stopped'))

  /* ----------------------------------------------- ask mode, once a chat */
  stage('ask mode')
  panel.applyConfig({ aiModel: 'opencode:test/model', aiMode: 'ask', aiEffort: 'none' })
  await say('Edit this')
  await reply('Edited.')
  await say('Edit it again')
  await reply('Edited again.')
  result.askedOnceForTwoTurns = seen.permissions
  await say('/new')
  await wait(5)
  await say('Edit in a new chat')
  await reply('Edited afresh.')
  result.askedAgainForNewChat = seen.permissions
  await say('/mode')   // ask -> auto
  await say('/mode')   // auto -> read
  await say('/mode')   // read -> ask
  await wait(5)
  await say('And after leaving Ask?')
  await reply('Asked again.')
  result.askedAgainAfterModeChange = seen.permissions

  /* ---------------------------------------- the "getting long" notice */
  stage('long chat')
  await say('Go on')
  await reply('Going on.', { used: 70000 })
  result.longNoticeGiven = texts('.msg-note').filter((text) => text.includes('getting long')).length
  await panel.flush()
  const saved = api.calls.saves[api.calls.saves.length - 1]
  const savedConvo = Object.values(saved?.notes || {})[0]?.convos?.find((convo) => convo.suggested)
  result.longNoticePersisted = !!savedConvo

  return result
}
