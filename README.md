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
| macOS | 13.0 or later — required by Electron 44 |
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

**Check for updates…** in the command palette asks GitHub for the newest
release. Tulip only contacts GitHub when you ask it to.

On an installed Mac app, a release that supplies a SHA-256 digest for
`Tulip-macos.zip` offers **Install and restart**. Tulip checks the download,
macOS signature and Gatekeeper assessment, bundle identity, version, and CPU
architecture before saving your documents and restarting into the new app.
The previous app remains beside it in Applications. An installation failure is
recorded in `update-install.log` in Tulip's application support folder.

On an installed Windows app the same release offers it for
`Tulip-<version>-win32-x64.zip`: the download digest is checked, the archive
is vetted for paths that would write outside the folder, the version must
match the release, and — where the running copy carries a valid Authenticode
signature — so must the replacement. The swap then happens after Tulip exits
and restores the previous folder if it cannot finish. The previous folder is
kept beside the app.

Unsigned builds of either platform, releases without a digest, and Linux
offer the download link. You can also update by pulling and re-running the
build script.

### Downloads

Every push builds both platforms and keeps the result for 30 days: open the
run under **Actions** and take `Tulip-macos` or `Tulip-windows` from its
artifacts. Tagging a commit `v0.1.26` publishes the same two builds as a
GitHub release.

Tagged builds use the signing secrets configured for the repository. If those
secrets are absent, CI still proves and publishes an ad-hoc/unsigned fallback
and the release notes say what the receiving machine will report. See
**Distributing a build** below for the local equivalent.

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
./scripts/package-dmg.sh                  # signed/notarised when those vars remain set

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

Every window remembers its own tabs, pinned tabs, reading locations, side
pane, and window position. All open windows return after quitting and relaunching.
Each window also has its own Copilot conversations; closing one stops its
Copilot sessions without stopping another window's work.

**Save workspace…** stores the current windows under a name such as Research.
**Open workspace…** saves your documents before replacing the current windows
with that arrangement. Named workspaces belong to the current vault.

Use the command palette (⌘P) to find workspace commands, backups, templates,
exports, and keyboard shortcuts.
The keyboard shortcut sheet has a search field.

### Reading beside a document

Choose **Open document beside this one** from the command palette, **Open to the side** from a
file or tab menu, or Option-click a note link. The existing side pane displays a
note or PDF with independent scrolling. Drag its divider to resize it, use
**Swap** to exchange the main and side documents, or close it with its × button.
Its width and reading position return with the window's session.

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

Python, Rust, JavaScript / TypeScript, Go and Julia blocks have a managed
package environment for each note. Write normal `import` / `use` / `using`
statements and click Run: Tulip installs a missing external package and retries.
The runtime and native package manager must already be installed. Other code
languages continue to use their installed tools without automatic packages.

**Manage code packages…** in the command palette opens the current note's
installed versions, with Add, Update,
Remove, Reset and Export environment. The optional import-name field remembers
packages whose import name differs from their registry name. Settings → Documents
→ Code packages controls automatic installation and lists environments by note.
Generated projects, packages and lockfiles stay in Tulip’s application data,
not the vault. Python inline dependency declarations remain supported.

Missing local modules and unsupported imports remain errors. When a registry
cannot resolve a name, use Manage code packages… to select the distribution explicitly.
Automatic retries may execute the code preceding the failed import again.
Versions are retained between runs; exporting the environment records the native
manifests and locks for sharing (Tulip does not yet import environment exports).

## Switching vaults

The vault name at the top of the sidebar opens a list of the vaults Tulip has
opened before, with **Choose a folder…** at the top for one it has not. Only
folders already on that list can be opened from it; anything new goes through
the system's own folder dialog.

## When something goes wrong

### Recovery inbox and vault health

**Recovery inbox…** in the command palette keeps unsaved drafts, failed-save reminders,
and conflicting copies available until resolved. A status-bar button appears when
there is something to review. Closing the inbox preserves its items. Drafts can be
compared with the saved file and restored as a separate copy; the original is kept.
Each window keeps its own crash draft, and continuous typing checkpoints it rather
than indefinitely delaying recovery. A force quit can still lose typing since the
last checkpoint.

**Vault health report…** checks local note links, missing embeds and bibliography
references. Open an issue at its source, or preview and apply a replacement for a
single wiki reference. A changed file is refused until previewed again. The report
skips code examples and remote URLs; it does not validate in-page headings or delete
files. Closing a running scan cancels it between batches.

### Backups

**Back up vault…** and **Restore vault…** are available in the command palette and
the File menu. A backup is a readable folder containing the vault's notes,
attachments, annotations, review data, and vault-local history. Tulip verifies every file with
SHA-256 before completing a backup or restore, and restores into a new vault rather
than overwriting the current one.

**Backups and recovery…** in the command palette shows the last completed
backup and any failure. Choose a destination outside the vault, a daily or
weekly schedule, and retention of 7, 14, or 30 automatic backups. Scheduling runs
while Tulip is open and catches up on an overdue backup. An unavailable drive
leaves existing backups intact and retries later. Retention removes only older
copies created by that vault's scheduler, after a new copy passes verification.
Use **Browse backups** to inspect them or **Restore…** to recover into a new vault.

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
npm run bench:session -- --check # repeated mixed-document sessions, retained heap and idle activity
```

The lint rules are few and every one of them fires only on a defect — including
one written for this codebase, `tulip/consistent-optional-chaining`, after three
launch-time crashes got through. `npm run typecheck` (`tsc --checkJs` under
`strictNullChecks`) is clean across the whole tree, and `typecheck:gate` holds
it there: every module is on its clean list at a ceiling of zero, so a new
null-safety finding fails the build. tsconfig.json says why that check exists.

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

macOS and Windows are the supported platforms. `npm run app:linux` assembles a
portable Linux folder for anyone who wants to try one, but it is not built,
smoke-tested or updated by CI, and the updater has no Linux package to offer
it — treat it as a build recipe rather than a third platform.

Tulip is licensed under the [MIT License](LICENSE).

## Reviewing and researching with Copilot

The Copilot composer has **Context**, **Instructions**, and **Find chat** controls.
Context previews the open document and selected passage, shows when the excerpt
is shortened, and lets you exclude either or pin up to eight reference notes or
PDFs. These choices belong to the conversation and return when it is reopened.
Attachments remain removable in the composer. Changing context affects future
messages; earlier messages remain part of the conversation.

Instructions opens editable, reusable prompts. **Use in composer** prepares a
message for you to review before sending. Find chat searches questions, answers,
and file changes in the current note's saved conversations, with bookmarks for
up to thirty useful messages per conversation.

Copilot edits are applied before review. In a turn's **Diff**, choose
**Choose sections…** to keep or reject individual changes in a text file and
preview the resulting content before saving. A file changed since that turn is
refused so newer edits remain intact. **Resume request** on a stopped turn, or a
failed turn with completed steps, asks Copilot to inspect current files and
continue the original request without repeating completed work.

PDF citations and `[[Note#Heading]]` or `[[Note#^block-id]]` references open a
source passage preview. **Open source** jumps to the cited location. PDF previews
use existing extracted text when available, otherwise read only the requested
page without creating a text sidecar; scanned pages may need the source viewer.
Ranked vault search is available to Copilot in Read, Ask, and Auto through a
local read-only tool. It supports the same filters and indexed PDF text as the
app's search.

The recovery inbox's **Merge selected changes…** compares a recovered version
with the current file and saves your chosen result. A changed file must be
previewed again before saving; the recovered conflict copy is preserved.
Search filters offer a value field (and folder suggestions), and selecting a
search result shows its surrounding passage. Back and forward now also revisit
heading jumps, source citations, and search locations within the same document.
Vault health checks links to headings and blocks in indexed Markdown notes.

### Recover one document

**Recover this document…** in the command palette or a text document's tab/file
menu brings together saved versions, backup copies, and unresolved drafts or
conflicts for that document. Expand a saved version or backup to compare its
text. Restoring a saved version keeps a restore point; restoring a backup or a
draft creates a separate copy and preserves the current file. **Show recovery
for all documents** returns to the full inbox.

Backup copies come from the vault's recorded manual and automatic backups.
Unavailable drives and documents absent from a backup are labelled. A selected
backup file is checked against its SHA-256 digest before comparison or restore.
Text comparison supports UTF-8; other encodings can be restored as a separate
copy. For files over 32 MB or backups from another location, use the full-vault
restore available in the same panel.

The mixed-document session benchmark checks actual rendered PDF pages, typing
frames below 50 ms, document-switch p95 below 500 ms, retained heap growth below
20 MB over 20 cycles, and idle renderer activity below 5%. These are regression
limits on the test fixtures, rather than guarantees for every vault or machine.
