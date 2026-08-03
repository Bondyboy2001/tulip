/* =============================================================== models
   One list of models, drawn from three CLIs.

   The panel used to ask two questions — which copilot, then which of its
   models — which is one question too many: nobody picks Codex and then wonders
   what Codex has. So a model is named by the pair, `provider:id`, and choosing
   one chooses both. `claude:opus`, `codex:gpt-5.6-sol`,
   `opencode:opencode-go/glm-5.2`.

   The pair also has to survive opencode's ids, which are themselves
   `provider/model` and contain a slash — hence a colon here, and a split on the
   first one only.

   Which models are *offered* is a setting, because opencode alone answers with
   four hundred of them and a dropdown that long is not a choice. The catalogue
   is everything the CLIs will admit to; the enabled list is what the user wants
   to see. This file owns both, so copilot.js and settings.js cannot drift.

   Effort is not one scale, and that is the other thing this file owns. Claude
   states five levels and applies them to everything it runs; Codex publishes a
   different set per model, as far as `ultra`; and most of opencode's catalogue
   has no such dial at all. So the levels are data on the model, read from the
   CLI that offers it, and every control asks the model rather than knowing any
   levels of its own.
   ================================================================== */

/* The three CLIs and what they offer before they are asked, shared with the
   main process — which spawns them — so that "what Claude has" is one fact in
   one file rather than two that can disagree. Same arrangement as
   zoom-steps.json and vault-contract.json. */
import CATALOGUE from '../electron/ai-models.json'

/** In the order they are shown. `label` names the CLI; `id` is what the main
 *  process spawns. */
const PROVIDERS = CATALOGUE.providers

const PROVIDER = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]))

/* What is offered before the CLIs have been asked, and the reason the first
   paint is never empty. */
export const DEFAULT_CATALOGUE = CATALOGUE.fallbacks

/* Ticked for someone who has never opened the settings pane. opencode is the
   one that is not: its four hundred entries are exactly what the setting exists
   to keep out of the dropdown. */
const offerByDefault = (provider) => !!PROVIDER[provider]?.offerByDefault

export const DEFAULT_MODEL = keyOf('claude', PROVIDER.claude.default)

function keyOf (provider, id) { return `${provider}:${id}` }

/** The first colon and no other: an opencode id may hold slashes, dots and
 *  dashes, but the provider before the colon never does. */
export function splitKey (key) {
  const cut = String(key || '').indexOf(':')
  if (cut === -1) return { provider: '', id: '' }
  return { provider: key.slice(0, cut), id: key.slice(cut + 1) }
}

/**
 * Every model of every provider, in provider order, as flat rows.
 *
 * Memoised on the catalogue object, which both callers replace wholesale rather
 * than mutate — so its identity is a sound key. Without it this rebuilt four
 * hundred-odd objects several times per repaint: `paintConfig` alone called it
 * twice, and one model change ran it half a dozen times.
 */
const flattened = new WeakMap()

export function allModels (catalogue) {
  const source = catalogue || DEFAULT_CATALOGUE
  const had = flattened.get(source)
  if (had) return had

  const out = []
  for (const { id: provider, label: providerLabel } of PROVIDERS) {
    const list = source[provider]?.length ? source[provider] : DEFAULT_CATALOGUE[provider]
    for (const model of list || []) {
      out.push({
        key: keyOf(provider, model.id),
        provider,
        id: model.id,
        // What it is called on its own — the composer's chip has room for this
        // and nothing more.
        label: model.label || model.id,
        /* Who is answering, which is also the shelf it sits on in the settings
           list. opencode's own sub-providers are the useful grouping there —
           `glm-5.2` says nothing about whether it is coming from the user's
           opencode subscription or their own OpenRouter key — and the other two
           group by CLI. */
        group: model.group || providerLabel,
        /* How much this model can hold, for drawing how much of it a
           conversation has spent. Codex and opencode each publish their own;
           zero means nobody said, and the ring stays away. */
        context: model.context || 0,
        /* The levels this model takes, in the CLI's own words. An empty list
           means the model has no such dial, which is most of opencode's. */
        efforts: Array.isArray(model.efforts) ? model.efforts : [],
        effort: model.effort || '',
        /* What a search reads. Built here, once, because the settings pane
           filters four hundred of these on every keystroke. */
        search: `${model.group || providerLabel} ${model.label || model.id} ${model.id}`.toLowerCase()
      })
    }
  }
  flattened.set(source, out)
  return out
}

/** Ticked by default, spelled out — what the settings pane shows before the
 *  user has chosen anything. */
const defaultModels = (catalogue) =>
  allModels(catalogue).filter((model) => offerByDefault(model.provider))

export const defaultEnabled = (catalogue) =>
  defaultModels(catalogue).map((model) => model.key)

/** The models the copilot offers: those ticked in settings, plus whichever
 *  one is selected — a dropdown that cannot show its own value is worse than a
 *  long one. Falls back to the defaults rather than ever being empty. */
export function offeredModels (catalogue, enabled, selected) {
  const fallback = defaultModels(catalogue)
  const wanted = new Set(enabled?.length ? enabled : fallback.map((model) => model.key))
  if (selected) wanted.add(selected)

  const offered = allModels(catalogue).filter((model) => wanted.has(model.key))
  return offered.length ? offered : fallback
}

/** How a model is named in a list: qualified by whoever is answering, because
 *  `GPT-5.6-Sol` and `glm-5.2` side by side say nothing about who that is. */
const longLabel = (model) => `${model.group} · ${model.label}`

/** A list of models as the dropdown wants them. One spelling, so the settings
 *  pane and the composer cannot label the same model differently. */
export const asOptions = (models) =>
  models.map((model) => ({ value: model.key, label: longLabel(model) }))

/** The provider a key names, as a person would say it. */
export const providerLabel = (provider) => PROVIDER[provider]?.label || provider

/**
 * What this CLI may actually do in this mode, in words.
 *
 * One switch, three blast radii: Claude takes a tool allowlist and so has no
 * shell at all, while Codex and opencode have no per-tool switch and are fenced
 * only by a sandbox — which leaves them able to run commands in the vault. The
 * toggle used to promise the same thing for all three. It now says which of the
 * three it is handing over; the words are the catalogue's, beside the command
 * they describe.
 */
export const providerGrant = (provider, write) =>
  PROVIDER[provider]?.grants?.[write ? 'write' : 'read'] || ''

/**
 * The chosen model, out of the config.
 *
 * `aiModel` is the one key now, but an install from before the two questions
 * became one has the answers filed separately — so the old pair is read when
 * the new key is missing. Here rather than in either consumer: both the panel
 * and the settings pane read this fact, and a migration living in one of them
 * is how the two come to disagree about which model is selected.
 */
export function modelFromConfig (cfg, fallback = DEFAULT_MODEL) {
  if (typeof cfg?.aiModel === 'string' && cfg.aiModel.includes(':')) return cfg.aiModel
  const was = cfg?.aiProvider || ''
  const id = was === 'codex' ? cfg?.aiCodexModel : cfg?.aiClaudeModel
  return was && id ? keyOf(was, id) : fallback
}

/* -------------------------------------------------------------- effort */

/* Named rather than numbered, and the names are the CLIs' own — opencode's
   `none` and `thinking` and Codex's `ultra` among them. Ordered weakest to
   strongest, which is the one thing a shared scale is needed for: mapping a
   level a model does not take onto the nearest it does. A level no one here has
   heard of is shown as it came, which beats hiding one the CLI has started
   offering. */
const EFFORTS = CATALOGUE.efforts
const EFFORT_LABEL = Object.fromEntries(EFFORTS.map((e) => [e.id, e.label]))
const EFFORT_ORDER = EFFORTS.map((e) => e.id)

export const effortLabel = (level) =>
  EFFORT_LABEL[level] || (level ? level[0].toUpperCase() + level.slice(1) : '')

/** The levels a model takes, weakest first. Empty when it has no such dial. */
export function effortsFor (model) {
  if (!model?.efforts?.length) return []
  const rank = (level) => {
    const at = EFFORT_ORDER.indexOf(level)
    return at === -1 ? EFFORT_ORDER.length : at
  }
  return [...model.efforts].sort((a, b) => rank(a) - rank(b))
}

/**
 * The level to run at, given what the user last chose.
 *
 * Kept if the model takes it. Otherwise the nearest one it does take, by
 * position on the scale rather than by name — a user who had picked Max and
 * moves to a model offering only low/medium/high should land on High, not back
 * at the model's own default.
 */
export function nearestEffort (model, wanted) {
  const levels = effortsFor(model)
  if (!levels.length) return ''
  if (levels.includes(wanted)) return wanted

  const target = EFFORT_ORDER.indexOf(wanted)
  if (target === -1) return levels[0]
  return levels.reduce((best, level) => {
    const gap = Math.abs(EFFORT_ORDER.indexOf(level) - target)
    return gap < Math.abs(EFFORT_ORDER.indexOf(best) - target) ? level : best
  }, levels[0])
}
