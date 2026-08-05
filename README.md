<p align="center">
  <img src="assets/tulip.svg" width="112" height="112" alt="Tulip logo">
</p>

<h1 align="center">Tulip</h1>

<p align="center">
  A calm, local-first workspace for notes, papers, and study.
</p>

Tulip is a macOS Markdown editor built with Electron and CodeMirror. Your vault
is an ordinary folder: notes stay as portable files on disk, with no database
and no lock-in.

## Highlights

- Write in focused Editing, Reading, or Raw views.
- Link and embed notes with `[[wikilinks]]`, backlinks, tabs, and a live outline.
- Keep Markdown, PDFs, websites, whiteboards, and TeX documents together.
- Search the whole vault and work with an optional AI copilot.
- Build language-learning tables and review them with spaced repetition.

## Run Tulip

```bash
git clone https://github.com/Bondyboy2001/tulip.git
cd tulip
npm install
npm start
```

To build and install the macOS app locally:

```bash
./scripts/build-app.sh
```

## Essential shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘O` | Open a note |
| `⌘P` | Command palette |
| `⌘N` | New note |
| `⌘1` / `⌘2` / `⌘3` | Reading / Editing / Raw |
| `⌘⇧F` | Search the vault |
| `⌘⇧A` | Toggle Copilot |

## Development

```bash
npm run dev       # rebuild on source changes
npm run app       # launch the existing build
npm test          # run the test suite
npm run verify    # tests, production build, and staging checks
```

Tulip is licensed under the [MIT License](LICENSE).
