/* ============================================================= settings
   A rail of sections on the left, flat rows on the right — the shape people
   already know from Obsidian, and the shape that keeps a growing list of
   preferences from turning into a wall of controls.

   Nothing here decides what a setting *means*. Every row states its key and
   its control, and hands the new value to `onChange`; the renderer is what
   applies it and writes it down. That is what stops this file from acquiring a
   second, quietly different, idea of the app's state.
   ================================================================== */

import { el as node } from './dom.js'
import { NO_MATCH, dropdown, matcher } from './dropdown.js'
import { THEMES } from './themes.js'

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
  allModels, asOptions, defaultEnabled, modelFromConfig, providerLabel
} from './models.js'

const SECTIONS = [
  /* What the window looks like, and nothing else. Everything that used to sit
     here — how wide a line runs, whether the outline shows — turned out to be a
     question about reading a note rather than about the app, and notes have a
     tab of their own now. */
  {
    id: 'appearance',
    label: 'Appearance',
    rows: [
      { key: 'theme', type: 'themes', name: 'Theme' },
      {
        key: 'zoom',
        type: 'zoom',
        // "Default", because this is the size Tulip opens at: ⌘+ and ⌘− move
        // the window you are in, and this is where they come back to.
        name: 'Default zoom'
      }
    ]
  },
  /* One tab per kind of document, because that is how the questions arrive:
     what you want of a note is not what you want of a paper you are reading or
     a paper you are writing. Manim sat in a tab of its own for want of anywhere
     better; it is a thing markdown does, and this is where markdown lives —
     along with everything else that is true of a note and of nothing else. */
  {
    id: 'markdown',
    label: 'Markdown',
    rows: [
      {
        key: 'readableWidth',
        type: 'toggle',
        name: 'Readable line length',
        fallback: true
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
        fallback: 'normal'
      },
      {
        key: 'centerHeadings',
        type: 'toggle',
        name: 'Center headings',
        fallback: false
      },
      {
        key: 'spellcheck',
        type: 'toggle',
        name: 'Check spelling',
        fallback: true
      },
      /* The checker's exceptions, not a setting of the app's own — the list
         lives with the spellchecker, and this row only reads and prunes it.
         Hence key-less: nothing here goes through the config. */
      {
        key: '',
        type: 'dictionary',
        name: 'Dictionary'
      },
      {
        key: 'outline',
        type: 'toggle',
        name: 'Show the outline',
        fallback: false
      },
      {
        key: 'codeNumbers',
        type: 'toggle',
        name: 'Number code lines',
        fallback: true
      },
      {
        key: 'codeWrap',
        type: 'toggle',
        name: 'Wrap long code lines',
        fallback: false
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
        fallback: 'm'
      }
    ]
  },
  {
    id: 'pdf',
    label: 'PDF',
    rows: [
      {
        key: 'pdfText',
        type: 'toggle',
        name: 'Read PDFs out for the copilot',
        fallback: true
      }
    ]
  },
  {
    id: 'tex',
    label: 'TeX',
    rows: [
      {
        key: 'texEngine',
        type: 'select',
        name: 'Compile with',
        options: [
          { value: 'pdflatex', label: 'pdfLaTeX' },
          { value: 'xelatex', label: 'XeLaTeX' },
          { value: 'lualatex', label: 'LuaLaTeX' }
        ],
        fallback: 'pdflatex'
      }
    ]
  },
  /* Four settings, and every one of them is a decision the scheduler cannot
     make for you: how much new material you have appetite for, how much
     forgetting you are willing to trade for fewer reviews, and whether you want
     to type and hear the words or only look at them. Everything else about the
     schedule — when each card comes back — is arithmetic, and arithmetic does
     not get a control. */
  {
    id: 'study',
    label: 'Study',
    rows: [
      {
        key: 'studyNewPerDay',
        type: 'number',
        name: 'New words a day',
        placeholder: '8',
        min: 1,
        max: 200
      },
      {
        key: 'studyRetention',
        type: 'select',
        name: 'Aim to remember',
        options: [
          { value: 0.85, label: '85% — fewer reviews' },
          { value: 0.9, label: '90% — the usual balance' },
          { value: 0.95, label: '95% — forget less, review more' }
        ],
        fallback: 0.9,
        cast: Number
      },
      {
        key: 'studySpeaking',
        type: 'toggle',
        name: 'Speak the words',
        fallback: true
      }
    ]
  },
  {
    id: 'copilot',
    label: 'Copilot',
    rows: [
      {
        key: 'aiModel',
        type: 'models',
        name: 'Default model'
      },
      {
        key: 'aiModels',
        type: 'catalogue',
        name: 'Models offered',
        /* Beside the name rather than in the list: it undoes the whole list, and a
           control that clears three hundred ticks does not belong among them. */
        action: { id: 'clear-models', label: 'Reset', title: 'Tick nothing — offer no models of your own' }
      },
      {
        key: '',
        type: 'doctor',
        name: 'Copilot Doctor'
      },
      /* Permission mode and effort live on the composer instead — both are
         per-turn decisions, and the popover beside the message box is where you
         are when you make them. The settings themselves (`aiEffort`, `aiMode`)
         are still persisted; this is only about where the control
         for them sits. Effort had the additional problem of being a property of
         the model rather than of the app — the stops are whatever the chosen
         model publishes — so a copy of it here could offer a level the model in
         the panel does not take. */
    ]
  }
  /* There is no Vault section, and no "default vault" setting behind it. The
     vault Tulip has open *is* the one it reopens; connecting another — from
     the landing page, the vault's name in the sidebar, or ⇧⌘O — is the whole
     of changing it. A pane offering a second, separately-configured folder
     only ever raised the question of which of the two you were looking at. */
]

/**
 * @param el        the shell from index.html
 * @param api       window.tulip
 * @param values    () => the current config object
 * @param onChange  (key, value) => void — persist it and put it into effect
 */
export function mountSettings ({ el, api, values, onChange }) {
  let active = SECTIONS[0].id
  let modelCatalogue = DEFAULT_CATALOGUE
  let doctorState = null

  /* ------------------------------------------------------------ controls */

  /** The stored value for a row, or what the app behaves as when unset. */
  function valueOf (row) {
    const raw = values()[row.key]
    if (raw === undefined || raw === null || raw === '') {
      return row.fallback !== undefined ? row.fallback : ''
    }
    return row.cast ? row.cast(raw) : raw
  }

  function change (row, value) {
    onChange(row.key, value)
    // Rows can depend on each other — the zoom stepper reads back what the
    // main process settled on — so the pane is redrawn rather than patched.
    renderBody()
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
      if (!words.length) {
        list.replaceChildren(node('span', 'settings-hint',
          'Nothing yet. Right-click an underlined word and choose “Add to Dictionary”, or type one above.'))
        return
      }
      const hit = matcher(input.value)
      const shown = words.filter((word) => hit(word))
      if (!shown.length) {
        list.replaceChildren(node('span', 'settings-hint',
          'No word like that yet — Add puts it in.'))
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
    doctor () {
      const wrap = node('div', 'ai-doctor')
      const results = node('div', 'ai-doctor-results')
      const run = node('button', 'model-refresh', doctorState ? 'Run again' : 'Run checks')
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
      } else results.append(node('span', 'settings-hint', 'Run a local readiness check.'))

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

    toggle (row) {
      const on = valueOf(row) !== false
      const button = node('button', 'switch')
      button.type = 'button'
      button.setAttribute('role', 'switch')
      button.setAttribute('aria-checked', String(on))
      button.append(node('span', 'switch-thumb'))
      button.addEventListener('click', () => change(row, !on))
      return button
    },

    segment (row) {
      const current = valueOf(row)
      const group = node('div', 'seg')
      group.setAttribute('role', 'radiogroup')
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

    /**
     * The default model, chosen from the whole catalogue.
     *
     * Deliberately not limited to the list below it: picking a model here is
     * how you say "this is the one", and having to go and tick it first before
     * you were allowed to would be a rule with nothing behind it. One picked
     * here is offered in the panel whether it is ticked or not — see
     * `offeredModels`, which always keeps room for the current choice.
     */
    models (row) {
      const chosen = modelFromConfig(values())
      return dropdown({
        label: 'Default model',
        className: 'is-wide',
        // Several hundred entries: typing is the only sane way through them.
        search: true,
        options: asOptions(allModels(modelCatalogue)),
        value: chosen,
        placeholder: 'No model selected',
        onChange: (key) => change(row, key)
      }).root
    },

    /**
     * Every model the CLI will admit to, ticked or not.
     *
     * One row per copilot, and its models inside it. opencode answers with
     * several hundred, so what the pane shows at rest is the copilot itself —
     * the question anyone opening it is actually asking — and the models are a
     * fold away. Search opens whichever copilots match.
     *
     * A model's own shelf (`anthropic`, `Claude Opus 5`) is not a row of its
     * own any more: it rides each model as a quiet qualifier, because `glm-5.2`
     * alone says nothing about whose subscription is paying for it.
     *
     * Ticking writes straight through rather than going by way of `change`,
     * which redraws the pane and would lose the search and scroll position.
     */
    catalogue (row) {
      const all = allModels(modelCatalogue)
      const stored = values()[row.key]
      /* An empty list and no list are different answers. Nothing saved is
         someone who has never been here, and they are shown the defaults
         ticked; an empty list is someone who cleared it, and clearing it has to
         survive the pane being closed and opened again. */
      const chosen = new Set(Array.isArray(stored) ? stored : defaultEnabled(modelCatalogue))
      let query = ''
      // Explicit choices last only for this visit to the pane. A fresh pane
      // gets a fresh map, so every provider begins folded again.
      const opened = new Map()

      /* Grouped once, by the CLI that offers them — `allModels` already emits
         them in provider order, so this keeps the catalogue's own order. Who
         offers what is a property of the catalogue, not of what is typed, so
         only the membership of each is recomputed per keystroke; each model
         already carries the lowercased text it is searched by. */
      const groups = []
      const byName = new Map()
      for (const model of all) {
        let group = byName.get(model.provider)
        if (!group) {
          group = { name: providerLabel(model.provider), models: [] }
          byName.set(model.provider, group)
          groups.push(group)
        }
        group.models.push(model)
      }

      const wrap = node('div', 'model-picker')

      /**
       * Everything ticked, in one place.
       *
       * The list below runs to several hundred models and is closed by default.
       * These chips keep every chosen model visible without opening each
       * copilot, and clicking one removes it from the offered list.
       */
      const picked = node('div', 'model-picked')

      const head = node('div', 'model-picker-head')
      const search = node('input', 'field model-search')
      search.type = 'search'
      search.spellcheck = false
      search.placeholder = `Search ${all.length} models…`

      /* Asking the CLIs again. The catalogue is read when the pane opens, but
         main holds its answer for a few minutes, and the moment you want this
         is the moment you have just installed something. */
      const again = node('button', 'model-refresh')
      again.type = 'button'
      again.title = 'Ask the CLIs for their models again'
      again.append(node('span', 'model-refresh-label', 'Refresh'))
      again.addEventListener('click', () => {
        if (again.disabled) return
        again.disabled = true
        again.querySelector('.model-refresh-label').textContent = 'Refreshing…'
        /* `loadModels` redraws the pane, which builds this row again from the
           new catalogue — so there is nothing to put back on success. A failure
           leaves the old list, and says so where the button was. */
        loadModels({ fresh: true }).catch(() => {
          again.disabled = false
          again.querySelector('.model-refresh-label').textContent = 'Not reachable'
        })
      })

      head.append(search, again)

      const list = node('div', 'model-picker-list')
      wrap.append(picked, head, list)

      function paintPicked () {
        const on = all.filter((model) => chosen.has(model.key))
        // Nothing ticked, nothing said: the strip disappears rather than
        // explaining itself.
        picked.hidden = !on.length
        if (!on.length) { picked.replaceChildren(); return }
        picked.replaceChildren(...on.map((model) => {
          const chip = node('button', 'model-chip')
          chip.type = 'button'
          chip.title = `Stop offering ${model.label}`
          /* Named by its copilot rather than by its shelf: which of the five is
             answering is the thing a chip has to say, and the shelf is in the
             tooltip for the models whose name alone is ambiguous. */
          chip.append(
            node('span', 'model-chip-group', providerLabel(model.provider)),
            node('span', 'model-chip-name', model.label),
            node('span', 'model-chip-x', '×')
          )
          chip.addEventListener('click', () => {
            chosen.delete(model.key)
            persist()
            // The row for it in the list below may be on screen and ticked, so
            // this one does repaint — unticking from here is a deliberate act,
            // not the per-model ticking the list's fast path exists for.
            paint()
          })
          return chip
        }))
      }

      /* Written down without redrawing. Ticking one model used to rebuild every
         row in the list — four hundred-odd buttons — to change one checkbox. */
      const persist = () =>
        onChange(row.key, all.filter((model) => chosen.has(model.key)).map((m) => m.key))

      function paint () {
        const hit = matcher(query)
        const shown = groups
          .map((group) => ({ ...group, models: group.models.filter((m) => hit(m.search)) }))
          .filter((group) => group.models.length)
        list.replaceChildren(...shown.map((group) => {
          const of = group.models.length
          let ticked = group.models.filter((model) => chosen.has(model.key)).length
          // A newly opened settings pane starts with every copilot folded.
          // Search results open automatically; otherwise only an explicit
          // click changes a copilot's state for the lifetime of this pane.
          const open = opened.has(group.name)
            ? opened.get(group.name)
            : !!query

          const box = node('div', 'model-group')
          box.classList.toggle('is-open', open)

          const bar = node('button', 'model-group-head')
          bar.type = 'button'
          bar.setAttribute('aria-expanded', String(open))
          const counter = node('span', 'model-group-count', `${ticked}/${of}`)
          // One button for the whole copilot, because ticking three hundred
          // opencode models one at a time is not a feature.
          const every = node('button', 'model-group-all')
          every.type = 'button'

          const refresh = () => {
            ticked = group.models.filter((model) => chosen.has(model.key)).length
            counter.textContent = `${ticked}/${of}`
            every.textContent = ticked === of ? 'None' : 'All'
            every.title = ticked === of
              ? 'Take all of these out of the list'
              : 'Put all of these in the list'
          }
          refresh()

          bar.append(node('span', 'model-group-caret'), node('span', 'model-group-name', group.name), counter)
          bar.addEventListener('click', () => { opened.set(group.name, !open); paint() })

          every.addEventListener('click', (event) => {
            event.stopPropagation()
            const add = ticked !== of
            for (const model of group.models) {
              if (add) chosen.add(model.key)
              else chosen.delete(model.key)
            }
            opened.set(group.name, true)
            persist()
            // A whole group at once does change every row, so this one repaints.
            paint()
          })
          bar.append(every)
          box.append(bar)

          if (open) {
            const body = node('div', 'model-group-body')

            /* The fold, grouped by shelf — opencode's own sub-providers. The
               shelf used to ride each row as a badge, which put
               `opencode-go` four hundred times down the right edge and said
               nothing about where one shelf ended; a heading says it once, and
               gives each shelf an All of its own. First-appearance order, so a
               catalogue whose shelves arrive scattered is still collected. */
            const shelves = new Map()
            for (const model of group.models) {
              const name = model.group || group.name
              if (!shelves.has(name)) shelves.set(name, [])
              shelves.get(name).push(model)
            }

            for (const [shelfName, models] of shelves) {
              const section = node('div', 'model-shelf')
              // One shelf that is just the copilot's own name is no grouping
              // at all, and a heading for it would repeat the bar above.
              const titled = shelves.size > 1 || shelfName !== group.name
              let syncShelf = () => {}

              if (titled) {
                const shelfHead = node('div', 'model-shelf-head')
                const count = node('span', 'model-shelf-count')
                const every = node('button', 'model-group-all')
                every.type = 'button'
                syncShelf = () => {
                  const on = models.filter((m) => chosen.has(m.key)).length
                  count.textContent = `${on}/${models.length}`
                  every.textContent = on === models.length ? 'None' : 'All'
                  every.title = on === models.length
                    ? `Take all of ${shelfName} out of the list`
                    : `Put all of ${shelfName} in the list`
                }
                syncShelf()
                every.addEventListener('click', () => {
                  const add = models.some((m) => !chosen.has(m.key))
                  for (const m of models) {
                    if (add) chosen.add(m.key)
                    else chosen.delete(m.key)
                  }
                  persist()
                  // A whole shelf at once changes every one of its rows.
                  paint()
                })
                shelfHead.append(node('span', 'model-shelf-name', shelfName), count, every)
                section.append(shelfHead)
              }

              const grid = node('div', 'model-shelf-grid')
              for (const model of models) {
                const option = node('button', 'model-option')
                option.type = 'button'
                option.setAttribute('role', 'checkbox')
                /* Under its own heading the shelf's name is already said, so a
                   model named after it keeps only what is its own — "High"
                   under "Claude Opus 5", not the heading over again. */
                const name = titled && model.label !== shelfName && model.label.startsWith(`${shelfName} `)
                  ? model.label.slice(shelfName.length + 1)
                  : model.label
                option.append(node('span', 'model-tick'), node('span', 'model-name', name))
                const mark = (on) => {
                  option.setAttribute('aria-checked', String(on))
                  option.classList.toggle('is-on', on)
                }
                mark(chosen.has(model.key))
                option.addEventListener('click', () => {
                  const on = !chosen.has(model.key)
                  if (on) chosen.add(model.key)
                  else chosen.delete(model.key)
                  mark(on)
                  refresh()
                  syncShelf()
                  // The strip at the top is the one other thing on screen that
                  // has just gone out of date; the rows below have not.
                  paintPicked()
                  persist()
                })
                grid.append(option)
              }
              section.append(grid)
              body.append(section)
            }
            box.append(body)
          }
          return box
        }))

        if (!shown.length) list.append(node('div', 'model-picker-empty', NO_MATCH))
        paintPicked()
      }

      search.addEventListener('input', () => {
        query = search.value
        // A new search decides for itself which groups to open.
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
      const commit = () => {
        const n = Number(input.value)
        change(row, input.value.trim() && n > 0 ? n : '')
      }
      input.addEventListener('change', commit)
      input.addEventListener('blur', commit)
      wrap.append(input)
      if (row.suffix) wrap.append(node('span', 'field-suffix', row.suffix))
      return wrap
    },

    text (row) {
      const input = node('input', 'field')
      input.type = 'text'
      input.spellcheck = false
      input.placeholder = row.placeholder || ''
      input.value = values()[row.key] ?? ''
      input.addEventListener('change', () => change(row, input.value.trim()))
      return input
    },

    themes () {
      const current = values().theme || 'light'
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

  /** What a row's own button does, by the name the row calls it. Here rather
   *  than on the row itself, which is a description of the pane and has no way
   *  to reach the config. */
  const ROW_ACTIONS = {
    // Every tick off, and it stays off: the pane reads an empty list as a
    // choice, not as an absence, so this is not undone the next time it opens.
    'clear-models': () => { onChange('aiModels', []); renderBody() }
  }

  function renderRail () {
    el.rail.replaceChildren()
    for (const section of SECTIONS) {
      const button = node('button', 'settings-tab', section.label)
      button.type = 'button'
      button.setAttribute('aria-current', String(section.id === active))
      button.addEventListener('click', () => { active = section.id; renderRail(); renderBody() })
      el.rail.append(button)
    }
  }

  function renderBody () {
    const section = SECTIONS.find((s) => s.id === active) || SECTIONS[0]
    el.title.textContent = section.label
    el.body.replaceChildren()

    for (const row of section.rows) {
      const line = node('div', 'settings-row')
      const label = node('div', 'settings-label')
      const name = node('div', 'settings-name', row.name)
      if (row.action) {
        const act = node('button', 'settings-action', row.action.label)
        act.type = 'button'
        act.title = row.action.title || ''
        act.addEventListener('click', () => ROW_ACTIONS[row.action.id]?.())
        name.append(act)
      }
      label.append(name)
      line.append(label)

      const control = CONTROLS[row.type]?.(row)
      if (control) {
        const holder = node('div', 'settings-control')
        holder.append(control)
        line.append(holder)
      }

      // A full-width control reads better under its label than squeezed
      // beside it — the theme grid and the model list are both of those.
      if (row.type === 'themes' || row.type === 'catalogue' || row.type === 'doctor') line.classList.add('is-stacked')
      el.body.append(line)
    }
  }

  /* -------------------------------------------------------------- search
     One field over the whole pane, between the section's title and the close
     button. Typing suggests every row it matches — by its own name or its
     section's — and choosing one switches to that section and flashes the
     row, which is quicker than remembering which of six tabs holds it. */

  const INDEX = SECTIONS.flatMap((section) =>
    section.rows.filter((row) => row.name).map((row) => ({
      section,
      name: row.name,
      search: `${section.label} ${row.name}`.toLowerCase()
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
    if (!matches.length) { hideSuggest(); return }
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
    for (const line of el.body.querySelectorAll('.settings-row')) {
      const name = line.querySelector('.settings-name')
      if (!name || !name.textContent.startsWith(entry.name)) continue
      line.scrollIntoView({ block: 'center' })
      line.classList.add('is-found')
      setTimeout(() => line.classList.remove('is-found'), 1600)
      break
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
  let openedFrom = null

  function open (section) {
    if (section && SECTIONS.some((s) => s.id === section)) active = section
    renderRail()
    renderBody()
    loadModels().catch(() => {})
    openedFrom = document.activeElement
    el.root.hidden = false
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
    const back = openedFrom
    openedFrom = null
    if (back?.isConnected) back.focus()
  }

  el.close.addEventListener('click', close)
  el.root.addEventListener('mousedown', (event) => {
    if (event.target === el.root) close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || el.root.hidden) return
    event.stopPropagation()
    // Nearest thing first: the dictionary dialog, then a search in progress,
    // and only with both out of the way the pane itself.
    if (dictDialog?.open) { dictDialog.close(); return }
    if (searchField.value || !suggest.hidden) { clearSearch(); return }
    close()
  }, true)

  return { open, close, isOpen: () => !el.root.hidden }
}
