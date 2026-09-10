import { openPackages } from './packages.js'
/* ============================================================= settings
   A compact sidebar and quiet detail rows, following Rose’s settings layout.

   Nothing here decides what a setting *means*. Every row states its key and
   its control, and hands the new value to `onChange`; the renderer is what
   applies it and writes it down. That is what stops this file from acquiring a
   second, quietly different, idea of the app's state.
   ================================================================== */

import { el as node } from './dom.js'
import { isMac } from './platform.js'
import { SPELL_LANGUAGES } from './spell-languages.js'
import { NO_MATCH, dropdown, matcher } from './dropdown.js'
import { THEMES, resolveTheme } from './themes.js'

/* Zoom is the one setting the main process owns outright — it is a property of
   the window, not of the page — so the stops come from the same table the menu
   steps through rather than from a second copy that would drift out of step
   with it. */
import { ZOOM_STEPS, DEFAULT_ZOOM, nearestStep } from './zoom.js'

/* The model list is shared with the copilot panel — see models.js. Two
   copies of "what can answer" is how the panel and this pane end up offering
   different things. */
import {
  DEFAULT_CATALOGUE,
  allModels, asOptions, defaultEnabled, effortLabel, effortsFor, modelFromConfig,
  nearestEffort, offeredModels,
  providerLabel
} from './models.js'

// Related preferences share a page; headings keep specialist controls easy to scan.
// Hints stay to one quiet line: the name says what it is, the hint says what it
// does when the name alone does not.
const SECTIONS = [
  {
    id: 'appearance',
    group: 'Tulip',
    label: 'Appearance',
    rows: [
      {
        key: 'theme',
        type: 'themes',
        name: 'Theme'
      },
      {
        key: 'zoom',
        type: 'zoom',
        name: 'Window zoom',
      }
    ]
  },
  {
    id: 'vault',
    group: 'Tulip',
    label: 'General',
    rows: [
      {
        key: 'defaultVaultPath',
        type: 'default-vault',
        name: 'Default vault',
      }
    ]
  },
  {
    id: 'hotkeys',
    group: 'Tulip',
    label: 'Shortcuts',
    rows: [
      {
        key: 'hotkeys',
        type: 'hotkeys',
        name: 'Keyboard shortcuts',
      }
    ]
  },
  {
    id: 'markdown',
    group: 'Workspace',
    label: 'Editor',
    rows: [
      {
        key: 'readableWidth',
        type: 'toggle',
        name: 'Readable line length',
        fallback: true,
        group: 'Reading'
      },
      {
        key: 'measure',
        type: 'segment',
        name: 'Line width',
        options: [
          { value: 'narrow', label: 'Narrow' },
          { value: 'normal', label: 'Normal' },
          { value: 'wide', label: 'Wide' }
        ],
        fallback: 'normal',
        group: 'Reading',
      },
      {
        key: 'centerHeadings',
        type: 'toggle',
        name: 'Centre headings',
        fallback: false,
        group: 'Reading'
      },
      {
        key: 'spellcheck',
        type: 'toggle',
        name: 'Check spelling',
        fallback: true,
        group: 'Spelling'
      },
      {
        key: '',
        type: 'dictionary',
        name: 'Personal dictionary',
        group: 'Spelling'
      },
      {
        key: 'spellLanguages',
        type: 'languages',
        name: 'Languages',
        fallback: [],
        group: 'Spelling'
      },
      {
        key: 'codeNumbers',
        type: 'toggle',
        name: 'Line numbers',
        fallback: true,
        group: 'Code blocks'
      },
      {
        key: 'codeWrap',
        type: 'toggle',
        name: 'Wrap long lines',
        fallback: false,
        group: 'Code blocks'
      }
    ]
  },
  {
    id: 'documents',
    group: 'Workspace',
    label: 'Documents',
    rows: [
      {
        key: 'pdfText',
        type: 'toggle',
        name: 'Read PDF text',
        fallback: true,
        group: 'PDF',
      },
      {
        key: 'sourceNumbers',
        type: 'toggle',
        name: 'Line numbers',
        fallback: false,
        group: 'Source files'
      },
      {
        key: 'csvBorders',
        type: 'toggle',
        name: 'Cell borders',
        fallback: false,
        group: 'Tables'
      },
      {
        key: 'texEngine',
        type: 'select',
        name: 'Compiler',
        options: [
          { value: 'pdflatex', label: 'pdfLaTeX' },
          { value: 'xelatex', label: 'XeLaTeX' },
          { value: 'lualatex', label: 'LuaLaTeX' }
        ],
        fallback: 'pdflatex',
        group: 'LaTeX'
      },
      {
        key: 'autoInstallPackages',
        type: 'toggle',
        name: 'Automatically install missing packages',
        fallback: true,
        group: 'Code packages',
      },
      {
        type: 'packages',
        name: 'Packages by note',
        group: 'Code packages'
      },
      {
        key: 'manimQuality',
        type: 'select',
        name: 'Manim quality',
        options: [
          { value: 'l', label: 'Low — 480p15' },
          { value: 'm', label: 'Medium — 720p30' },
          { value: 'h', label: 'High — 1080p60' },
          { value: 'p', label: 'Very high — 1440p60' },
          { value: 'k', label: '4K — 2160p60' }
        ],
        fallback: 'm',
        group: 'Animation'
      }
    ]
  },
  {
    id: 'study',
    group: 'Workspace',
    label: 'Study',
    rows: [
      {
        key: 'studyNewPerDay',
        type: 'number',
        name: 'New words per day',
        placeholder: '8',
        min: 1,
        max: 200
      },
      {
        key: 'studyRetention',
        type: 'select',
        name: 'Recall target',
        options: [
          { value: 0.85, label: '85% — fewer reviews' },
          { value: 0.9, label: '90% — balanced' },
          { value: 0.95, label: '95% — more reviews' }
        ],
        fallback: 0.9,
        cast: Number,
      },
      {
        key: 'studySpeaking',
        type: 'toggle',
        name: 'Read words aloud',
        fallback: true
      }
    ]
  },
  {
    id: 'copilot',
    group: 'Workspace',
    label: 'Copilot',
    rows: [
      {
        key: 'aiModel',
        type: 'models',
        name: 'Default model',
        group: 'Model',
      },
      {
        key: 'aiEffort',
        type: 'effort',
        name: 'Thinking level',
        group: 'Model',
      },
      {
        key: 'aiModels',
        type: 'catalogue',
        name: 'Available models',
        group: 'Model',
      },
      {
        key: '',
        type: 'doctor',
        name: 'Connection status',
        group: 'Diagnostics',
      }
    ]
  }
]

// Existing in-app links continue to reach their consolidated page.
const SECTION_ALIASES = { source: 'documents', csv: 'documents', tex: 'documents', python: 'documents', pdf: 'documents' }

/* A keydown, as the accelerator string Electron's menu takes. Letters and
   digits come from `code` so a layout's shifted characters do not leak into
   the name; the punctuation Electron accepts is mapped the same way. A chord
   with no modifier would fire in the middle of typing, so only the F-keys may
   go bare. */
const NAMED_KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  ' ': 'Space', Enter: 'Return', Tab: 'Tab', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', '+': 'Plus'
}
const PUNCT_CODES = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Slash: '/', Backquote: '`'
}

function chordOf (event) {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return null
  const parts = []
  if (event.metaKey) parts.push('Cmd')
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const code = event.code || ''
  let key = ''
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) key = event.key
  else if (PUNCT_CODES[code]) key = PUNCT_CODES[code]
  else key = NAMED_KEYS[event.key] || ''
  if (!key) return null
  if (!parts.length && !/^F\d/.test(key)) return null
  return [...parts, key].join('+')
}

/* An accelerator, spelt the way this desktop spells keys — glyphs run
   together on a Mac, words joined by + everywhere else. */
const MAC_GLYPHS = {
  Cmd: '⌘', CmdOrCtrl: '⌘', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧',
  Return: '⏎', Enter: '⏎', Backspace: '⌫', Delete: '⌦', Escape: '⎋', Esc: '⎋',
  Space: '␣', Tab: '⇥', Up: '↑', Down: '↓', Left: '←', Right: '→', Plus: '+'
}

function chordLabel (accel) {
  const parts = String(accel || '').split('+')
  if (isMac()) return parts.map((p) => MAC_GLYPHS[p] || p).join('')
  return parts.map((p) => (p === 'CmdOrCtrl' || p === 'Cmd' ? 'Ctrl' : p)).join('+')
}

/**
 * @param el        the shell from index.html
 * @param api       window.tulip
 * @param values    () => the current config object
 * @param onChange  (key, value) => void — persist it and put it into effect
 */
export function mountSettings ({ el, api, values, onChange }) {
  let active = SECTIONS[0].id
  let modelCatalogue = DEFAULT_CATALOGUE
  /* The rebindable commands, from the menu itself — see hotkeys:list. */
  let hotkeyCatalogue = []
  /* The extra dictionaries this build carries — see spell:installed. `null`
     until the answer arrives, which the grid reads as "assume they are all
     there": the ordinary build has all of them, and a grid that greyed itself
     out for the moment before the answer came back would flicker on every
     open. */
  /** @type {string[] | null} */
  let spellInstalled = null
  /** @type {Array<{id:string, label:string, signedIn:boolean, version?:string, status:string}>|null} */
  let doctorState = null
  /* ------------------------------------------------------------ controls */

  /** The stored value for a row, or what the app behaves as when unset. */
  function valueOf (row) {
    const raw = row.key === 'autoInstallPackages' ? (values().autoInstallPackages ?? values().autoInstallPythonDeps) : values()[row.key]
    if (raw === undefined || raw === null || raw === '') {
      return row.fallback !== undefined ? row.fallback : ''
    }
    return row.cast ? row.cast(raw) : raw
  }

  function change (row, value) {
    const focused = document.activeElement
    const previousRow = focused?.closest('.settings-row')
    const at = previousRow && focused ? [...previousRow.querySelectorAll('button, input, select')].indexOf(focused) : -1
    // Picking a text width should apply it even when full-width reading was on.
    if (row.key === 'measure' && values().readableWidth === false) onChange('readableWidth', true)
    onChange(row.key, value)
    // Rows can depend on each other — the zoom stepper reads back what the
    // main process settled on — so the pane is redrawn rather than patched.
    renderBody()
    if (at >= 0) {
      const nextRow = [...el.body.querySelectorAll('.settings-row')].find((line) => line.dataset.setting === row.key)
      nextRow?.querySelectorAll('button, input, select')[at]?.focus({ preventScroll: true })
    }
  }

  /* ----------------------------------------------------------- dictionary
     The words spellcheck has been taught — usually from the context menu over
     a red underline, though the field here takes one typed in too. Chips so a
     slip of the hand can be undone: clicking a word takes it back out, and
     the checker minds it again.

     Read from the spellchecker every time the dialog opens, not kept in the
     config: the dictionary is the platform's, and words can arrive from the
     context menu while this pane is closed. The one field both searches and
     adds — typing narrows the chips to what matches, and Add takes whatever
     is typed in whole. */
  /** @type {any} */
  let dictDialog = null

  function openDictionary () {
    if (!dictDialog) {
      dictDialog = node('dialog', 'dict-dialog')
      dictDialog.setAttribute('aria-label', 'Dictionary')
      document.body.append(dictDialog)
      dictDialog.addEventListener('mousedown', (event) => {
        if (event.target === dictDialog) dictDialog.close()
      })
    }

    const head = node('div', 'dict-head')
    const done = node('button', 'model-refresh', 'Done')
    done.type = 'button'
    done.addEventListener('click', () => dictDialog.close())
    head.append(node('h2', 'dict-title', 'Dictionary'), done)

    const add = node('div', 'dict-add')
    const input = node('input', 'field')
    input.type = 'text'
    input.spellcheck = false
    input.placeholder = 'Search, or type a word to add…'
    const put = node('button', 'model-refresh', 'Add')
    put.type = 'button'
    add.append(input, put)

    const list = node('div', 'dict-list')

    let words = []
    function paint () {
      /* An empty dictionary shows an empty list. The field above it already
         says what to type and the chips say what happens to it, so the
         paragraph explaining both was a wall of text over nothing. */
      if (!words.length) {
        list.replaceChildren()
        return
      }
      const hit = matcher(input.value)
      const shown = words.filter((word) => hit(word))
      if (!shown.length) {
        list.replaceChildren(node('span', 'settings-hint',
          'No matching words.'))
        return
      }
      list.replaceChildren(...shown.map((word) => {
        const chip = node('button', 'model-chip')
        chip.type = 'button'
        chip.title = `Take “${word}” out — check it again`
        chip.append(node('span', 'model-chip-name', word), node('span', 'model-chip-x', '×'))
        chip.addEventListener('click', async () => {
          await api.dictionary.remove(word)
          load()
        })
        return chip
      }))
    }
    async function load () {
      try { words = await api.dictionary.words() } catch { words = [] }
      paint()
    }

    const commit = async () => {
      const word = input.value.trim()
      if (!word) return
      input.value = ''
      await api.dictionary.add(word)
      load()
    }
    put.addEventListener('click', commit)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit()
    })
    input.addEventListener('input', paint)

    dictDialog.replaceChildren(head, add, list)
    load()
    dictDialog.showModal()
    input.focus()
  }

  const CONTROLS = {
    packages () {
      const wrap = node('div', 'env-actions')
      const show = node('button', 'ghost', 'Show notes')
      show.addEventListener('click', async () => {
        show.disabled = true
        try {
          const records = await api.packages.list()
          wrap.replaceChildren()
          if (!records.length) wrap.append(node('span', 'settings-hint', 'No environments.'))
          for (const record of records) {
            const button = node('button', 'ghost', `${record.note || 'Scratch code'} · ${record.language}`)
            button.addEventListener('click', () => openPackages(record.note, record.language))
            wrap.append(button)
          }
        } catch (error) { show.textContent = error.message; show.disabled = false }
      })
      wrap.append(show)
      return wrap
    },
    doctor () {
      const wrap = node('div', 'ai-doctor')
      const results = node('div', 'ai-doctor-results')
      const run = node('button', 'model-refresh', 'Check')
      run.type = 'button'

      if (doctorState?.length) {
        for (const provider of doctorState) {
          const row = node('div', `ai-doctor-provider is-${provider.signedIn ? 'ready' : 'problem'}`)
          row.append(
            node('span', 'ai-doctor-name', provider.label),
            node('span', 'ai-doctor-version', provider.version || 'Not installed'),
            node('span', 'ai-doctor-status', provider.status)
          )
          results.append(row)
        }
      }

      run.addEventListener('click', async () => {
        run.disabled = true
        run.textContent = 'Checking…'
        try {
          doctorState = await api.ai.doctor()
          renderBody()
        } catch {
          run.disabled = false
          run.textContent = 'Could not check'
        }
      })
      wrap.append(results, run)
      return wrap
    },
    /**
     * The words spellcheck has been taught, behind one quiet row: the list
     * itself opens in a dialog rather than living on the pane, where a long
     * vocabulary was a wall of chips between Markdown's other rows.
     */
    dictionary () {
      const button = node('button', 'model-refresh', 'Edit…')
      button.type = 'button'
      button.title = 'Add and remove words the spellchecker skips'
      button.addEventListener('click', openDictionary)
      return button
    },

    /**
     * The spellchecker's extra languages, on the same checkbox grid the model
     * list uses. Each click writes the whole list: the config holds ids, the
     * grid holds labels, and `change` redraws the pane so the row never shows
     * a state the checker is not in.
     */
    languages (row) {
      const grid = node('div', 'model-shelf-grid')
      const chosen = new Set(Array.isArray(valueOf(row)) ? valueOf(row) : [])
      for (const { id, label } of SPELL_LANGUAGES) {
        /* A build can be made without some of these — see
           TULIP_SPELL_LANGUAGES in build.mjs. One that is not here cannot be
           turned on, and saying so is the whole point: the checker goes quietly
           without a dictionary it cannot find, so a tickable box for a language
           that is not in the build would be a setting that does nothing and
           reports nothing. */
        const here = !spellInstalled || spellInstalled.includes(id)
        const option = node('button', 'model-option')
        option.type = 'button'
        option.setAttribute('role', 'checkbox')
        option.setAttribute('aria-checked', String(here && chosen.has(id)))
        option.classList.toggle('is-on', here && chosen.has(id))
        option.append(node('span', 'model-tick'), node('span', 'model-name', label))
        if (!here) {
          option.disabled = true
          option.classList.add('is-absent')
          option.title = `${label} is not in this build of Tulip.`
          option.append(node('span', 'model-note', 'not in this build'))
        }
        option.addEventListener('click', () => {
          const next = new Set(chosen)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          change(row, [...next].sort())
        })
        grid.append(option)
      }
      return grid
    },

    /**
     * Every rebindable command, with its key — the menu is the registry (see
     * `applyHotkeys` in electron/main.js), read over IPC when the pane opens.
     *
     * Obsidian's arrangement: click the key, press the new one. A binding
     * that matches the default is stored as nothing at all, so the config
     * carries only what the user actually moved; Backspace clears a key
     * outright, and two commands on one chord are both flagged rather than
     * silently letting the first of them win.
     */
    hotkeys () {
      const wrap = node('div', 'hotkey-list')

      const effective = (overrides) => {
        const map = new Map()
        for (const entry of hotkeyCatalogue) {
          const held = overrides[entry.command]
          map.set(entry.command, typeof held === 'string' ? held : entry.accelerator)
        }
        return map
      }

      const saveHotkey = (command, accel) => {
        const next = { ...(values().hotkeys || {}) }
        const fallback = hotkeyCatalogue.find((e) => e.command === command)?.accelerator || ''
        if (accel === fallback) delete next[command]
        else next[command] = accel
        onChange('hotkeys', next)
        paint()
      }

      /* One recording at a time, on the window and in capture, so the chord
         being pressed reaches nothing else — not the editor, and not the
         pane's own Escape-to-close. */
      /** @type {{command: any, chip: any} | null} */
      let recording = null
      const stopRecording = () => {
        if (!recording) return
        window.removeEventListener('keydown', onRecordKey, true)
        recording.chip.classList.remove('is-recording')
        recording = null
        paint()
      }
      const onRecordKey = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') { stopRecording(); return }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          const { command } = /** @type {{command: any, chip: any}} */ (recording)
          stopRecording()
          saveHotkey(command, '')
          return
        }
        const chord = chordOf(event)
        if (!chord) return
        const { command } = /** @type {{command: any, chip: any}} */ (recording)
        stopRecording()
        saveHotkey(command, chord)
      }

      function paint () {
        wrap.replaceChildren()
        if (!hotkeyCatalogue.length) {
          wrap.append(node('span', 'settings-hint', 'Loading shortcuts…'))
          return
        }
        const overrides = values().hotkeys || {}
        const bound = effective(overrides)
        /* Who else answers to each chord, for the conflict flag. */
        const claims = new Map()
        for (const [command, accel] of bound) {
          if (accel) claims.set(accel, (claims.get(accel) || []).concat(command))
        }
        for (const entry of hotkeyCatalogue) {
          const line = node('div', 'hotkey-row')
          const name = node('span', 'hotkey-name', entry.label)
          if (entry.section) name.title = entry.section
          line.append(name)

          const custom = typeof overrides[entry.command] === 'string'
          const current = bound.get(entry.command)

          const rivals = current ? claims.get(current).filter((c) => c !== entry.command) : []
          if (rivals.length) {
            const flag = node('span', 'hotkey-conflict', 'both bound')
            flag.title = 'This key is also bound to: ' +
              rivals.map((c) => hotkeyCatalogue.find((e) => e.command === c)?.label || c).join(', ')
            line.append(flag)
          }

          if (custom) {
            const reset = node('button', 'hotkey-reset', '↺')
            reset.type = 'button'
            reset.title = `Back to the default${entry.accelerator ? ` (${chordLabel(entry.accelerator)})` : ''}`
            reset.setAttribute('aria-label', 'Restore the default shortcut')
            reset.addEventListener('click', () => {
              const next = { ...(values().hotkeys || {}) }
              delete next[entry.command]
              onChange('hotkeys', next)
              paint()
            })
            line.append(reset)
          }

          const chip = node('button', `hotkey-chord${custom ? ' is-custom' : ''}${current ? '' : ' is-blank'}`)
          chip.type = 'button'
          chip.textContent = current ? chordLabel(current) : 'Not set'
          chip.title = 'Click, then press the new shortcut'
          chip.addEventListener('click', () => {
            stopRecording()
            recording = { command: entry.command, chip }
            chip.classList.add('is-recording')
            chip.textContent = 'Press keys…'
            window.addEventListener('keydown', onRecordKey, true)
          })
          chip.addEventListener('blur', stopRecording)
          line.append(chip)
          wrap.append(line)
        }
      }

      paint()
      return wrap
    },

    toggle (row) {
      const on = valueOf(row) !== false
      const button = node('button', 'switch')
      button.type = 'button'
      button.setAttribute('role', 'switch')
      button.setAttribute('aria-label', row.name)
      button.setAttribute('aria-checked', String(on))
      button.append(node('span', 'switch-thumb'))
      button.addEventListener('click', () => change(row, !on))
      return button
    },

    segment (row) {
      const current = valueOf(row)
      const group = node('div', 'seg')
      group.setAttribute('role', 'radiogroup')
      group.setAttribute('aria-label', row.name)
      for (const option of row.options) {
        const button = node('button', '', option.label)
        button.type = 'button'
        button.setAttribute('role', 'radio')
        button.setAttribute('aria-checked', String(option.value === current))
        button.addEventListener('click', () => change(row, option.value))
        group.append(button)
      }
      return group
    },

    /* The app's own menu rather than a native `<select>`, whose popup the
       operating system draws in its own font and its own accent — see
       dropdown.js. Values keep their type on the way out, so a numeric
       setting is stored as a number. */
    select (row) {
      return dropdown({
        label: row.name,
        options: row.options,
        value: valueOf(row),
        onChange: (value) => change(row, value)
      }).root
    },

    /** The default model, chosen from the same deliberate shortlist the
     *  composer offers. The current choice remains present even if it has just
     *  been unticked, which gives the reader somewhere stable to move from. */
    models (row) {
      const chosen = modelFromConfig(values())
      const wrap = node('div', 'model-default')
      wrap.append(dropdown({
        label: 'Default model',
        className: 'is-wide',
        search: true,
        options: asOptions(offeredModels(modelCatalogue, values().aiModels, chosen)),
        value: chosen,
        placeholder: 'No model selected',
        onChange: (key) => {
          /* The level belongs to the model: settle the stored one against the
             new model's own levels before drawing, so the Thinking row never
             shows a level the model has never offered. Written silently first
             so the redraw below — which restores focus to this row — shows
             both new readings at once. The panel settles the same way in
             memory; see `settleEffort` in copilot.js. */
          const model = allModels(modelCatalogue).find((entry) => entry.key === key)
          if (model && effortsFor(model).length) {
            const settled = nearestEffort(model, values().aiEffort || 'medium')
            if (settled && values().aiEffort !== settled) onChange('aiEffort', settled)
          }
          change(row, key)
        }
      }).root)

      return wrap
    },

    /**
     * The default model's thinking level — the same `aiEffort` the panel steps
     * with ⌃T and carries per chat. The levels are the default model's own, so
     * the control follows it: a model with no such dial says so instead of
     * offering one, and a stored level the model does not take is shown at the
     * nearest one it does — the panel's `nearestEffort` reading, not a second
     * idea of it.
     */
    effort (row) {
      const key = modelFromConfig(values())
      if (!key) return node('span', 'settings-hint', 'Choose a default model first.')
      const model = allModels(modelCatalogue).find((entry) => entry.key === key)
      if (!model) return node('span', 'settings-hint', 'Reading the model list…')
      const levels = effortsFor(model)
      if (!levels.length) return node('span', 'settings-hint', `${model.label} has no thinking levels.`)
      return dropdown({
        label: 'Thinking level',
        options: levels.map((level) => ({ value: level, label: effortLabel(level) })),
        value: nearestEffort(model, values().aiEffort || 'medium'),
        onChange: (value) => change(row, value)
      }).root
    },

    // The shortlist is the default view. Browse groups or search to add a model.
    catalogue (row) {
      const all = [...allModels(modelCatalogue)]
      const stored = values()[row.key]
      const chosen = new Set(Array.isArray(stored) ? stored : defaultEnabled(modelCatalogue))
      // Keep saved selections visible while a provider catalogue is refreshing.
      for (const key of chosen) {
        if (all.some((model) => model.key === key)) continue
        const saved = offeredModels(modelCatalogue, [key], key).find((model) => model.key === key)
        if (saved) all.push(saved)
      }
      let query = ''
      let selectedOnly = chosen.size > 0
      const opened = new Map()
      const providers = new Set(all.map((model) => model.provider))
      const groups = []
      const byName = new Map()
      for (const model of all) {
        const shelf = model.group || providerLabel(model.provider)
        const name = providers.size > 1 && shelf !== providerLabel(model.provider)
          ? `${providerLabel(model.provider)} · ${shelf}` : shelf
        let group = byName.get(name)
        if (!group) {
          group = { name, models: [] }
          byName.set(name, group)
          groups.push(group)
        }
        group.models.push(model)
      }
      groups.sort((a, b) => a.name.localeCompare(b.name))
      for (const group of groups) group.models.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))

      const wrap = node('div', 'model-picker is-simple')
      const head = node('div', 'model-picker-head')
      const filters = node('div', 'seg model-filters')
      filters.setAttribute('aria-label', 'Model list')
      const selected = node('button', '', 'Selected')
      const browse = node('button', '', 'All models')
      for (const button of [selected, browse]) button.type = 'button'
      filters.append(selected, browse)
      const again = node('button', 'model-refresh', 'Refresh')
      again.type = 'button'
      again.addEventListener('click', () => {
        again.disabled = true
        again.textContent = 'Refreshing…'
        loadModels({ fresh: true }).catch(() => {
          again.disabled = false
          again.textContent = 'Retry'
        })
      })
      head.append(filters, again)
      const search = node('input', 'field model-search')
      search.type = 'search'
      search.spellcheck = false
      search.placeholder = 'Search models…'
      search.setAttribute('aria-label', 'Search models')
      const list = node('div', 'model-picker-list')
      wrap.append(head, search, list)

      const updateFilters = () => {
        selected.textContent = `Selected (${chosen.size})`
        selected.setAttribute('aria-pressed', String(selectedOnly))
        browse.setAttribute('aria-pressed', String(!selectedOnly))
      }
      const persist = () => {
        onChange(row.key, [...chosen])
        updateFilters()
        // Refresh only the default picker so new selections are immediately available.
        const defaultControl = el.body.querySelector('[data-setting="aiModel"] .settings-control')
        if (defaultControl) defaultControl.replaceChildren(CONTROLS.models({ key: 'aiModel' }))
      }
      function paint () {
        updateFilters()
        const hit = matcher(query)
        const shown = groups.map((group) => ({
          ...group, models: group.models.filter((model) => hit(model.search) && (!selectedOnly || chosen.has(model.key)))
        })).filter((group) => group.models.length)
        list.replaceChildren(...shown.map((group) => {
          const open = opened.has(group.name)
            ? opened.get(group.name)
            : !!query || selectedOnly
          const box = node('div', 'model-group')
          box.classList.toggle('is-open', open)
          const bar = node('button', 'model-group-head')
          bar.type = 'button'
          bar.setAttribute('aria-expanded', String(open))
          bar.append(node('span', 'model-group-caret'), node('span', 'model-group-name', group.name),
            node('span', 'model-group-count', String(group.models.length)))
          bar.addEventListener('click', () => { opened.set(group.name, !open); paint() })
          box.append(bar)
          if (open) {
            const body = node('div', 'model-group-body')
            for (const model of group.models) {
              const option = node('button', 'model-option')
              option.type = 'button'
              option.setAttribute('role', 'checkbox')
              option.title = `${group.name} · ${model.label}`
              option.append(node('span', 'model-tick'), node('span', 'model-name', model.label))
              const mark = () => {
                option.setAttribute('aria-checked', String(chosen.has(model.key)))
                option.classList.toggle('is-on', chosen.has(model.key))
              }
              mark()
              option.addEventListener('click', () => {
                if (chosen.has(model.key)) chosen.delete(model.key)
                else chosen.add(model.key)
                mark()
                persist()
                if (selectedOnly) { paint(); selected.focus() }
              })
              body.append(option)
            }
            box.append(body)
          }
          return box
        }))
        if (!shown.length) list.append(node('div', 'model-picker-empty', selectedOnly ? 'No selected models' : NO_MATCH))
      }
      selected.addEventListener('click', () => { selectedOnly = true; opened.clear(); paint() })
      browse.addEventListener('click', () => { selectedOnly = false; opened.clear(); paint() })
      search.addEventListener('input', () => {
        query = search.value
        if (query.trim()) selectedOnly = false
        opened.clear()
        paint()
      })
      paint()
      return wrap
    },

    number (row) {
      const wrap = node('div', 'field-wrap')
      const input = node('input', 'field is-number')
      input.type = 'number'
      input.min = String(row.min ?? 0)
      input.max = String(row.max ?? 99999)
      input.placeholder = row.placeholder || ''
      input.value = values()[row.key] ?? ''
      // On commit rather than on keystroke: a half-typed "1" out of "120"
      // would otherwise be saved and clamped on its way past.
      // An emptied field clears the key rather than storing '', which is
      // not a number and is refused at the door — see electron/config-keys.js.
      const commit = () => {
        const n = Number(input.value)
        change(row, input.value.trim() && n > 0 ? n : undefined)
      }
      input.addEventListener('change', commit)
      input.addEventListener('blur', commit)
      wrap.append(input)
      return wrap
    },

    themes () {
      const current = resolveTheme(values().theme)
      const list = node('div', 'theme-grid')
      for (const theme of THEMES) {
        const button = node('button', 'theme-card')
        button.type = 'button'
        button.setAttribute('aria-pressed', String(theme.id === current))

        const swatch = node('span', 'swatch')
        for (const colour of theme.swatch) {
          const dot = node('i')
          dot.style.setProperty('--dot', colour)
          swatch.append(dot)
        }
        button.append(swatch, node('span', 'theme-name', theme.label))
        button.addEventListener('click', () => change({ key: 'theme' }, theme.id))
        list.append(button)
      }
      return list
    },

    /**
     * The vault Tulip opens on launch: the pinned path beside the button, or
     * whatever was last open when nothing is pinned. One move — pick a folder
     * through the native dialog. The pick goes through main's
     * `vault:pick-default`, which enters the folder into the recent list — the
     * value check in `config:set` only accepts the open vault or a recent one,
     * so the write that follows is one main will keep.
     */
    'default-vault' (row) {
      const wrap = node('div', 'env-actions')
      const pinned = values()[row.key] || ''
      const shown = node('span', 'settings-hint is-path', pinned || 'Last open')
      if (pinned) shown.title = pinned
      const pick = node('button', 'model-refresh', 'Choose…')
      pick.type = 'button'
      pick.title = 'Choose the vault Tulip opens on launch'
      pick.addEventListener('click', async () => {
        pick.disabled = true
        try {
          const chosen = await api.vault.pickDefault?.().catch(() => null)
          if (chosen) change(row, chosen)
          else renderBody()
        } finally {
          pick.disabled = false
        }
      })
      wrap.append(shown, pick)
      return wrap
    },

    /* Zoom is the window's, so the row steps through the same stops the menu
       does rather than inventing a second scale. */
    zoom () {
      const factor = Number(values().zoom) || DEFAULT_ZOOM
      const at = nearestStep(factor)

      const wrap = node('div', 'stepper')
      const step = (label, to, title) => {
        const button = node('button', '', label)
        button.type = 'button'
        button.title = title
        button.disabled = to === at
        button.addEventListener('click', () => change({ key: 'zoom' }, ZOOM_STEPS[to]))
        return button
      }
      wrap.append(step('−', Math.max(0, at - 1), 'Smaller'))
      const readout = node('button', 'stepper-value', `${Math.round(ZOOM_STEPS[at] * 100)}%`)
      readout.type = 'button'
      readout.title = 'Back to the default size'
      readout.addEventListener('click', () => change({ key: 'zoom' }, DEFAULT_ZOOM))
      wrap.append(readout, step('+', Math.min(ZOOM_STEPS.length - 1, at + 1), 'Larger'))
      return wrap
    }
  }

  /* -------------------------------------------------------------- render */

  function renderRail () {
    el.rail.replaceChildren()
    // App preferences first, then workspace features.
    /** @type {string | null} */
    let group = null
    for (const section of SECTIONS) {
      if (section.group && section.group !== group) {
        group = section.group
        el.rail.append(node('div', 'settings-rail-head', group))
      }
      const button = node('button', 'settings-tab', section.label)
      button.type = 'button'
      button.setAttribute('aria-current', String(section.id === active))
      button.addEventListener('click', () => {
        active = section.id
        renderRail()
        renderBody()
        el.body.scrollTop = 0
        el.rail.querySelector('[aria-current="true"]')?.focus()
      })
      el.rail.append(button)
    }
  }

  function renderBody () {
    const section = SECTIONS.find((s) => s.id === active) || SECTIONS[0]
    el.title.textContent = section.label
    el.body.replaceChildren()

    let group = null
    /** @type {HTMLElement | null} */
    let card = null
    for (const row of section.rows) {
      if (row.group && row.group !== group) {
        group = row.group
        el.body.append(node('h3', 'settings-group-title', group))
      }
      if (!card || card.dataset.group !== (row.group || '')) {
        card = document.createElement('div')
        card.className = 'settings-card'
        card.dataset.group = row.group || ''
        el.body.append(card)
      }
      const line = node('div', 'settings-row')
      line.dataset.setting = row.key || row.type
      const label = node('div', 'settings-label')
      const name = node('div', 'settings-name', row.name)
      label.append(name)
      line.append(label)

      const control = /** @type {any} */ (CONTROLS[row.type])?.(row)
      if (control && row.type === 'doctor') {
        line.append(control.querySelector('.model-refresh'))
        const results = control.querySelector('.ai-doctor-results')
        if (results.hasChildNodes()) line.append(results)
      } else if (control) {
        if (row.type === 'default-vault' && document.body.classList.contains('settings-window')) {
          const path = control.querySelector('.settings-hint.is-path')
          if (path) label.append(path)
        }
        const holder = node('div', 'settings-control')
        holder.append(control)
        line.append(holder)
      }

      // A full-width control reads better under its label than squeezed
      // beside it — the theme grid and the model list are both of those.
      if (row.type === 'themes' || row.type === 'models' || row.type === 'catalogue' ||
          row.type === 'hotkeys' || row.type === 'languages') line.classList.add('is-stacked')
      if (row.enabledBy && values()[row.enabledBy] === false) {
        line.classList.add('is-disabled')
        control?.querySelectorAll('button, input, select').forEach((item) => { item.disabled = true })
      }
      card.append(line)
    }
  }

  /* -------------------------------------------------------------- search
     One field over the whole pane, between the section's title and the close
     button. Typing suggests every row it matches — by its own name, its group
     or its hint — and choosing one switches to that section and flashes the
     row, which is quicker than remembering which tab holds it. */

  const INDEX = SECTIONS.flatMap((section) =>
    section.rows.filter((row) => row.name).map((row) => ({
      section,
      name: row.name,
      search: `${section.label} ${row.group || ''} ${row.name} ${row.key || ''}`.toLowerCase()
    })))

  const searchWrap = node('div', 'settings-search')
  const searchField = node('input', 'field settings-search-field')
  searchField.type = 'text'
  searchField.spellcheck = false
  searchField.placeholder = 'Search settings…'
  searchField.setAttribute('aria-label', 'Search settings')
  const suggest = node('div', 'settings-suggest')
  suggest.hidden = true
  searchWrap.append(searchField, suggest)
  el.title.after(searchWrap)

  let picked = 0

  const searchMatches = () => searchField.value.trim()
    ? INDEX.filter((entry) => matcher(searchField.value)(entry.search)).slice(0, 8)
    : []

  function hideSuggest () {
    suggest.hidden = true
    suggest.replaceChildren()
  }

  function clearSearch () {
    searchField.value = ''
    hideSuggest()
  }

  function paintSuggest () {
    const matches = searchMatches()
    if (!matches.length) {
      if (!searchField.value.trim()) { hideSuggest(); return }
      suggest.replaceChildren(node('div', 'settings-search-empty', 'No settings found'))
      suggest.hidden = false
      return
    }
    picked = Math.min(picked, matches.length - 1)
    suggest.replaceChildren(...matches.map((entry, at) => {
      const option = node('button', 'settings-suggest-row')
      option.type = 'button'
      option.classList.toggle('is-picked', at === picked)
      option.append(
        node('span', 'settings-suggest-name', entry.name),
        node('span', 'settings-suggest-section', entry.section.label)
      )
      // Mousedown would blur the field and hide this list before click lands.
      option.addEventListener('mousedown', (event) => event.preventDefault())
      option.addEventListener('click', () => goTo(entry))
      return option
    }))
    suggest.hidden = false
  }

  function goTo (entry) {
    clearSearch()
    active = entry.section.id
    renderRail()
    renderBody()
    /* Found first, scrolled to after: `scrollIntoView` forces a layout, and a
       search that walks the rows measuring as it goes pays for that once per
       row it passes. The answer is one row. */
    const found = [...el.body.querySelectorAll('.settings-row')].find((line) => {
      const name = line.querySelector('.settings-name')
      return name && name.textContent.startsWith(entry.name)
    })
    if (found) {
      found.scrollIntoView({ block: 'center' })
      found.classList.add('is-found')
      setTimeout(() => found.classList.remove('is-found'), 1600)
    }
  }

  searchField.addEventListener('input', () => { picked = 0; paintSuggest() })
  searchField.addEventListener('keydown', (event) => {
    const matches = searchMatches()
    if (suggest.hidden || !matches.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      picked = (picked + 1) % matches.length
      paintSuggest()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      picked = (picked + matches.length - 1) % matches.length
      paintSuggest()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      goTo(matches[picked])
    }
  })
  searchField.addEventListener('blur', () => setTimeout(hideSuggest, 150))

  /* --------------------------------------------------------------- shell */

  /**
   * The real catalogue, read whenever the pane is opened.
   *
   * Opening the pane is the ordinary way it refreshes, and for a while that was
   * the only way — a list that reads itself when you go looking at it seemed
   * never stale enough to be worth a control of its own. It is, for one case:
   * main holds the answer for a few minutes (two CLI subprocesses and most of a
   * megabyte of JSON), so installing a model or signing into a provider and
   * coming straight back here shows the list from before you did. `fresh` asks
   * the CLIs again regardless, which is what the Refresh button sends.
   */
  async function loadModels ({ fresh = false } = {}) {
    /* Taken whole. A provider that answers with nothing keeps its built-in list
       — but `allModels` already applies that rule, so restating it here was a
       second copy of the same decision. */
    modelCatalogue = await api.ai.models({ fresh })
    if (!el.root.hidden) renderBody()
  }

  /* What had the keyboard before Settings took it, so shutting the pane gives
     it back rather than dropping the reader at the top of the document. */
  /** @type {Element | null} */
  let openedFrom = null

  function open (section) {
    section = SECTION_ALIASES[section] || section
    if (section && SECTIONS.some((s) => s.id === section)) active = section
    renderRail()
    renderBody()
    loadModels().catch(() => {})
    Promise.resolve(api.hotkeys?.list()).then((list) => {
      hotkeyCatalogue = Array.isArray(list)
        ? [...list].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }))
        : []
      if (!el.root.hidden) renderBody()
    }).catch(() => {})
    if (!spellInstalled) {
      Promise.resolve(api.spell?.installed?.()).then((list) => {
        if (!Array.isArray(list)) return
        spellInstalled = list
        if (!el.root.hidden) renderBody()
      }).catch(() => {})
    }
    openedFrom = document.activeElement
    el.root.hidden = false
    // Dragged on an earlier open: keep that spot, pulled back into a window
    // that may have shrunk since.
    if (placed) place(placed.x, placed.y)
    /* The section rail, not the close button. Opening a pane already focused
       on the way out of it means the first thing Tab offers is leaving, and a
       reader arriving by keyboard has to walk past the exit to reach the
       settings they came for. */
    const first = el.rail.querySelector('[aria-current="true"]') || el.rail.querySelector('button')
    ;(first || el.close).focus()
  }

  function close () {
    clearSearch()
    el.root.hidden = true
    if (document.body.classList.contains('settings-window')) window.close()
    const back = openedFrom
    openedFrom = null
    if (back?.isConnected) /** @type {HTMLElement} */ (back).focus()
  }

  el.close.addEventListener('click', close)

  /* ------------------------------------------------------- the popup */

  /* The pane is a popup, not a modal: the app behind stays usable, clicking
     into it does not close anything, and the box can be dragged aside by its
     header to uncover whatever it is sitting on. The position is inline style
     on the box, so it survives close and reopen for the life of the window —
     re-clamped on open in case the window shrank in the meantime. */
  const box = el.root.querySelector('.settings-box')
  const head = el.root.querySelector('.settings-head')
  /** @type {{x: number, y: number} | null} */
  let placed = null

  function place (x, y) {
    const pad = 8
    const width = box.offsetWidth
    x = Math.max(pad, Math.min(x, window.innerWidth - width - pad))
    y = Math.max(pad, Math.min(y, window.innerHeight - 64))
    placed = { x, y }
    box.style.position = 'fixed'
    box.style.left = `${x}px`
    box.style.top = `${y}px`
  }

  head?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || document.body.classList.contains('settings-window')) return
    // The close button and the search field live here too, and a drag must
    // not begin on either of them.
    if (event.target.closest('button, input, select, textarea')) return
    const rect = box.getBoundingClientRect()
    const grabX = event.clientX - rect.left
    const grabY = event.clientY - rect.top
    const move = (ev) => place(ev.clientX - grabX, ev.clientY - grabY)
    const drop = () => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', drop)
      head.removeEventListener('pointercancel', drop)
    }
    head.setPointerCapture(event.pointerId)
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', drop)
    head.addEventListener('pointercancel', drop)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || el.root.hidden) return
    /* A popup, not a modal — but Escape still means "put Settings away" from
       anywhere that is not itself spending the key. Inside the pane it always
       closes; so does pressing it with nothing in particular focused, which is
       where a click on the pane's own background leaves the keyboard. Only a
       focused editor or field outside the pane keeps its own Escape. */
    const inPane = el.root.contains(event.target)
    const idle = event.target === document.body || event.target === document.documentElement
    if (!inPane && !idle) return
    event.stopPropagation()
    // Nearest thing first: the dictionary dialog, then a search in progress,
    // and only with both out of the way the pane itself.
    if (dictDialog?.open) { dictDialog.close(); return }
    if (searchField.value || !suggest.hidden) { clearSearch(); return }
    close()
  }, true)

  return { open, close, isOpen: () => !el.root.hidden }
}
