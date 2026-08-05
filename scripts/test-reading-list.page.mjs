import { createMarkdown } from '../src/markdown.js'

const source = [
  '1. first', '', '```rust', 'fn main() {}', '```', '', '2. second'
].join('\n')

export function run () {
  const root = document.createElement('div')
  root.className = 'reading'
  root.innerHTML = '<div class="reading-body"></div>'
  document.body.append(root)

  const md = createMarkdown({ resolveEmbedSrc: (src) => src })
  root.querySelector('.reading-body').innerHTML = md.render(source)
  const markers = root.querySelectorAll('ol > li > .tk-olnum')
  return {
    first: markers[0].textContent,
    second: markers[1].textContent,
    firstPosition: getComputedStyle(markers[0]).position,
    secondPosition: getComputedStyle(markers[1]).position
  }
}
