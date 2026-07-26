# Tulip

A minimal markdown editor for a folder of `.md` files, built with Electron and
CodeMirror 6. Notes are plain files on disk — nothing is stored in a database,
and the same folder opens fine in any other editor.

## Running it

```bash
npm install
npm start          # builds the renderer, then launches the app
```

During development:

```bash
npm run dev        # esbuild in watch mode
npm run app        # launch without rebuilding
```

## What it does

**Editing.** Markdown syntax hides itself except on the line the cursor is on,
so a note reads as prose while you write it and shows its true source the moment
you need to edit it. Headings, emphasis, quotes, code, tags, and task checkboxes
all render inline.

**Vault.** Point it at any folder (`⌘⇧O`). The sidebar mirrors the folder tree;
folders sort above files. Changes made outside the app are picked up by a file
watcher. Deletes go to the system Trash, not `unlink`.

**Links.** `[[Note name]]` links between notes, with completion after `[[`.
Following a link to a note that does not exist creates it. Renaming or moving a
note rewrites the links that named it, leaving alone any written inside code.

**Getting back.** `⌘[` and `⌘]` walk the trail you followed, returning you to
the place in each note you were reading rather than to its top. The side buttons
on a mouse do the same.

**Saving.** Edits autosave 600 ms after you stop typing, and on note switch,
window hide, and quit. The dot beside the note name means unsaved.

## Keys

| | |
|---|---|
| `⌘[` / `⌘]` | Back / forward |
| `⌘O` | Jump to a note |
| `⌘P` | Command palette |
| `⌘⇧F` | Search the vault |
| `⌘F` | Find in note |
| `⌘N` / `⌘⇧N` | New note / folder |
| `⌘E` | Reading view |
| `⌘\` | Toggle sidebar |
| `⌘⇧L` | Light / dark |
| `⌘B` `⌘I` `⌘K` | Bold, italic, link |

## Layout

```
electron/main.js     window, menus, and every filesystem operation
electron/preload.js  the renderer's only route to the outside world
src/editor.js        CodeMirror setup, theme, and the live-preview decorations
src/renderer.js      app state, file tree, overlays, reading view
src/styles.css       design tokens and all chrome styling
build.mjs            esbuild bundle into dist/
scripts/drive.mjs    evaluates expressions in a running renderer, for testing
```

The renderer never touches `fs`. It runs with `contextIsolation` on and
`nodeIntegration` off, and reaches the disk only through the named calls in
`preload.js`; the main process resolves every path against the vault root and
rejects anything that escapes it.

## Design

Content is set in Charter, the chrome in the system sans at small sizes — the
writing surface gets the characterful face and the interface recedes. One accent
(a madder rose) carries links, the cursor, and emphasis; a muted green is held
back for the language-learning layer. The hairline left of the text column fills
as you scroll, so position in a note reads as a growing stem.

## Testing against a running app

Launch with a debugging port, then evaluate expressions inside the renderer:

```bash
npx electron --remote-debugging-port=9333 .
CDP_PORT=9333 node scripts/drive.mjs "window.__tulip.state.current.path"
CDP_PORT=9333 node scripts/drive.mjs --file probe.js
```

`window.__tulip` exposes `state`, `editor`, `api`, `openNote`, `runCommand`, and
`openOverlay`.

## Not built yet

The language-learning surface. `sample-vault/Language Log/` has a note with
`type: vocab` frontmatter as a placeholder for where spaced repetition would
read from.
