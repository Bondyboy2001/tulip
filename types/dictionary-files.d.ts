/* Hunspell dictionary files, imported by src/spellcheck.js and inlined as
   text by the build (the `.aff`/`.dic` loader in build.mjs). To tsc, which
   never sees the loader, each import is simply a string. */
declare module '*.aff' {
  const text: string
  export default text
}
declare module '*.dic' {
  const text: string
  export default text
}
