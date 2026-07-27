import MarkdownIt from 'markdown-it'

/**
 * The assistant panel.
 *
 * It holds no opinion about files. The agent has the vault open on the other
 * side of the bridge and edits notes itself; what arrives here is a narration
 * of that — prose to show, and the name of each note it touched, which goes
 * straight back to the renderer so the open buffer can follow along.
 */

/* Chat prose is not a note: no Run buttons on its fences, no wikilinks, no
   embeds. A plain renderer, kept apart from the one the reading view uses. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true })

/* An empty model means "whatever the CLI is already set to", which is the
   right default — it is the choice the user made when they set the CLI up. */
const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    models: [['', 'Claude'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
  },
  { id: 'codex', label: 'ChatGPT', models: [['', 'ChatGPT']] }
]

const TOOL_VERB = {
  Read: 'Read', Edit: 'Edited', Write: 'Wrote', Glob: 'Searched',
  Grep: 'Searched', TodoWrite: 'Planning', Bash: 'Ran'
}

export function mountAssistant ({ el, api, context, onEdited }) {
  const state = {
    open: false,
    provider: 'claude',
    model: '',
    write: true,      // may the assistant edit notes, or only read them
    busy: false,
    started: false,
    stream: null,     // the assistant bubble currently being written into
    text: ''          // its markdown source, accumulated across deltas
  }

  /* ------------------------------------------------------------- drawing */

  function bubble (role, html) {
    const node = document.createElement('div')
    node.className = `msg msg-${role}`
    node.innerHTML = html
    el.log.append(node)
    scrollDown()
    return node
  }

  /** Pinned to the bottom, unless the reader has deliberately scrolled up. */
  function scrollDown () {
    const slack = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight
    if (slack < 120) el.log.scrollTop = el.log.scrollHeight
  }

  function note (text, kind = 'note') {
    const node = document.createElement('div')
    node.className = `msg msg-${kind}`
    node.textContent = text
    el.log.append(node)
    scrollDown()
  }

  /** One line per tool call, updated in place when it finishes. */
  function step (event) {
    let node = el.log.querySelector(`[data-step="${cssEscape(event.id)}"]`)
    if (!node) {
      node = document.createElement('div')
      node.className = 'msg msg-step'
      node.dataset.step = event.id
      el.log.append(node)
    }
    const verb = TOOL_VERB[event.name] || event.name
    node.textContent = event.path ? `${verb} ${event.path}` : verb
    node.classList.toggle('is-error', !!event.error)
    scrollDown()
    return node
  }

  const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'))

  function setBusy (busy) {
    state.busy = busy
    el.panel.dataset.busy = busy ? 'yes' : 'no'
    el.send.disabled = busy
    el.stop.hidden = !busy
    el.status.textContent = busy ? 'Working…' : ''
  }

  /* -------------------------------------------------------------- events */

  api.on('ai:event', (event) => {
    switch (event.k) {
      case 'ready':
        state.started = true
        break

      case 'thinking':
        if (!state.busy) break
        el.status.textContent = 'Thinking…'
        break

      case 'text':
        if (!state.stream) {
          state.text = ''
          state.stream = bubble('bot', '')
        }
        state.text += event.text
        state.stream.innerHTML = md.render(state.text)
        el.status.textContent = 'Writing…'
        scrollDown()
        break

      case 'tool':
        // A fresh tool call ends the paragraph before it; the next prose the
        // assistant writes belongs in a bubble of its own.
        state.stream = null
        step(event)
        break

      case 'tool-done':
        step(event)
        break

      // The file on disk has changed. Whether that is visible depends on
      // whether it is the note on screen — the renderer decides.
      case 'edited':
        step({ ...event, name: event.name || 'Edit' })
        onEdited(event.path)
        break

      case 'limit':
        if (event.info?.status && event.info.status !== 'allowed') {
          note(`Rate limit: ${event.info.status}.`, 'warn')
        }
        break

      case 'notice':
        if (event.message) note(event.message, 'note')
        break

      // The process is gone — it exited, or was never there to begin with.
      // Forgetting it here is what lets the next message start a fresh one
      // instead of talking to a corpse.
      case 'error':
        state.stream = null
        state.started = false
        note(event.message || 'Something went wrong.', 'warn')
        setBusy(false)
        break

      case 'turn-end':
        state.stream = null
        if (event.error) note(event.error, 'warn')
        setBusy(false)
        break
    }
  })

  /* --------------------------------------------------------------- input */

  async function submit () {
    const text = el.input.value.trim()
    if (!text || state.busy) return

    el.input.value = ''
    sizeInput()
    bubble('you', md.render(text))
    setBusy(true)
    state.stream = null

    // Stopping ends the process, so the next message starts a new one. It has
    // to be started from here, with the settings on screen — left to the
    // bridge it would come back with the defaults rather than the model and
    // write mode the user chose.
    if (!state.started) {
      const started = await api.ai.start({
        provider: state.provider, model: state.model, write: state.write
      })
      state.started = !!started?.ok
      if (!started?.ok) {
        note(started?.error || 'The assistant could not start.', 'warn')
        setBusy(false)
        return
      }
    }

    // Awaited: the renderer flushes the open buffer here, so the agent reads
    // the note as it is on screen rather than as it was at the last autosave.
    const result = await api.ai.send(text, await context())
    if (!result?.ok) {
      // Whatever went wrong, the session is no longer one we can trust; the
      // next message starts over rather than failing the same way again.
      state.started = false
      note(result?.error || 'The assistant could not be reached.', 'warn')
      setBusy(false)
    }
  }

  /** Grows with the message, up to a point, then scrolls. */
  function sizeInput () {
    el.input.style.height = 'auto'
    el.input.style.height = `${Math.min(el.input.scrollHeight, 190)}px`
  }

  el.input.addEventListener('input', sizeInput)
  el.input.addEventListener('keydown', (e) => {
    // Enter sends, because this is a chat box. A newline is still a keystroke
    // away, which is the right way round for messages that are mostly one line.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  })
  el.send.addEventListener('click', submit)
  el.stop.addEventListener('click', async () => {
    await api.ai.stop()
    state.started = false
    state.stream = null
    setBusy(false)
    note('Stopped.', 'note')
  })

  /**
   * Both the model and the write switch are properties of the process, not of
   * the message — neither can be changed without starting a new one, and a
   * conversation cannot be carried across. Saying so beats letting the old
   * transcript imply a continuity that is not there.
   */
  async function restart (what) {
    await api.ai.stop()
    el.log.replaceChildren()
    note(`${what} This is a new conversation.`, 'note')
    const result = await api.ai.start({
      provider: state.provider, model: state.model, write: state.write
    })
    state.started = !!result?.ok
    if (!result?.ok) note(result?.error || 'The assistant could not start.', 'warn')
  }

  el.provider.addEventListener('change', () => {
    const [provider, model = ''] = el.provider.value.split(':')
    state.provider = provider
    state.model = model
    api.config.set({ aiProvider: provider, aiModel: model })
    restart(`Switched to ${label(provider, model)}.`)
  })

  el.write.addEventListener('click', () => {
    state.write = !state.write
    paintWrite()
    api.config.set({ aiWrite: state.write })
    restart(state.write
      ? 'The assistant can edit your notes again.'
      : 'The assistant can now only read your notes.')
  })

  function paintWrite () {
    el.write.setAttribute('aria-pressed', state.write ? 'true' : 'false')
    el.write.title = state.write
      ? 'The assistant can edit notes — click to make it read-only'
      : 'The assistant can only read notes — click to let it edit'
  }

  /* The open note, named the way the vault names things, so the agent can
     resolve it the same way a wikilink would. */
  el.attach.addEventListener('click', async () => {
    const { note: path } = await context()
    if (!path) { note('No note is open.', 'note'); return }
    const name = path.split('/').pop().replace(/\.(md|markdown|mdown)$/i, '')
    const gap = el.input.value && !el.input.value.endsWith(' ') ? ' ' : ''
    el.input.value += `${gap}[[${name}]] `
    sizeInput()
    el.input.focus()
  })

  function label (provider, model) {
    const entry = PROVIDERS.find((p) => p.id === provider)
    return entry?.models.find(([id]) => id === model)?.[1] || entry?.label || provider
  }

  for (const provider of PROVIDERS) {
    for (const [model, text] of provider.models) {
      const option = document.createElement('option')
      option.value = `${provider.id}:${model}`
      option.textContent = text
      el.provider.append(option)
    }
  }
  el.provider.value = 'claude:'

  /* ------------------------------------------------------------ the panel */

  async function open () {
    state.open = true
    el.app.dataset.ai = 'open'
    api.config.set({ ai: 'open' })
    if (!state.started) {
      const result = await api.ai.start({
        provider: state.provider, model: state.model, write: state.write
      })
      if (!result?.ok) {
        note(result.error || 'The assistant could not start.', 'warn')
      } else if (!el.log.children.length) {
        note(`${label(state.provider, state.model)} has your vault open. Ask it to draft, revise, or find something — you will see it edit.`, 'note')
      }
      state.started = !!result?.ok
    }
    el.input.focus()
  }

  function close () {
    state.open = false
    el.app.dataset.ai = 'closed'
    api.config.set({ ai: 'closed' })
  }

  paintWrite()

  return {
    open,
    close,
    toggle: () => (state.open ? close() : open()),
    isOpen: () => state.open,
    busy: () => state.busy,

    /** Settings are applied before the panel is ever opened, so the first
     *  process is started with the choices the user last made. */
    restore: (cfg) => {
      if (cfg.aiProvider) state.provider = cfg.aiProvider
      if (cfg.aiModel != null) state.model = cfg.aiModel
      if (cfg.aiWrite === false) state.write = false
      el.provider.value = `${state.provider}:${state.model}`
      paintWrite()
      if (cfg.ai === 'open') open()
    }
  }
}
