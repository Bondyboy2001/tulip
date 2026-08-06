/* ============================================================ review panel
   The statistics surface, drawn from src/review-stats.js.

   Built in JavaScript rather than declared in index.html, unlike the app's
   other dialogs, for one reason: this is the only one that is not there until
   it is asked for. Every other panel is part of the window whether or not the
   reader ever opens it; a vault that studies nothing should not carry the
   markup for a page about studying.

   Two things it does besides count. The leech list is clickable, because the
   answer to a card failed nine times is nearly always to go and edit the row —
   a statistic you can only look at is a statistic that changes nothing. And
   `Forget deleted cards` is the only caller of `review.prune`, which has been
   implemented, guarded and tested since the store was written and had, until
   now, no way to be reached. Without it the state file keeps the schedule of
   every row anybody has ever deleted, for ever.
*/

import { el as node } from './dom.js'
import { summarize, LEECH_LAPSES } from './review-stats.js'
import { languageCards } from './language-table.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const percent = (fraction) =>
  fraction === null ? '—' : `${Math.round(fraction * 100)}%`

/** A count and what it counts, as one tile. */
function tile (value, label, title = '') {
  const box = node('div', 'stats-tile')
  box.append(node('span', 'stats-value', String(value)))
  box.append(node('span', 'stats-label', label))
  if (title) box.title = title
  return box
}

/**
 * A strip of bars, one per day.
 *
 * Deliberately not a chart library and deliberately not axes: the question a
 * forecast answers is "is tomorrow heavy", which is a shape, and the exact
 * numbers are on each bar's tooltip for when it is not. The tallest bar sets
 * the scale, so an empty stretch reads as empty rather than as small.
 */
function bars (series, { label, empty }) {
  const wrap = node('section', 'stats-chart')
  wrap.append(node('h3', 'stats-head', label))

  const most = series.reduce((high, day) => Math.max(high, day.count), 0)
  if (!most) {
    wrap.append(node('p', 'stats-empty', empty))
    return wrap
  }

  const strip = node('div', 'stats-bars')
  for (const day of series) {
    const slot = node('div', 'stats-bar-slot')
    const bar = node('div', 'stats-bar')
    /* A day with work in it never draws as nothing: one card due is a bar you
       can see, not a rounding error against a day with two hundred. */
    bar.style.height = day.count ? `${Math.max(6, (day.count / most) * 100)}%` : '0'
    const when = new Date(day.at)
    slot.title = `${when.toDateString()} — ${day.count} card${day.count === 1 ? '' : 's'}`
    slot.append(bar)
    strip.append(slot)
  }
  wrap.append(strip)

  /* Only the ends are labelled. Thirty labels along a strip this wide is a
     smear, and the two that carry meaning are where it starts and stops. */
  const scale = node('div', 'stats-scale')
  const first = new Date(series[0].at)
  const last = new Date(series[series.length - 1].at)
  scale.append(node('span', 'stats-scale-end', `${DAY_NAMES[first.getDay()]} ${first.getDate()}`))
  scale.append(node('span', 'stats-scale-end', `${DAY_NAMES[last.getDay()]} ${last.getDate()}`))
  wrap.append(scale)
  return wrap
}

/**
 * @param deps.toast     the app's transient message
 * @param deps.openNote  to follow a leech back to the row it came from
 * @param deps.api       the preload bridge
 */
export function mountReviewStats ({ toast, openNote, api }) {
  let backdrop = null

  function close () {
    backdrop?.remove()
    backdrop = null
  }

  /** Every card id the vault currently contains — what `prune` compares against. */
  async function currentCardIds () {
    const decks = await api.language.decks().catch(() => [])
    const ids = []
    for (const deck of decks) {
      for (const card of languageCards(deck.text, deck.path, { speaks: true })) {
        ids.push(card.id)
      }
    }
    return ids
  }

  async function forgetDeleted (button) {
    button.disabled = true
    const ids = await currentCardIds()
    const answer = await api.review.prune(ids).catch(() => null)
    button.disabled = false

    if (!answer) { toast('Those cards could not be pruned.'); return }
    /* The store refuses a prune that looks like a failed scan rather than a
       real deletion, and says which — passing that on verbatim is the whole
       value of it having been careful. */
    if (answer.refused) { toast(`Nothing was forgotten: ${answer.reason}.`); return }
    if (!answer.pruned) { toast('Every card still has a row.'); return }
    toast(`Forgot ${answer.pruned} card${answer.pruned === 1 ? '' : 's'} with no row left.`)
    show()
  }

  function draw (stats) {
    const panel = node('div', 'stats-panel')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', 'Review statistics')

    const head = node('header', 'stats-headline')
    head.append(node('h2', 'stats-title', 'Review'))
    head.append(node('span', 'stats-sub', stats.counts.total
      ? `${stats.counts.total} card${stats.counts.total === 1 ? '' : 's'} across the vault`
      : 'No cards yet — a language note with a table makes some.'))
    panel.append(head)

    const tiles = node('div', 'stats-tiles')
    tiles.append(tile(stats.due.now, 'due now'))
    tiles.append(tile(stats.counts.unseen, 'unseen', 'Cards that have never been answered'))
    tiles.append(tile(stats.counts.young, 'learning',
      'Answered, but not yet remembered for three weeks at a time'))
    tiles.append(tile(stats.counts.mature, 'known',
      'Remembered across intervals of three weeks or more'))
    tiles.append(tile(percent(stats.answers.retention), 'recalled',
      `Of ${stats.answers.window} answers in the last 30 days`))
    tiles.append(tile(stats.streak, stats.streak === 1 ? 'day running' : 'days running',
      'Consecutive days with at least one answer'))
    panel.append(tiles)

    panel.append(bars(stats.forecast, {
      label: 'Coming up',
      empty: 'Nothing is scheduled in the next fortnight.'
    }))
    panel.append(bars(stats.daily, {
      label: 'Answered',
      empty: 'No answers in the last thirty days.'
    }))

    const leeches = node('section', 'stats-chart')
    leeches.append(node('h3', 'stats-head', 'Getting stuck'))
    if (!stats.leeches.length) {
      leeches.append(node('p', 'stats-empty',
        `No card has been failed ${LEECH_LAPSES} times. Nothing here needs rewriting.`))
    } else {
      leeches.append(node('p', 'stats-note',
        'Failed again and again — usually the row needs editing rather than more practice.'))
      const list = node('div', 'stats-leeches')
      for (const card of stats.leeches.slice(0, 20)) {
        const row = node('button', 'stats-leech')
        row.type = 'button'
        row.append(node('span', 'stats-leech-term', card.term))
        row.append(node('span', 'stats-leech-note', card.path.replace(/\.md$/i, '')))
        row.append(node('span', 'stats-leech-count', `${card.lapses}×`))
        row.title = card.cards > 1
          ? `Failed ${card.lapses} times — across ${card.cards} cards and ${card.reps} reviews. Open the note.`
          : `Failed ${card.lapses} times in ${card.reps} reviews — open the note`
        row.addEventListener('click', () => { close(); openNote(card.path) })
        list.append(row)
      }
      leeches.append(list)
    }
    panel.append(leeches)

    const foot = node('footer', 'stats-foot')
    const prune = node('button', 'ask-btn', 'Forget deleted cards')
    prune.type = 'button'
    prune.title = 'Drop the schedule of every card whose row is no longer in any note'
    prune.addEventListener('click', () => forgetDeleted(prune))
    const done = node('button', 'ask-btn is-go', 'Close')
    done.type = 'button'
    done.addEventListener('click', close)
    foot.append(prune, done)
    panel.append(foot)

    /* The panel takes focus itself rather than handing it to a control. Close
       is the last thing in a page that scrolls, and focusing it scrolled the
       heading off the top before the reader had seen it — the first thing they
       were shown was the footer. Focus has to land *somewhere* for Escape and
       for the Tab trap, and the container is the one place that does not
       move the page to reach it. */
    panel.tabIndex = -1
    return { panel, focus: panel }
  }

  async function show () {
    close()
    const [cards, history] = await Promise.all([
      api.review.all().catch(() => ({})),
      api.review.history().catch(() => [])
    ])
    const stats = summarize({ cards, history, now: Date.now() })

    backdrop = node('div', 'stats-backdrop')
    const { panel, focus } = draw(stats)
    backdrop.append(panel)
    backdrop.addEventListener('click', (event) => {
      // The backdrop itself, not a click that happened to bubble from inside.
      if (event.target === backdrop) close()
    })
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close() }
    })
    document.body.append(backdrop)
    /* Tab is kept inside by the app's one focus trap, which finds whichever
       `[aria-modal="true"]` is on screen rather than being told about each
       panel — so this one is trapped by virtue of saying what it is. */
    focus.focus()
  }

  return { show, close, isOpen: () => !!backdrop }
}
