/* =========================================================== flashcards
   Portable multiple-choice cards inside an ordinary Markdown note.

   The source is a callout with a task list. That keeps a card readable in any
   Markdown editor, while Tulip turns the choices into buttons in Reading view
   and reveals the explanation after the reader answers.
   ================================================================== */

import { el as node } from './dom.js'

/** The slash-menu snippet. Tab stops make the card writable without learning
 *  the callout syntax, and the checked choice is the answer on disk. */
export const FLASHCARD_TEMPLATE = [
  '> [!quiz] ${Question}',
  '> Tags: ${topic, area}',
  '> - [ ] ${Choice 1}',
  '> - [ ] ${Choice 2}',
  '> - [x] ${Correct choice}',
  '> - [ ] ${Choice 4}',
  '>',
  '> Explanation: ${Why this is correct}',
  ''
].join('\n')

const oneLine = (value) => String(value || '').replace(/\r?\n/g, ' ').trim()

/**
 * Turn form values into the Markdown stored in the note.
 *
 * Empty choices are allowed here so a form can offer four slots while the
 * writer uses only three. The caller validates that at least two remain and
 * that `correct` points at one of them.
 */
export function flashcardMarkdown ({ question, image = '', tags = [], options, correct, explanation }) {
  const prompt = oneLine(question)
  const picture = oneLine(image).replace(/^!\[\[/, '').replace(/\]\]$/, '').trim()
  const topics = normaliseFlashcardTags(tags)
  const choices = (Array.isArray(options) ? options : []).map(oneLine).filter(Boolean)
  const answer = Number(correct)
  const reason = String(explanation || '').trim().replace(/\r/g, '')
  if (!prompt || !reason || choices.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= choices.length) {
    return ''
  }

  const lines = [
    `> [!quiz] ${prompt}`,
    ...(topics.length ? [`> Tags: ${topics.join(', ')}`] : []),
    ...(picture ? [`> ![[${picture}]]`] : []),
    ...choices.map((choice, index) => `> - [${index === answer ? 'x' : ' '}] ${choice}`),
    '>'
  ]
  const explanationLines = reason ? reason.split('\n').map((line, index) =>
    `> ${index === 0 ? 'Explanation: ' : ''}${line}`) : []
  return [...lines, ...explanationLines, ''].join('\n')
}

const QUIZ_HEAD = /^\s*>\s*\[!quiz[+-]?\]\s*(.*)$/i
const QUOTED = /^\s*>\s?(.*)$/
const CHOICE = /^[-*+]\s+\[([ xX])\]\s+(.+)$/
const EXPLANATION = /^Explanation:\s*/i
const TAGS = /^Tags:\s*(.*)$/i
const IMAGE = /^!\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]$/

/** Tags as a stable, comma-separated identity while preserving the first
 *  spelling the writer used for display. */
function normaliseFlashcardTags (value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',')
  const seen = new Set()
  const tags = []
  for (const item of raw) {
    const tag = oneLine(item).replace(/^#/, '')
    const key = tag.toLocaleLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

/** Parse quiz callouts from Markdown for tests and non-DOM consumers. */
export function parseFlashcards (markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  const cards = []

  for (let start = 0; start < lines.length; start++) {
    const head = QUIZ_HEAD.exec(lines[start])
    if (!head) continue

    const options = []
    /** @type {string | null} */
    let image = null
    let tags = []
    let explanation = ''
    let end = start + 1
    for (; end < lines.length; end++) {
      const quoted = QUOTED.exec(lines[end])
      if (!quoted) break
      const content = quoted[1]
      const picture = IMAGE.exec(content.trim())
      if (picture && !image) {
        image = picture[1].trim()
        continue
      }
      const tagged = TAGS.exec(content.trim())
      if (tagged) {
        tags = normaliseFlashcardTags(tagged[1])
        continue
      }
      const choice = CHOICE.exec(content)
      if (choice) {
        options.push({ text: choice[2].trim(), correct: choice[1].toLowerCase() === 'x' })
        continue
      }
      if (EXPLANATION.test(content)) {
        explanation = content.replace(EXPLANATION, '').trim()
        continue
      }
      if (explanation && content.trim()) explanation += `\n${content.trim()}`
    }

    const correct = options.findIndex((option) => option.correct)
    const correctCount = options.filter((option) => option.correct).length
    if (head[1].trim() && options.length >= 2 && correctCount === 1 && correct >= 0) {
      cards.push({
        question: head[1].trim(),
        image,
        tags,
        options: options.map(({ text }) => text),
        correct,
        explanation,
        start,
        end
      })
    }
    start = Math.max(start, end - 1)
  }
  return cards
}

/** Every topic in a bank, in first-seen order. */
export function flashcardTags (cards) {
  return normaliseFlashcardTags((cards || []).flatMap((card) => card.tags || []))
}

/** A shuffled, non-repeating study cycle, optionally narrowed to one tag. */
export function buildFlashcardQueue (cards, tag = '', random = Math.random) {
  const wanted = oneLine(tag).replace(/^#/, '').toLocaleLowerCase()
  const queue = (Array.isArray(cards) ? cards : []).filter((card) =>
    !wanted || (card.tags || []).some((item) => item.toLocaleLowerCase() === wanted))
  for (let index = queue.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[queue[index], queue[swap]] = [queue[swap], queue[index]]
  }
  return queue
}

/** Copy an option's rendered content without carrying its source checkbox. */
function optionContent (item) {
  const copy = item.cloneNode(true)
  copy.querySelector('input.task')?.remove()
  return [...copy.childNodes]
}

/**
 * Make rendered quiz callouts answerable.
 *
 * A card is enhanced only when it has two or more choices and exactly one
 * checked answer. Malformed hand-written callouts remain ordinary callouts so
 * the source is still visible and repairable.
 */
export function enhanceFlashcards (root) {
  let enhanced = 0
  for (const card of root.querySelectorAll('.callout[data-callout="quiz"]')) {
    if (card.dataset.flashcard === 'ready') continue
    const body = [...card.children].find((child) => child.classList.contains('callout-body'))
    if (!body) continue

    const list = [...body.children].find((child) =>
      /^(UL|OL)$/.test(child.tagName) &&
      [...child.children].some((item) => item.matches('li.task-item') && item.querySelector('input.task')))
    if (!list) continue

    const items = [...list.children].filter((item) =>
      item.matches('li.task-item') && item.querySelector('input.task'))
    const correct = items.findIndex((item) => item.querySelector('input.task')?.checked)
    if (items.length < 2 || correct < 0 || items.filter((item) => item.querySelector('input.task')?.checked).length !== 1) {
      continue
    }

    const buttons = items.map((item, index) => {
      const button = node('button', 'quiz-option')
      button.type = 'button'
      button.classList.add(`is-tone-${index % 4}`)
      button.setAttribute('aria-pressed', 'false')
      button.append(...optionContent(item))
      item.replaceChildren(button)
      button.addEventListener('click', () => choose(index))
      return button
    })
    list.classList.add('quiz-options')
    list.setAttribute('aria-label', 'Answer choices')

    /* An optional image line is ordinary portable Markdown on disk. In the
       card it becomes the full-width visual lead, above the question. */
    const media = [...body.children].find((child) =>
      child.matches('p') && child.querySelector('.embed-slot'))
    if (media) {
      media.classList.add('quiz-media')
      card.insertBefore(media, card.firstChild)
    }

    const tagLine = [...body.children].find((child) =>
      child.matches('p') && TAGS.test(child.textContent.trim()))
    if (tagLine) {
      const tags = normaliseFlashcardTags(tagLine.textContent.trim().replace(TAGS, '$1'))
      tagLine.classList.add('quiz-tags')
      tagLine.replaceChildren(...tags.map((tag) => node('span', '', tag)))
    }

    const explanation = [...body.children].find((child) =>
      child.matches('p') && EXPLANATION.test(child.textContent.trim()))
    if (explanation) {
      explanation.textContent = explanation.textContent.trim().replace(EXPLANATION, '')
      explanation.classList.add('quiz-explanation')
      explanation.hidden = true
    }

    const feedback = node('p', 'quiz-feedback')
    feedback.setAttribute('role', 'status')
    feedback.setAttribute('aria-live', 'polite')
    feedback.hidden = true
    if (explanation) body.insertBefore(feedback, explanation)
    else body.append(feedback)

    function choose (selected) {
      if (card.dataset.answered === 'true') return
      card.dataset.answered = 'true'
      const right = selected === correct
      buttons.forEach((button, index) => {
        button.disabled = true
        button.setAttribute('aria-pressed', String(index === selected))
        button.classList.add(index === correct ? 'is-correct' : 'is-wrong')
        if (index === selected) button.classList.add('is-selected')
      })
      card.dataset.result = right ? 'correct' : 'wrong'
      feedback.dataset.result = card.dataset.result
      feedback.textContent = right
        ? 'Correct.'
        : `Not quite. The correct answer is “${buttons[correct].textContent.trim()}”.`
      feedback.hidden = false
      if (explanation) explanation.hidden = false
    }

    card.classList.add('is-flashcard')
    card.dataset.flashcard = 'ready'
    enhanced++
  }
  return enhanced
}
