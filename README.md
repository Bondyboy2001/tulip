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
npm run tidy -- ~/Notes [--check]   # run the markdown linter over a vault
```

## What it does

**Editing.** Markdown syntax hides itself except on the line the cursor is on,
so a note reads as prose while you write it and shows its true source the moment
you need to edit it. Headings, emphasis, quotes, code, tags, and task checkboxes
all render inline. `==highlighted text==` carries the same marker colour in
Editing and Reading, and the disclosure beside a heading folds its whole
section, including nested subheadings.

**Vault.** Point it at any folder (`⌘⇧O`). The folder you choose becomes the
default vault and opens automatically on later launches; replace it under
**Settings → Vault**. The sidebar mirrors the folder tree; folders sort above
files. Changes made outside the app are picked up by a file watcher. Deletes go
to the system Trash, not `unlink`. Right-clicking a row creates, renames,
reveals in Finder, copies the file's full path, or trashes it — across a whole
multi-selection where that makes sense.

**Links.** `[[Note name]]` links between notes, with completion after `[[`.
Following a link to a note that does not exist creates it. Renaming or moving a
note rewrites the links that named it, leaving alone any written inside code.
`[[Note#Heading]]` lands on the heading rather than the top of the note, and
`[[#Heading]]` names one in the note you are already in — completion after
`[[#` offers them. Put `^block-id` at the end of a paragraph or on a line after
a list, then `[[Note#^block-id]]` lands on that exact block.

**One note inside another.** `![[Note]]` stands the whole of another note
where it is written, rendered as the reading view would render it, in a
hairline frame headed by the note's name — click the name to go there.
`![[Note#Heading]]` embeds one section: the heading down to the next one of
its rank. `![[Note#^block-id]]` embeds only the named paragraph, list, or table.
Embeds nest a few levels deep, a note that embeds itself is cut off with a word
rather than followed forever, and the frame repaints when the note it shows
changes on disk. What stands inside is for reading — its checkboxes are inert,
its code blocks keep their colours and diagrams but offer no Run — and an
embedded web page or PDF becomes a link rather than a live guest.

An embedded note also has **Edit source** in its header. It replaces the
rendered fragment with a Markdown field and writes the edit back to the note
the fragment came from; a heading embed edits that heading and its children,
and a block embed keeps its `^block-id`. `⌘Enter` saves and Escape cancels. If
the source changed elsewhere after the field opened, Tulip refuses the save
instead of overwriting the newer file.

**Hover a link to read it.** Rest the pointer on any `[[wikilink]]`, in either
view, and the note it names appears in a popover — the whole note, or just the
section a `[[Note#Heading]]` link points at. Links inside the popover preview
too, so a trail can be followed without opening anything; click to actually
go, move away or press Escape to dismiss.

**Tabs.** Several notes open at once, each with its own back-and-forward trail:
following links in one leaves the other where you left it. `⌘T` opens a tab,
`⌘W` closes one, and middle-clicking a note in the sidebar opens it beside what
you are reading. Drag a tab along the strip to move it; `⌘⇧T` brings back the
last one closed, in the slot it had and at the place in the note you had got
to. The strip comes back as you left it.

**Two documents at once.** `⌥`-click any `[[wikilink]]` — or **Open to the
side** on a file, or on a tab — and the note it names stands in a pane of its
own beside the one you are writing: the paper being cited, the note being
translated from, the plan being carried out. What stands there is the reading
view's own frame, so it repaints when that note changes on disk, and **Edit
source** in its header writes a correction straight back without leaving the
note you are in. A `.pdf` goes there too, and fills the pane. One document at a
time — opening another replaces it, the way the main view works — and the pane
comes back when the window does.

**Outline.** The sidebar has two tabs: Files, and Outline. Outline is a map of
whatever is open — a note's headings, with the one you are reading lit up as you
scroll in either view, or a PDF's own contents and every passage you have marked
in it. `⌘⇧E` switches to it, `⌘O` then `#` jumps to a heading without it.

**Asides, notes, and diagrams.** Blockquotes marked `> [!warning]` become
callouts, with `-` or `+` after the kind to make them fold. Footnotes (`[^1]`)
are set at the foot of the note; clicking a marker in either view shows the
note it points at, and clicking the note itself goes back to the marker. A ```` ```mermaid ```` block is drawn as the
diagram it describes, in both views and in the palette the rest of the app is
painted in. An ```` ```svg ```` block is drawn the same way, with nothing at
all in between — the markup is read, stripped of anything that would run or
reach off the page, and shown as the picture it already is; **Source** puts the
code back.

**Citations.** Pandoc citations such as `[@smith2024]` and
`[see @smith2024, p. 18; @doe2025]` resolve through BibTeX. Name the file in
frontmatter with `bibliography: references.bib` (a YAML list is accepted), or
leave that field out when it is simply called `references.bib`. Reading view
formats each citation and adds only the cited entries under **References**;
DOIs and URLs remain clickable. An unknown key stays visible and says that it
is missing rather than disappearing.

**Numbered equations.** A display equation carrying `\label{eq:energy}` is
numbered automatically; an explicit `\tag{A}` wins when one is present.
`\ref{eq:energy}` prints the number and `\eqref{eq:energy}` prints it in
parentheses. Both are links back to the equation, in either view: following one
brings the equation on screen and washes it in the accent colour, leaving the
caret where it was.

**Pictures that are drawn, not embedded.** A ```` ```tikz ```` block is a
picture: Reading view draws it the first time it reads one, TeX renders it into
the vault as an `.svg`, and from then on both views show the drawing where the
code was — a block already drawn costs nothing to read again. Editing view keeps
its Draw button, and so does a block whose TeX failed. A ```` ```manim ````
block is the same bargain for a scene, rendering to an `.mp4`. Both are named
after a hash of the block, so a note that has been drawn opens with its
pictures already in place and an edit is what asks for a new one. TikZ needs a
LaTeX installation (`latex` and `dvisvgm`, both in MacTeX or TeX Live); the
command and the timeout are in Settings.

**Timed recordings.** A media embed can start at seconds, `MM:SS`, `HH:MM:SS`,
or `1h2m3s`: `![[lecture.mp3#t=12:35]]`. The same address without the bang,
`[[lecture.mp3#t=12:35]]`, opens one transient player at that moment rather
than revealing the file in Finder. It works for the audio and video formats
Tulip already embeds, and accepts an ordinary wikilink alias after `|`.

**PDFs.** A `.pdf` in the vault opens in a tab beside the notes, in a reader of
its own: continuous pages, fit-to-width by default — it refits when the window
or a side panel changes — and zoom by pinch, `⌘`-scroll, `+`/`-`, or the bar
that floats over the page as the mouse moves and stands down while you read.
`0` puts it back to fitting. `⌥↑` and `⌥↓` step a page.

Select text on a page and a marker appears: five colours, copy, or hand the
passage to the copilot. Clicking a highlight offers the same, and to remove it.
Highlights are kept as fractions of the page, so they hold their place at any
zoom, and they live in the vault — `.annotations/<the pdf>.json`, beside the text
they cover — so they travel with the folder and the copilot can read them.

A document's words are put there too, in `.annotations/<the pdf>.txt`, a page at
a time. That is what the copilot reads when you ask about a paper: a `.pdf` is
binary, and of the three assistants only Claude's own tools can open one at all
— so without this the same question is answered or shrugged at depending on
which model is chosen. Written when the vault opens and again when a document
changes, so a paper dropped into the folder can be asked about without being
opened first. A scan with no text in it says so rather than reading as empty.
The sidebar's Outline tab lists the document's own contents and every highlight
in it; right-clicking one there copies it, asks about it, or removes it.

**Websites.** A `.website` in the vault opens in a tab as the live page it
names — a real browser view, so animation, video and anything the page does
still work. The file itself is one line of text holding the address, so it can
be written or edited by anything. New Website makes an empty one and puts the
caret in the address bar; typing there is what points the file somewhere, then
and later. Clicking a link moves the page and leaves the file alone — a Save
button appears once the two differ, to point the file at where you have got to.
`⌥←` and `⌥→` are the page's own back and forward, `⌘L` the address bar, `⌘R`
reload, and `⌘+`/`⌘-`/`⌘0` zoom the page rather than the window.

Pages run as guests: their own process and their own session, with no reach
into Tulip or the vault, and links that want a new window go to your real
browser. A guest cannot ask for the camera, the microphone or your location.

**Settings.** `⌘,` — theme, line width and zoom; autosave delay, spelling and
code line numbers; the timeouts and quality that running a block uses; and the
copilot's own three dials.

**Getting back.** `⌘[` and `⌘]` walk the trail you followed, returning you to
the place in each note you were reading rather than to its top. The side buttons
on a mouse do the same.

**Saving.** Edits autosave 600 ms after you stop typing, and on note switch,
window hide, and quit. The dot beside the note name means unsaved.

**Linting.** Every save brings the note to the house style: a run of blank lines
becomes one, the top and bottom of the file lose theirs, the file ends in a
single newline, and every fenced code block gets one blank line above and below
it. Nothing inside a code block or a `$$` block is touched, and an edit that
would close up the blank line the cursor is sitting in waits for the next save
instead. It arrives as an ordinary edit, so `⌘Z` steps back over it. **Lint
current file** in the palette (`⌘P`) runs the same rules on the open file holding
nothing back, the blank line under the cursor included. For notes written before
the rules existed, `npm run tidy` applies them to a whole folder from the
terminal — see `--check` above.

## Keys

| | |
|---|---|
| `⌘[` / `⌘]` | Back / forward |
| `⌘T` / `⌘W` / `⌘⇧T` | New tab / close tab / reopen the last closed |
| `⌥⌘←` `⌥⌘→` `⌃⇥` | Between tabs |
| `⌥`-click a link | Open it in the side pane |
| `⌘O` | Jump to a note (`#` for a heading) |
| `⌘⇧E` | Outline tab in the sidebar |
| `⌘,` | Settings |
| `⌘P` | Command palette |
| `⌘⇧F` | Search the vault |
| `⌘F` | Find in note |
| `⌘N` / `⌘⇧N` | New note / folder |
| `⌘E` | Reading view |
| `⌘B` / `⌘\` | Toggle sidebar |
| `⌘⇧L` | Light / dark |
| `⌘⇧B` `⌘I` `⌘K` | Bold, italic, link |
| `⌥↑` / `⌥↓` | Page up / down, in a PDF |
| `+` `-` `0` | Zoom a PDF, and fit it again |
| `⌥←` / `⌥→` | Back / forward, in a website |
| `⌘L` / `⌘R` | Address bar / reload, in a website |

## Layout

```
electron/main.js     window, menus, and every filesystem operation
electron/preload.js  the renderer's only route to the outside world
src/editor.js        CodeMirror setup, theme, and the live-preview decorations
src/renderer.js      app state, tabs, file tree, overlays, reading view
src/headings.js      what counts as a heading, for the outline and for anchors
src/callouts.js      the callout table, for both views
src/blocks.js        what a fenced block becomes when it is not shown as code
src/mermaid.js       diagrams, for both views
src/tikz.js          TikZ pictures — the TeX run, and both views' frames
src/svg.js           svg blocks — read, stripped, drawn, for both views
src/pdf.js           the PDF reader: pages, text selection, and highlights
src/site.js          websites: the address, the guest it loads in, its state
src/transclude.js    a note rendered inside another — embeds and hover previews
src/sidepane.js      the second document, standing beside the one being written
src/settings.js      the settings panel — keys and controls, nothing else
src/lint.js          the markdown rules a note is held to, as edits
src/styles.css       design tokens and all chrome styling
build.mjs            esbuild bundle into dist/
scripts/drive.mjs    evaluates expressions in a running renderer, for testing
scripts/tidy-vault.mjs   the linter over a folder of notes, from the terminal
```

The renderer never touches `fs`. It runs with `contextIsolation` on and
`nodeIntegration` off, and reaches the disk only through the named calls in
`preload.js`; the main process resolves every path against the vault root and
rejects anything that escapes it.

The window shows one document — the app's own page — and never navigates away
from it: every link that is not an in-page anchor is taken over, the web ones
handed to your browser, and the main process refuses a top-level navigation
outright. A vault file is served as a subresource, sandboxed and never as
`text/html`, so a `.html` sitting in a folder someone sent you is a file to be
read rather than a page that runs.

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

## Language learning

Creating a language makes one folder with three portable Markdown files:
`Vocabulary.language.md` for the fixed vocabulary table and flashcards,
`Sounds.md` for letters or combinations and their sounds, and `Grammar.md` for
patterns, examples, and exceptions. The same scaffold is used for every
language; the selected country flag and name live on the folder.
