import { createMarkdown } from '../src/markdown.js'
import { enhanceFlashcards } from '../src/flashcards.js'

const SOURCE = `> [!quiz] Which planet is known as the Red Planet?
> ![[mars.jpg]]
> - [ ] Venus
> - [x] Mars
> - [ ] Jupiter
>
> Explanation: Iron minerals in Mars's soil give it the familiar red colour.
`

export function run () {
  const root = document.createElement('div')
  root.className = 'reading'
  const body = document.createElement('div')
  body.className = 'reading-body'
  root.append(body)
  document.body.append(root)

  const md = createMarkdown({ resolveEmbedSrc: (src) => src })
  body.innerHTML = md.render(SOURCE)
  const enhanced = enhanceFlashcards(body)
  const card = body.querySelector('[data-callout="quiz"]')
  const buttons = [...body.querySelectorAll('.quiz-option')]
  const explanation = body.querySelector('.quiz-explanation')
  const before = {
    enhanced,
    buttons: buttons.length,
    media: Boolean(card.querySelector(':scope > .quiz-media .embed-slot')),
    explanationHidden: explanation.hidden
  }

  buttons[0].click()
  return {
    before,
    result: card.dataset.result,
    feedback: body.querySelector('.quiz-feedback').textContent,
    explanationHiddenAfter: explanation.hidden,
    correctMarked: buttons[1].classList.contains('is-correct'),
    wrongMarked: buttons[0].classList.contains('is-wrong'),
    allAnswersResolved: buttons.every((button, index) =>
      button.classList.contains(index === 1 ? 'is-correct' : 'is-wrong')),
    disabled: buttons.every((button) => button.disabled)
  }
}
