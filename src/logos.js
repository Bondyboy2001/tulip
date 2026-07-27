/* ================================================================ logos
   The real brand marks, from Simple Icons (MIT). Each icon is a single SVG
   path plus the brand's own hex, which is exactly what a 17px tile needs —
   full-colour artwork would turn to mud at this size, and these silhouettes
   are the shapes people actually recognise.

   Icons are imported by name so esbuild can drop the other ~3000 from the
   bundle. Nothing is fetched at runtime: the page runs under
   default-src 'none', and a note should render the same with the network off.
   ================================================================== */

import {
  siJavascript, siTypescript, siReact, siPython, siRuby, siRust, siGo,
  siSwift, siKotlin, siOpenjdk, siC, siCplusplus, siPhp, siHtml5, siCss,
  siSass, siJson, siYaml, siToml, siMarkdown, siGnubash, siLua, siR, siDart,
  siVuedotjs, siSvelte, siHaskell, siElixir, siErlang, siClojure, siScala,
  siZig, siNim, siPerl, siJulia, siOcaml, siGraphql, siDocker, siNixos,
  siSolidity, siPostgresql, siXml
} from 'simple-icons'

/** Tulip's language id → the brand mark that belongs to it. */
const MARKS = {
  javascript: siJavascript,
  jsx: siReact,
  typescript: siTypescript,
  tsx: siReact,
  python: siPython,
  ruby: siRuby,
  rust: siRust,
  go: siGo,
  swift: siSwift,
  kotlin: siKotlin,
  java: siOpenjdk,
  c: siC,
  cpp: siCplusplus,
  php: siPhp,
  html: siHtml5,
  css: siCss,
  scss: siSass,
  json: siJson,
  yaml: siYaml,
  toml: siToml,
  xml: siXml,
  markdown: siMarkdown,
  shell: siGnubash,
  lua: siLua,
  r: siR,
  dart: siDart,
  vue: siVuedotjs,
  svelte: siSvelte,
  haskell: siHaskell,
  elixir: siElixir,
  erlang: siErlang,
  clojure: siClojure,
  scala: siScala,
  zig: siZig,
  nim: siNim,
  perl: siPerl,
  julia: siJulia,
  ocaml: siOcaml,
  graphql: siGraphql,
  dockerfile: siDocker,
  nix: siNixos,
  solidity: siSolidity,
  sql: siPostgresql
}

/**
 * An <svg> of the mark, drawn in currentColor so the tile decides the colour.
 * Returns null for languages Simple Icons does not carry — C# and PowerShell
 * among them — and those keep their monogram.
 */
/* Manim is not in Simple Icons, so its mark ships as the project's own file —
   the sidebar logo from docs.manim.community, bundled at build time because
   the page's CSP forbids fetching anything. The upstream light and dark
   variants differ only in the colour of the M (#343434 vs #ece6e2), so one
   file serves both themes: the M is repainted with the theme's own ink, and
   the square, circle and triangle keep the brand's colours. */
import manimLogoSource from './manim-logo.svg'

function manimSvg () {
  const svg = brandSvg(manimLogoSource, 'is-manim', /fill:\s*#343434/)
  // The file is a sidebar banner, and half of it is margin — the ink sits in
  // the middle of the canvas (measured with getBBox). At tile height those
  // margins would shrink the mark to two-thirds of nothing, so the viewBox is
  // cropped to the drawing.
  svg?.setAttribute('viewBox', '38.3 14.2 78.6 52.3')
  return svg
}

/* Lean's mark — the ∀ the project itself designed for 16px use, from the
   official VS Code extension (vscode-lean4/media/lean-mini-*.svg). The full
   L∃∀N wordmark was tried first and is unreadable at tile height; this is the
   asset Lean draws at this size. Upstream ships a black and a white copy that
   differ only in stroke colour, so one file serves both themes with the
   stroke repainted in the theme's ink. */
import leanLogoSource from './lean-logo.svg'

function brandSvg (source, extraClass, repaint) {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml')
  const svg = doc.documentElement
  if (svg.nodeName !== 'svg') return null

  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.classList.add('lang-logo', extraClass)

  // `repaint` names the colour that should follow the theme; on elements that
  // carry it, whichever of fill/stroke is a real colour becomes the ink.
  for (const el of svg.querySelectorAll('[style]')) {
    const style = el.getAttribute('style')
    if (!repaint.test(style)) continue
    if (/fill:\s*#/.test(style)) el.style.fill = 'var(--ink)'
    if (/stroke:\s*#/.test(style)) el.style.stroke = 'var(--ink)'
  }
  return document.importNode(svg, true)
}

function leanSvg () {
  return brandSvg(leanLogoSource, 'is-lean', /stroke:\s*#000000/)
}

export function logoSvg (id) {
  if (id === 'manim') return manimSvg()
  if (id === 'lean') return leanSvg()

  const icon = MARKS[id]
  if (!icon?.path) return null

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('lang-logo')

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', icon.path)
  path.setAttribute('fill', 'currentColor')
  svg.append(path)

  return svg
}
