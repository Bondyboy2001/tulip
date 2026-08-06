<p align="center">
  <img src="assets/tulip.svg" width="112" height="112" alt="Tulip logo">
</p>

<h1 align="center">Tulip</h1>

<p align="center">
  A calm, local-first workspace for notes, papers, and study.
</p>

Tulip is a Markdown editor built with Electron and CodeMirror. Your vault is an
ordinary folder: notes stay as portable files on disk, with no database and no
lock-in.

## Highlights

- Write in focused Editing, Reading, or Raw views.
- Link and embed notes with `[[wikilinks]]`, backlinks, tabs, and a live outline.
- Keep Markdown, PDFs, websites, whiteboards, and TeX documents together.
- Read and edit Jupyter notebooks as cells, with their saved outputs, plots and
  tracebacks — no kernel, so nothing is run.
- Search the whole vault and work with an optional AI copilot.
- Build language-learning tables and review them with spaced repetition.
- Start notes from a `templates/` folder, and click any `#tag` to find its notes.
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

## Development

```bash
npm run dev       # rebuild on source changes
npm run app       # build and install the macOS app
npm run lint      # ESLint — must stay clean; see eslint.config.mjs
npm test          # run the test suite
npm run verify    # lint, tests, production build, and staging checks
npm run typecheck # tsc --checkJs, a report rather than a gate; see tsconfig.json
npm audit         # must stay clean; see the overrides in package.json
```

The lint rules are few and every one of them fires only on a defect — including
one written for this codebase, `tulip/consistent-optional-chaining`, after three
launch-time crashes got through. `npm run typecheck` is deliberately outside
`verify`: it reports around two thousand findings today, of which the useful
third are null-safety, and tsconfig.json says what to do about that.

CI runs the suite, the production build and the audit on macOS and Windows, and
packages both, on every push.

## Not planned

Tulip is deliberately smaller than the apps it resembles. There is no graph
view, no kanban board, no calendar or daily notes, and no Markdown/HTML vault
export (PDF export exists, under **Export as PDF…**).

There is one window and one vault open at a time, and the sidebar splits in two
and no further. Tulip makes no network request unless asked: the only one it can
make on its own behalf is **Check for updates…**, and nothing runs it but you.

Tulip is licensed under the [MIT License](LICENSE).
