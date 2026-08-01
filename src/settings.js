/* ============================================================= settings
   A rail of sections on the left, flat rows on the right — the shape people
   already know from Obsidian, and the shape that keeps a growing list of
   preferences from turning into a wall of controls.

   Nothing here decides what a setting *means*. Every row states its key and
   its control, and hands the new value to `onChange`; the renderer is what
   applies it and writes it down. That is what stops this file from acquiring a
   second, quietly different, idea of the app's state.
   ================================================================== */

import { el as node } from './blocks.js'
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
  allModels, asOptions, defaultEnabled, effortLabel, effortsFor,
  modelFromConfig, nearestEffort
} from './models.js'

const SECTIONS = [
  {
    id: 'appearance',
    label: 'Appearance',
    rows: [
      { key: 'theme', type: 'themes', name: 'Theme' },
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
      { key: 'zoom', type: 'zoom', name: 'Zoom' }
    ]
  },
  {
    id: 'editor',
    label: 'Editor',
    rows: [
      {
        key: 'autosave',
        type: 'select',
        name: 'Autosave after',
        options: [
          { value: 300, label: '0.3 seconds' },
          { value: 600, label: '0.6 seconds' },
          { value: 1200, label: '1.2 seconds' },
          { value: 2500, label: '2.5 seconds' }
        ],
        fallback: 600,
        cast: Number
      },
      {
        key: 'durability',
        type: 'select',
        name: 'Save durability',
        options: [
          { value: 'full', label: 'Full — safest' },
          { value: 'balanced', label: 'Balanced — faster' }
        ],
        fallback: 'balanced'
      },
      {
        key: 'spellcheck',
        type: 'toggle',
        name: 'Check spelling',
        fallback: true
      },
      {
        key: 'codeNumbers',
        type: 'toggle',
        name: 'Number code lines',
        fallback: true
      },
      {
        key: 'outline',
        type: 'toggle',
        name: 'Show the outline',
        fallback: false
      }
    ]
  },
  {
    id: 'code',
    label: 'Running code',
    rows: [
      {
        key: 'runTimeout',
        type: 'number',
        name: 'Run timeout',
        suffix: 'seconds',
        placeholder: '10',
        min: 1,
        max: 3600
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
      },
      {
        key: 'manimTimeout',
        type: 'number',
        name: 'Manim timeout',
        suffix: 'seconds',
        placeholder: '300',
        min: 1,
        max: 3600
      },
      {
        key: 'manimCommand',
        type: 'text',
        name: 'Manim command',
        placeholder: 'manim'
      },
      {
        key: 'tikzTimeout',
        type: 'number',
        name: 'TikZ timeout',
        suffix: 'seconds',
        placeholder: '90',
        min: 1,
        max: 3600
      },
      {
        key: 'tikzCommand',
        type: 'text',
        name: 'TeX command',
        placeholder: 'latex'
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
        name: 'Models offered'
      },
      {
        key: 'aiEffort',
        type: 'effort',
        name: 'Effort',
        fallback: 'high'
      }
      /* "May edit notes" lives on the composer instead — it is a per-turn
         decision, and the pencil beside the message box is where you are when
         you make it. The setting itself (`aiWrite`) is unchanged. */
    ]
  },
  {
    id: 'vault',
    label: 'Vault',
    rows: [
      { key: '', type: 'vault', name: 'Default vault' }
    ]
  }
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

  /** The model everything in the Copilot section is relative to. */
  const chosenModel = () => {
    const key = modelFromConfig(values())
    return allModels(modelCatalogue).find((model) => model.key === key)
  }

  const CONTROLS = {
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

    /**
     * The same segmented control, with the stops the chosen model takes.
     *
     * Claude states five levels for everything it runs, Codex publishes a
     * different set per model — as far as `ultra` — and most of opencode's have
     * none at all, which leaves nothing here to say. A fixed four would offer
     * levels the CLI rejects and hide ones it accepts.
     */
    effort (row) {
      const model = chosenModel()
      const levels = effortsFor(model)
      if (!levels.length) return node('span', 'settings-none', 'This model has no effort setting.')
      return CONTROLS.segment({
        ...row,
        // A level stored against a model that has since changed is shown as the
        // nearest this one takes — the same rule the panel settles by.
        cast: (level) => nearestEffort(model, level),
        options: levels.map((level) => ({ value: level, label: effortLabel(level) }))
      })
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
        onChange: (key) => change(row, key)
      }).root
    },

    /**
     * Every model the three CLIs will admit to, ticked or not.
     *
     * opencode answers with four hundred-odd across a dozen of its own
     * providers, so the list is grouped and searchable rather than flat, and
     * each group opens only when it is worth opening — one it has a choice in,
     * or one the search has just found something in. Ticking writes straight
     * through rather than going by way of `change`, which redraws the pane and
     * would take the search box and the scroll position with it.
     */
    catalogue (row) {
      const all = allModels(modelCatalogue)
      const stored = values()[row.key]
      const chosen = new Set(stored?.length ? stored : defaultEnabled(modelCatalogue))
      let query = ''
      // Which groups are open, once the user has said so — before that the
      // rule below decides, which is what makes a fresh search useful.
      const opened = new Map()

      /* Grouped once. The shelves are a property of the catalogue, not of what
         is typed, so only their membership is recomputed per keystroke — and
         each model already carries the lowercased text it is searched by. */
      const groups = []
      const byName = new Map()
      for (const model of all) {
        let group = byName.get(model.group)
        if (!group) {
          group = { name: model.group, models: [] }
          byName.set(model.group, group)
          groups.push(group)
        }
        group.models.push(model)
      }

      const wrap = node('div', 'model-picker')
      const head = node('div', 'model-picker-head')
      const search = node('input', 'field model-search')
      search.type = 'search'
      search.spellcheck = false
      search.placeholder = `Search ${all.length} models…`
      const count = node('span', 'model-picker-count')
      head.append(search, count)

      const list = node('div', 'model-picker-list')
      wrap.append(head, list)

      const tally = () => { count.textContent = `${chosen.size} of ${all.length} offered` }

      /* Written down without redrawing. Ticking one model used to rebuild every
         row in the list — four hundred-odd buttons — to change one checkbox. */
      const persist = () =>
        onChange(row.key, all.filter((model) => chosen.has(model.key)).map((m) => m.key))

      function paint () {
        const hit = matcher(query)
        const shown = groups
          .map((group) => ({ ...group, models: group.models.filter((m) => hit(m.search)) }))
          .filter((group) => group.models.length)
        tally()

        list.replaceChildren(...shown.map((group) => {
          const of = group.models.length
          let ticked = group.models.filter((model) => chosen.has(model.key)).length
          // Open when the user says so; otherwise when there is something to
          // see — a search hit, or a group they have already chosen from.
          const open = opened.has(group.name)
            ? opened.get(group.name)
            : (!!query || ticked > 0)

          const box = node('div', 'model-group')
          box.classList.toggle('is-open', open)

          const bar = node('button', 'model-group-head')
          bar.type = 'button'
          bar.setAttribute('aria-expanded', String(open))
          const counter = node('span', 'model-group-count', `${ticked}/${of}`)
          // One button for the whole group, because ticking three hundred
          // OpenRouter models one at a time is not a feature.
          const every = node('button', 'model-group-all')
          every.type = 'button'

          const refresh = () => {
            ticked = group.models.filter((model) => chosen.has(model.key)).length
            counter.textContent = `${ticked}/${of}`
            every.textContent = ticked === of ? 'None' : 'All'
            every.title = ticked === of
              ? 'Take all of these out of the list'
              : 'Put all of these in the list'
            tally()
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
            for (const model of group.models) {
              const option = node('button', 'model-option')
              option.type = 'button'
              option.setAttribute('role', 'checkbox')
              option.append(node('span', 'model-tick'), node('span', 'model-name', model.label))
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
                persist()
              })
              body.append(option)
            }
            box.append(body)
          }
          return box
        }))

        if (!shown.length) list.append(node('div', 'model-picker-empty', NO_MATCH))
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
      const current = values().theme || 'system'
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
    },

    vault () {
      const wrap = node('div', 'stepper')
      const button = node('button', '', 'Choose default vault…')
      button.type = 'button'
      button.addEventListener('click', () => { api.vault.pick(); close() })
      wrap.append(button)
      return wrap
    }
  }

  /* -------------------------------------------------------------- render */

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
      label.append(node('div', 'settings-name', row.name))
      line.append(label)

      const control = CONTROLS[row.type]?.(row)
      if (control) {
        const holder = node('div', 'settings-control')
        holder.append(control)
        line.append(holder)
      }

      // A full-width control reads better under its label than squeezed
      // beside it — the theme grid and the model list are both of those.
      if (row.type === 'themes' || row.type === 'catalogue') line.classList.add('is-stacked')
      el.body.append(line)
    }

    if (section.id === 'vault') {
      const path = values().defaultVaultPath || values().vaultPath || ''
      el.body.append(node(
        'div',
        'settings-note',
        path || 'Choose a vault and Tulip will open it automatically next time.'
      ))
    }
  }

  /* --------------------------------------------------------------- shell */

  /**
   * The real catalogue, read whenever the pane is opened. It replaced a
   * refresh button beside the select: a list that reads itself when you go
   * looking at it is never stale enough to be worth a control of its own.
   */
  async function loadModels () {
    /* Taken whole. A provider that answers with nothing keeps its built-in list
       — but `allModels` already applies that rule, so restating it here was a
       second copy of the same decision. */
    modelCatalogue = await api.ai.models()
    if (!el.root.hidden) renderBody()
  }

  function open (section) {
    if (section && SECTIONS.some((s) => s.id === section)) active = section
    renderRail()
    renderBody()
    loadModels().catch(() => {})
    el.root.hidden = false
    el.close.focus()
  }

  function close () {
    el.root.hidden = true
  }

  el.close.addEventListener('click', close)
  el.root.addEventListener('mousedown', (event) => {
    if (event.target === el.root) close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.root.hidden) { event.stopPropagation(); close() }
  }, true)

  return { open, close, isOpen: () => !el.root.hidden }
}
