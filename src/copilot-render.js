/* The transcript's renderer: a message in, HTML out.
 *
 * Pure drawing — no panel state, no conversation. The one question a message
 * cannot answer alone is whether it ends its reply (the copy and insert
 * buttons go there, once per answer rather than once per row), so the panel
 * hands that predicate in at mount: `endsReply`, and whether answers can be
 * inserted into the note at all (`canInsert`).
 *
 * Split out of src/copilot.js so the markup, the markdown configuration and
 * the buttons are one module, and so a change to how a step or a thinking row
 * is drawn cannot reach the state machinery.
 */

import MarkdownIt from 'markdown-it'

import { highlightInto } from './highlight.js'
import { mathPlugin } from './math.js'
import { citePlugin } from './cite.js'
import { running, verbFor, jumps, opens } from './copilot-phases.js'

/**
 * `<sub>` and `<sup>`, as the two tags rather than as raw HTML.
 *
 * HTML is off in chat prose and stays off. But a model writing about
 * mathematics reaches for `Q<sub>A</sub>` whether or not it was asked to, and
 * with the tags escaped the reply reads as markup instead of as an index. So
 * exactly these two are understood, with plain text inside and no nesting —
 * which is all either is ever used for, and small enough that letting them
 * through is not the same as letting HTML through.
 */
const SCRIPT_TAG = /<(sub|sup)>([^<>&]{1,60})<\/\1>/iy

function scriptPlugin (md) {
  md.inline.ruler.before('escape', 'sub_sup', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3C) return false   // '<'
    SCRIPT_TAG.lastIndex = state.pos
    const match = SCRIPT_TAG.exec(state.src)
    if (!match) return false

    if (!silent) {
      const token = state.push('sub_sup', '', 0)
      token.tag = match[1].toLowerCase()
      token.content = match[2]
    }
    state.pos += match[0].length
    return true
  })

  md.renderer.rules.sub_sup = (tokens, i) =>
    `<${tokens[i].tag}>${md.utils.escapeHtml(tokens[i].content)}</${tokens[i].tag}>`
}

/* Chat prose is not a note: no Run buttons on its fences, no wikilinks, no
   embeds. A plain renderer, kept apart from the one the reading view uses —
   but sharing its maths, because an answer about a paper is mostly formulae
   and `\frac{1}{2}` set as prose is an answer nobody can read. */
function sourceLinkPlugin (md) {
  md.inline.ruler.before('link', 'source_note', (state, silent) => {
    const match = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(state.src.slice(state.pos))
    if (!match) return false
    if (!silent) { const token = state.push('source_note', '', 0); token.content = match[2] || match[1]; token.meta = match[1] }
    state.pos += match[0].length
    return true
  })
  md.renderer.rules.source_note = (tokens, i) => `<button type="button" class="ai-note-source" data-source="${md.utils.escapeHtml(tokens[i].meta)}">${md.utils.escapeHtml(tokens[i].content)}</button>`
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true })
  .use(mathPlugin)
  .use(scriptPlugin)
  .use(citePlugin)
  .use(sourceLinkPlugin)

const escape = (text) => md.utils.escapeHtml(String(text ?? ''))

/* The two things worth doing to a message that has already been said: take a
   copy of an answer, and put a question back in the box to ask differently.
   Drawn into the message rather than appended to its node, because every
   repaint replaces that node's contents — a button hung on the outside
   survived exactly until the reply finished streaming. */
const COPY_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>' +
  '<path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7"/></svg>'
const EDIT_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M3 11.75V13h1.25l7.7-7.7-1.25-1.25zM9.9 4.85l1.25 1.25"/></svg>'
const CANCEL_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>'
const INSERT_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M8 2.5v8M4.8 7.3 8 10.5l3.2-3.2M3 13.5h10"/></svg>'

const actions = (...rows) =>
  `<div class="msg-actions">${rows.filter(Boolean).join('')}</div>`

const action = (kind, label, mark) =>
  `<button type="button" class="icon-btn msg-action ai-${kind}" ` +
  `title="${escape(label)}" aria-label="${escape(label)}">${mark}</button>`

/**
 * What a message wears, which changes with it: a tool call that failed,
 * thinking that has finished and can therefore be opened.
 *
 * @param {any} msg
 */
export function classOf (msg) {
  if (msg.t === 'review') return `msg msg-review${msg.accepted ? ' is-accepted' : ''}`
  if (msg.t === 'step') {
    return ['msg msg-step', msg.error && 'is-error', running(msg) && 'is-running',
            jumps(msg) && 'can-open is-edit',
            opens(msg) && 'can-detail'].filter(Boolean).join(' ')
  }
  // A queued question is one the reader has asked and the copilot has not
  // been handed yet — said differently, or it reads as a message that went
  // out and was ignored.
  if (msg.t === 'you') {
    return ['msg msg-you', msg.queued && 'is-queued',
            msg.dropped && 'is-dropped'].filter(Boolean).join(' ')
  }
  if (msg.t !== 'think') return `msg msg-${msg.t}`
  return ['msg msg-think', msg.live && 'is-live', msg.text && 'has-text',
          !msg.live && msg.text && 'can-open'].filter(Boolean).join(' ')
}

/**
 * The message as HTML. Cached on the message by the panel — see `html` there.
 *
 * @param {any} msg
 * @param {{ endsReply: (msg: any) => boolean, canInsert: boolean }} host
 */
export function render (msg, { endsReply, canInsert }) {
  /* A reply carries a copy button; a question carries one and an edit, which
     puts it back in the composer to be asked again differently. Neither is
     drawn on an empty message, and neither on a question that never went. */
  if (msg.t === 'bot') {
    /* Copy, and — this being a notes app — put the reply into the note at
       the caret. Offered whenever the answer is whole; whether there is a
       caret to put it at is the renderer's to say when it is pressed. */
    return md.render(msg.text || '') +
      (msg.text && endsReply(msg)
        ? actions(
            canInsert ? action('insert', 'Insert this reply into the note at the cursor', INSERT_MARK) : '',
            action('copy', 'Copy this reply', COPY_MARK))
        : '')
  }
  if (msg.t === 'you') return md.render(msg.text || '')
  if (msg.t === 'step') {
    const verb = verbFor(msg)
    const tally = msg.added != null || msg.removed != null
      ? '<span class="step-tally">' +
        `<span class="is-add">+${Number(msg.added || 0).toLocaleString()}</span>` +
        `<span class="is-del">−${Number(msg.removed || 0).toLocaleString()}</span></span>`
      : ''
    /* What the tool said, folded away under the row. Kept out of the way
       rather than off the screen: a search that found nothing and one that
       found everything are the same row until you can open it, and a failed
       write is a red line with no reason on it. */
    const detail = msg.detail
      ? `<div class="step-detail">${escape(msg.detail)}</div>`
      : ''
    if (jumps(msg)) {
      return '<span class="step-edit-mark" aria-hidden="true">' +
        '<svg viewBox="0 0 16 16"><path d="M3 11.75V13h1.25l7.7-7.7-1.25-1.25zM9.9 4.85l1.25 1.25"/></svg></span>' +
        '<span class="step-copy"><span class="step-action">' + escape(verb) + '</span>' +
        `<span class="step-path">${escape(msg.path)}</span></span>${tally}` +
        '<span class="step-jump" aria-hidden="true">→</span>'
    }
    const label = escape(msg.path ? `${verb} ${msg.path}` : verb)
    const mark = opens(msg) ? '<span class="step-more" aria-hidden="true">›</span>' : ''
    return `<span class="step-label">${label}</span>${tally}${mark}${detail}`
  }
  // A failure the panel can do something about — see `failed` in copilot.js.
  if ((msg.t === 'warn' || msg.t === 'note') && msg.retry) {
    return `<span class="warn-text">${escape(msg.text)}</span>` +
           `<button type="button" class="ghost is-compact ai-again">${msg.resume ? 'Resume request' : 'Ask again'}</button>`
  }
  if (msg.t !== 'think') return escape(msg.text)

  const label = msg.live ? 'Thinking' : (msg.tokens ? 'Thought for' : 'Thought')
  const count = msg.tokens ? `${msg.tokens.toLocaleString()} tokens` : ''
  return '<div class="think-head"><span class="think-dot"></span>' +
         `<span class="think-label">${escape(label)}</span>` +
         `<span class="think-count">${escape(count)}</span></div>` +
         `<div class="think-body">${escape(msg.text)}</div>`
}

/** The buttons of a question that has already been said — edit, copy, or the
    withdrawal of one still queued. @param {'edit' | 'copy' | 'unqueue'} kind */
export const messageAction = (kind) => {
  if (kind === 'unqueue') return action('unqueue', 'Cancel this queued message', CANCEL_MARK)
  if (kind === 'edit') return action('edit', 'Edit this question and ask again', EDIT_MARK)
  return action('copy', 'Copy this question', COPY_MARK)
}

/**
 * Colour the fenced code in freshly written prose.
 *
 * `highlightInto` is the reading view's own painter: the same lezer parsers
 * over the same token spec, landing on the same `.hl-*` classes the
 * stylesheet already colours globally. So a rust block quoted back at you in
 * the panel and the block it was read from in the note are the same colours,
 * and neither has a palette of its own to drift from the other.
 *
 * markdown-it's fence rule writes the fence's word onto the `<code>` as
 * `language-<word>` and nowhere else, so that class is what the language is
 * read back from here. A block with no word — a command's output, a stack
 * trace — has no class, is asked about nothing, and stays plain, which is
 * both what it was before and what it should be: `error[E0381]` is not rust.
 * An unknown word answers false the same way.
 */
export function dressCode (root) {
  for (const code of root.querySelectorAll('pre > code[class*="language-"]')) {
    const lang = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1]
    if (lang) highlightInto(code, code.textContent, lang).catch(() => {})
  }
}

export { md }
