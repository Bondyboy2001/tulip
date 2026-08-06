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
- Search the whole vault and work with an optional AI copilot.
- Build language-learning tables and review them with spaced repetition.
- Start notes from a `templates/` folder, and click any `#tag` to find its notes.

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

There is no auto-updater. Updating means pulling and re-running the build script
above, which replaces the installed app in place.

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

On Windows, use `Ctrl` wherever this table says `⌘`.

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

## Development

```bash
npm run dev       # rebuild on source changes
npm run app       # build and install the macOS app
npm test          # run the test suite
npm run verify    # tests, production build, and staging checks
npm audit         # must stay clean; see the overrides in package.json
```

CI runs the suite, the production build and the audit on macOS and Windows, and
packages both, on every push.

## Not planned

Tulip is deliberately smaller than the apps it resembles. There is no graph
view, no kanban board, no calendar or daily notes, and no Markdown/HTML vault
export (PDF export exists, under **Export as PDF…**).

Tulip is licensed under the [MIT License](LICENSE).
