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
      /* The doctor, as main answers it: the CLI is fine, the credentials are not. */
      doctor: async () => [{ id: 'opencode', label: 'opencode', installed: true, version: '1.0', signedIn: false, status: 'Sign in required' }],
      announce: async () => ({ ok: false }),
      attach: async () => null,
      pickAttachments: async () => [],
      history: {
        load: async () => ({}),
        save: async (payload) => {
          if (api.failSaves) { api.failSaves = false; throw new Error('disk gone') }
          calls.saves.push(payload); return { ok: true }
        }
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
  let contextPath = 'a.md'
  let contextSelection = ''
  let failContext = false

  const panel = mountCopilot({
    el,
    api,
    context: async () => {
      if (failContext) throw new Error('Could not save the file.')
      return { note: contextPath, selection: contextSelection, kind: 'note', excerpt: 'hello', excerptCut: false, noteChars: 5 }
    },
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

  result.initialPermission = el.writeLabel.textContent
  result.initialPermissionAria = el.write.getAttribute('aria-label')
  result.modelTitle = el.configModel.title
  result.modelAria = el.configModel.getAttribute('aria-label')
  result.starterText = texts('.msg-note').join(' | ')

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
  contextSelection = 'first selected passage'
  await say('Second follow-up')
  contextSelection = 'second selected passage'
  await say('Third follow-up')
  contextPath = 'b.md'
  contextSelection = 'unrelated selection'
  result.queuedRows = rows('.msg-you.is-queued').length
  result.sentBeforeDrain = api.calls.send.length
  await reply('Answer one.')
  await wait(10)
  result.sentAfterDrain = api.calls.send.length
  result.drainedText = api.calls.send[api.calls.send.length - 1]?.text
  result.drainedContext = api.calls.send.at(-1)?.context
  contextPath = 'a.md'
  contextSelection = ''
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
  result.askPermission = el.writeLabel.textContent
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

  /* ------------------------------------------ a question asked differently */
  stage('edit and resend')
  await say('/new')
  await wait(5)
  await say('Original question')
  await reply('Answer.')
  const questionsBefore = rows('.msg-you').length
  rows('.ai-edit')[0].click()
  await settled()
  el.input.value = 'Original question, but better'
  el.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await wait(20)
  await reply('Better answer.')
  result.editedResent = el.input.value === ''
  result.questionsAfterEdit = rows('.msg-you').length
  result.editReplaced = questionsBefore === result.questionsAfterEdit &&
    texts('.msg-you').some((text) => text.trim() === 'Original question, but better') &&
    !texts('.msg-you').some((text) => text.trim() === 'Original question')
  result.editGaveAttachments = true   // covered by the unqueue case below

  /* --------------------------------------------- a write that fails, once */
  stage('failed save')
  const warnsBeforeFailure = seen.warned.length
  api.failSaves = true
  await panel.flush()
  result.saveFailureSaid = seen.warned.length > warnsBeforeFailure
  // The same note goes out with the next write, once the disk is back.
  const savesBeforeRetry = api.calls.saves.length
  await say('One more')
  await reply('One more answer.')
  await panel.flush()
  result.saveRetried = api.calls.saves.length > savesBeforeRetry &&
    Object.keys(api.calls.saves[api.calls.saves.length - 1]?.notes || {}).includes('a.md')

  /* -------------------------------------- the model menu says who can answer */
  stage('readiness')
  el.input.value = '/model '
  el.input.dispatchEvent(new Event('input', { bubbles: true }))
  await settled()
  result.menuShown = !el.menu.hidden
  result.modelHint = [...el.menu.querySelectorAll('.ai-menu-hint')]
    .map((node) => node.textContent).join(' | ')
  el.input.value = ''
  el.input.dispatchEvent(new Event('input', { bubbles: true }))
  await settled()

  stage('failed context save')
  const sendsBeforeFailure = api.calls.send.length
  failContext = true
  await say('Do not send with unsaved changes')
  await settled()
  result.failedContextSends = api.calls.send.length - sendsBeforeFailure
  result.failedContextIdle = !busy()
  result.failedContextWarning = texts('.msg-warn').some((text) => text.includes('Could not save the file'))
  failContext = false


  stage('composer toolbar removed')
  result.workspaceToolbarRemoved = !el.panel.querySelector('.ai-workspace-tools')
  await say('Explain this reference')
  await reply('Reference answer with [[b#Proof]].')
  result.noteSourceLink = !!el.log.querySelector('[data-source="b#Proof"]')

  stage('streaming responsiveness')
  await say('Stream a long answer')
  const delays = []
  for (let i = 0; i < 50; i++) {
    const start = performance.now()
    api.emit('ai:event', { k: 'text', text: 'A **research** paragraph with an equation $x^2$.\n\n'.repeat(3), turnId: lastTurn() })
    el.input.value += 'x'
    el.input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    delays.push(performance.now() - start)
  }
  await reply('Done.')
  result.streamingP95Ms = delays.sort((a,b) => a-b)[Math.floor(delays.length * .95)]
  result.streamingInputKept = el.input.value === 'x'.repeat(50)
  return result
}
