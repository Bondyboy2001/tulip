<p align="center">
  <img src="assets/tulip.svg" width="112" height="112" alt="Tulip logo">
</p>

<h1 align="center">Tulip</h1>

<p align="center">
  A calm, local-first workspace for notes, papers, and study.
</p>

Tulip is a Markdown editor for macOS and Windows, built with Electron and
CodeMirror. Your vault is an ordinary folder: notes stay as portable files on
disk, with no database and no lock-in.

## Highlights

- Write in focused Editing, Reading, or Raw views.
- Link and embed notes with `[[wikilinks]]`, backlinks, tabs, and a live outline.
- Keep Markdown, PDFs, websites, whiteboards, and TeX documents together.
- Search the whole vault and work with an optional AI copilot.
- Build language-learning tables and review them with spaced repetition.

## Install

Download the latest build for your platform from the
[releases page](https://github.com/Bondyboy2001/tulip/releases/latest) — a
`.dmg` for macOS, an installer or a `.zip` for Windows.

> **Builds are not yet code-signed.** macOS will say the app "is damaged and
> can't be opened", which means only that it has no signature it recognises.
> Until that changes, install it and then run:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/Tulip.app
> ```
>
> Windows SmartScreen will warn for the same reason: choose **More info →
> Run anyway**. Signing everything except the certificates is already in place;
> see [CONTRIBUTING.md](CONTRIBUTING.md#signing).

## Run from source

```bash
git clone https://github.com/Bondyboy2001/tulip.git
cd tulip
npm install
npm start
```

Node 24 or newer. To build a macOS `.app` and install it locally:

```bash
./scripts/build-app.sh
```

For an installer on either platform, `npm run package:mac` or
`npm run package:win`.

## Essential shortcuts

| Action | macOS | Windows |
| --- | --- | --- |
| Open a note | `⌘O` | `Ctrl+O` |
| Command palette | `⌘P` | `Ctrl+P` |
| New note | `⌘N` | `Ctrl+N` |
| Reading / Editing / Raw | `⌘1` / `⌘2` / `⌘3` | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` |
| Search the vault | `⌘⇧F` | `Ctrl+Shift+F` |
| Toggle Copilot | `⌘⇧A` | `Ctrl+Shift+A` |

## Development

```bash
npm run dev         # rebuild on source changes
npm run app         # launch the existing build
npm test            # the whole suite, in parallel
npm run lint        # ESLint
npm run typecheck   # types, for the files that opt in
npm run verify      # all of the above, plus a production build
```

[CONTRIBUTING.md](CONTRIBUTING.md) has how the code is arranged, how to add a
test, and what the release process needs.

Tulip is licensed under the [MIT License](LICENSE).
