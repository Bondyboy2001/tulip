<p align="center">
  <img src="assets/tulip.svg" width="112" height="112" alt="Tulip logo">
</p>

<h1 align="center">Tulip</h1>

<p align="center">
  A calm, local-first workspace for notes, papers, and study.
</p>

<p align="center">
  <a href="https://github.com/Bondyboy2001/tulip/actions/workflows/ci.yml"><img src="https://github.com/Bondyboy2001/tulip/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-informational" alt="platform: macOS | Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="node: >=22">
</p>

Tulip is a Markdown editor built with Electron and CodeMirror. Your vault is an
ordinary folder: notes stay as portable files on disk, with no database and no
lock-in.

## Highlights

- Write in focused Editing, Reading, or Raw views.
- Link and embed notes with `[[wikilinks]]`, backlinks, tabs, and a live outline.
- Keep Markdown, PDFs, websites, whiteboards, and TeX documents together.
- Read, edit and run Jupyter notebooks as cells — execution happens on a real
  Jupyter kernel when one is installed, and the file's saved outputs, plots and
  tracebacks render either way.
- Search the whole vault and work with an optional AI copilot.
- Build language-learning tables and review due words across the vault with spaced repetition.
- Study portable multiple-choice flashcards from ordinary Markdown callouts.
- Start notes from a `templates/` folder, and click any `#tag` to find its notes.
- Open an optional Getting Started note, and back up or restore a vault with integrity checks.
- Split the sidebar to keep the file tree and the outline on screen together.
- Open a second window on the same vault, and pin the tabs worth keeping.
- See what studying adds up to under **Review statistics…** in the palette.

## Requirements

| | |
| --- | --- |
| macOS | 12.0 or later — Electron 43 does not run on 11 |
| Windows | 10 or later, x64 |
| Node | 22 or later, to build from source |

## Run Tulip

```bash
git clone https://github.com/Bondyboy2001/tulip.git
cd tulip
npm install
npm start
```

To build and install the app locally:

```bash
./scripts/build-app.sh     # macOS — builds and installs to /Applications
npm run app:win            # Windows — builds build/Tulip-win32-x64/
```

Both are the release path, and only they advance the patch version. `npm start`
and `npm run dev` leave the version alone.

To ship fewer spelling dictionaries and a smaller download, set
`TULIP_SPELL_LANGUAGES` before the build script — `fr,de` carries French and
German, `none` carries none (English is built in either way). Unset carries all
fifteen, which stays the default because the app works offline and cannot fetch
a dictionary later; a language left out is shown as "not in this build" in
Settings rather than offered.

### Updating

There is no auto-updater, and Tulip never checks for one on its own. **Check for
updates…** in the command palette asks GitHub for the newest release and says
whether this copy is behind it; nothing else in the app makes that request, and
nothing installs anything.

Updating itself means pulling and re-running the build script above, which
replaces the installed app in place — or downloading a build (below) and
replacing `Tulip.app` by hand.

### Downloads

Every push builds both platforms and keeps the result for 30 days: open the
run under **Actions** and take `Tulip-macos` or `Tulip-windows` from its
artifacts. Tagging a commit `v0.1.26` publishes the same two builds as a
GitHub release.

Those builds are ad-hoc signed unless the signing secrets are set, so see
**Distributing a build** below for what the receiving machine will say about
them.

(The bundle does carry `Squirrel.framework`, `Mantle.framework` and
`ReactiveObjC.framework`, which exist for an updater Tulip does not use. They
cannot simply be deleted — `Electron Framework` links against all three, so
removing them stops the app launching.)

### Distributing a build

Both platforms sign ad-hoc by default, which is fine for the machine that built
it and refused everywhere else. To make a build others can open, set the signing
environment before running the script:

```bash
# macOS — signs, notarises and staples
export TULIP_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export TULIP_NOTARY_PROFILE="tulip"      # from `notarytool store-credentials`
./scripts/build-app.sh

# Windows — signs with signtool
set TULIP_WIN_CERT=C:\path\to\cert.pfx
set TULIP_WIN_CERT_PASSWORD=…
npm run app:win
```

Without a Developer ID, a copy of the macOS app that has been downloaded is
blocked as "unidentified developer" or "damaged". The receiving machine can get
past it with `xattr -cr /Applications/Tulip.app`, but signing is the real fix.

## Essential shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘O` | Quick switcher — jump to a note by name (not a file dialog) |
| `⌘P` | Command palette |
| `⌘N` | New note |
| `⌘1` / `⌘2` / `⌘3` | Reading / Editing / Raw |
| `⌘⇧F` | Search the vault |
| `⌘⇧A` | Toggle Copilot |
| `⌘⌥N` | New window |

On Windows, use `Ctrl` wherever this table says `⌘`.

## Tabs and windows

Right-clicking a tab offers **Pin tab**, which moves it to the front of the
strip and takes away its close ×, and **Close others** and **Close to the
right**, neither of which touches a pinned tab. Pinned tabs come back the next
time Tulip starts.

**New window** (`⌘⌥N`, or the Window menu) opens a second window on the same
vault; **Open in new window** on a tab or a file does the same with that
document already showing. Both windows are the same app on the same notes — an
edit in one appears in the other.

Two things belong to the first window only. It is the one whose tabs are
remembered, so a second window opened to read one note cannot replace the strip
you left behind; and it is the one that holds the copilot, because the CLI
session and the saved transcripts are one per vault and two windows writing them
would overwrite each other. The copilot's button is hidden in a second window
rather than half-working there.

## Templates

A note in a `templates/` folder at the root of the vault is a template. **Insert
template…** in the command palette puts one in at the caret, expanding three
placeholders on the way:

| | |
| --- | --- |
| `{{title}}` | the name of the note being written into |
| `{{date}}` | today, as `2026-08-06` |
| `{{time}}` | now, as `14:30` |

Templates are ordinary notes, so a vault carried to another app keeps them as
readable files.

## Running code

Tulip runs fenced code blocks — `sh`, `python`, `node` and others — as real
programs, with your own access to your files and network. The first time a vault
asks to run one, Tulip asks you first, and can remember the answer for that
vault. Only trust vaults whose notes you wrote: notes that arrive shared, synced
or downloaded can carry code you did not.

## Switching vaults

The vault name at the top of the sidebar opens a list of the vaults Tulip has
opened before, with **Choose a folder…** at the top for one it has not. Only
folders already on that list can be opened from it; anything new goes through
the system's own folder dialog.

## When something goes wrong

### Backups

**Back up vault…** and **Restore vault…** are available in the command palette and
the File menu. A backup is a readable folder containing the vault's notes,
attachments, annotations, review data, and vault-local history. Tulip verifies every file with
SHA-256 before completing a backup or restore, and restores into a new vault rather
than overwriting the current one.

If Tulip ever says something went wrong, the palette has the two things worth
doing about it. **Reveal crash log** opens the folder holding `crash.log`, which
is where every failure in either half of the app is written with a timestamp —
and which says so plainly when nothing has ever failed. **Copy diagnostics**
puts the versions, the platform and the tail of that log on the clipboard, ready
to paste into a report.

Neither sends anything anywhere. The diagnostics describe the vault by its shape
— how many notes, how much text — and never by its path, so what you paste does
not carry your folder names with it.

## Development

```bash
npm run dev       # rebuild on source changes
npm run app       # build and install the macOS app
npm run lint      # ESLint — must stay clean; see eslint.config.mjs
npm test          # run the test suite
npm run verify    # lint, tests, production build, and staging checks
npm run typecheck # tsc --checkJs, a report rather than a gate; see tsconfig.json
npm audit         # must stay clean; see the overrides in package.json
npm run bench     # markdown render; also bench:reading, bench:dom, bench:table
npm run bench:boot # real launches, timed — see bench/boot-bench.mjs
```

The lint rules are few and every one of them fires only on a defect — including
one written for this codebase, `tulip/consistent-optional-chaining`, after three
launch-time crashes got through. `npm run typecheck` is deliberately outside
`verify`: it reports around two thousand findings today, of which the useful
third are null-safety, and tsconfig.json says what to do about that.

The window is served over a `tulip-app://` protocol rather than from `file://`,
for one reason: Chromium keeps no V8 code cache for a `file:` page, so every
launch recompiled the whole editor from source. `TULIP_NO_APP_SCHEME=1` sends it
back to `file://`, which is how `bench:boot` takes both halves of a comparison
from one build. Measure with that rather than by reasoning about bundle size —
bytes have twice now turned out not to predict launch time here.

CI runs the suite, the production build and the audit on macOS and Windows, and
packages both, on every push.

## Not planned

Tulip is deliberately smaller than the apps it resembles. There is no graph
view, no kanban board, and no calendar or daily notes. Export works one note
at a time — **Export as PDF…**, **Export as HTML…** (one self-contained file)
and **Export as Markdown…** (the note with its attachments copied beside it) —
rather than as a whole-vault operation.

There is one vault open at a time, and the sidebar splits in two and no
further. Tulip makes no network request unless asked: the only one it can
make on its own behalf is **Check for updates…**, and nothing runs it but you.

Tulip is licensed under the [MIT License](LICENSE).
