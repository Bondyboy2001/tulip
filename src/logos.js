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
export function logoSvg (id) {
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
