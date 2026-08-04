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

Drawing on sight means TeX runs on whatever a note contains before anyone has
read it, and a note is not always one you wrote — vaults are synced, shared and
cloned. So TeX is run with command execution refused outright, and a block that
asks to open files is not drawn until you press Draw; two at a time, so a page
of thirty figures does not start thirty of them at once.

**Scenes in three.js.** A ```` ```three ```` block is a 3D scene, and the block
holds only the part worth reading: `scene`, `camera`, `renderer`, `controls`
(OrbitControls, damped), a `lights` group and a `timer` are already built and
sized, so three lines that add a mesh are a whole block. Define
`update(t, dt)` and it is called every frame; call `renderer.setAnimationLoop`
yourself and that loop is the one that runs. Reading view draws the scene where
the code was, when it scrolls into sight; Editing view keeps a Run button
beside the fence. A scene that throws says so, in the block's own space.

The three.js runtime ships with Tulip and is served to the block from the app
itself — nothing is fetched, so a scene draws the same offline, and a note full
of them reaches the network exactly as often as a note full of prose. Scenes
run in the same sandboxed guest a ```` ```html ```` block does: their own
process, no Node, no network at all, and no way back into Tulip or the vault.

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

**Sizing the app.** `⌘+`, `⌘-` and `⌘0` step the window through named sizes, so
a size you liked comes back exactly — everything grows together, because a
window has one size — and the status bar names the size as it changes, then
stands down once you are back at the normal one. The same sizes are in Settings.

Pinching a note does nothing. Two fingers drifting apart mid-scroll is not a
request for a bigger app, and a size arrived at that way is one you cannot ask
for again. Over a PDF or a website the gesture does belong to what is on
screen — those resize themselves, and the app around them does not.

**Settings.** `⌘,` — theme, line width and zoom; autosave delay, spelling and
code line numbers; the timeouts and quality that running a block uses; and the
copilot's own three dials.

**Getting back.** `⌘[` and `⌘]` walk the trail you followed, returning you to
the place in each note you were reading rather than to its top. The side buttons
on a mouse do the same.

**Saving.** Edits autosave 600 ms after you stop typing, and on note switch,
window hide, and quit. The dot beside the note name means unsaved. A copy of
anything typed but not yet saved is kept outside the vault as well, so a crash
or a power cut has something to offer back; it is deleted the moment the real
save lands, and what is left at the next launch is by definition a loss. If a
note changes on disk under an unsaved buffer — a sync client, another editor,
the copilot — the two are folded together, and where they both rewrote the same
lines you are asked which to keep.

**Linting.** Every save brings the note to the house style: a run of blank lines
becomes one, the top and bottom of the file lose theirs, the file ends in a
single newline, and every fenced code block and every heading gets one blank
line above and below it. Heading levels are held to a ladder — `#`, then `##`,
then `###` — so a skipped level is closed up and a note whose headings start at
`##` is pulled up to `#`; climbing back to a shallower level is a new section
rather than a mistake, and headings that were siblings stay siblings.
Nothing inside a code block, a `$$` block or the frontmatter is touched, and an edit that
would close up the blank line the cursor is sitting in waits for the next save
instead. It arrives as an ordinary edit, so `⌘Z` steps back over it. **Lint
current file** in the palette (`⌘P`) runs the same rules on the open file holding
nothing back, the blank line under the cursor included. For notes written before
the rules existed, `npm run tidy` applies them to a whole folder from the
terminal — see `--check` above.

**Export.** **File ▸ Export as PDF…** prints the open note to a file, as the
reading view would draw it on paper: prose, headings in their palette,
callouts, tables, math, diagrams, footnotes, pictures — with the app's chrome
left on the screen where it belongs. A note written under a dark theme still
exports black on white: print has its own palette, and diagrams are drawn
again in it for the file. While that happens a curtain covers the window, so
the colour churn is paperwork, not theatre. A three.js or HTML scene appears
as whatever it has drawn; a playing video or audio does not.

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
| `⌘F` | Find in note, or in the open PDF |
| `⌃⌘S` | Review the cards that are due |
| `⌘N` / `⌘⇧N` | New note / folder |
| `⌘E` | Reading view |
| `⌘B` / `⌘\` | Toggle sidebar |
| `⌘⇧L` | Light / dark |
| `⌘⇧B` `⌘I` `⌘K` | Bold, italic, link |
| `⌥↑` / `⌥↓` | Page up / down, in a PDF |
| `+` `-` `0` | Zoom a PDF, and fit it again |
| `⌘+` `⌘-` `⌘0` | Size the app up, down, back |
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
src/guest.js         a block that is really a page, and the sandbox it runs in
src/htmlrun.js       html blocks — the page the note itself wrote
src/threejs.js       three blocks — the page Tulip writes around a scene
src/threelib.js      the three.js runtime the scene's guest is served
src/pdf.js           the PDF reader: pages, text selection, and highlights
src/site.js          websites: the address, the guest it loads in, its state
src/transclude.js    a note rendered inside another — embeds and hover previews
src/sidepane.js      the second document, standing beside the one being written
src/settings.js      the settings panel — keys and controls, nothing else
src/lint.js          the markdown rules a note is held to, as edits
src/srs.js           when a card comes back — FSRS, and nothing else
src/language-table.js  a language table read as a deck, and the review overlay
src/merge.js         folding two versions of a note together
src/mergepanel.js    what it asks when both sides rewrote the same lines
electron/review-store.js  the schedule, kept in the vault and guarded
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

For anything visual, take the picture rather than reasoning about the CSS —
pass a selector to clip the shot to one piece of chrome:

```bash
CDP_PORT=9333 node scripts/shot.mjs out.png ".reading blockquote"
```

Note that a focus event only fires when the window itself has focus, so a probe
driving an unfocused instance will find that clicking into a table cell does
nothing. Activate the app first.

## Language learning

Creating a language makes one folder with one portable Markdown file:
`Vocabulary.language.md`, where learned words, their meanings, examples, and
notes live together. Existing language-table files remain ordinary, studyable
tables. The selected country flag and name live on the folder.

**Review.** The vocabulary table can be studied — `⌃⌘S`, **View ▸ Review Due
Cards**, or the button on a language table. Each row makes two cards, asked in
both directions and scheduled apart, because reading a language and speaking it
are different things to know. A note can say otherwise in its frontmatter:
`study-front:` and `study-back:` name the columns, and `study-reverse: no` asks
one way only.

Scheduling is FSRS (`src/srs.js`). Two numbers describe a card — how long until
you would forget it, and how stubborn it is — and each answer updates both from
how it went *and* from how likely you were to have remembered it just then, so a
card recalled after a long gap gains far more than the same card recalled
tomorrow. Each button says what it will schedule. A session shows what is
overdue first, then up to twenty cards you have never seen; a card forgotten
eight times is set aside rather than drilled, because it needs rewriting.

What the scheduler remembers lives in the vault — `.tulip/review.json`, with an
append-only log beside it — so it is backed up and synced with the notes it is
about, and it follows a note that is renamed. Nothing prunes it without saying
so: a scan that reports no cards at all, or one that would forget more than a
fifth of the deck, is refused rather than believed.

**When it was learned.** A row receives an added date automatically when its
first two cells become complete, and its edited date changes whenever any cell
in that row changes. Hover a cell, or focus it with the keyboard, to see the
dates. They live in `.tulip/language-history.json`, keyed by stable internal row
ids, so the visible Markdown gains no tracking columns and moving a row does not
give it another word's history. Rows that predate this tracking are not falsely
given the upgrade date: they begin showing an edited date after their next
change, while rows added from then on receive both dates.
