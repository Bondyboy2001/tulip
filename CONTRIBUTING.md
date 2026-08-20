# Contributing to Tulip

Tulip is an Electron app with a CodeMirror editor. The vault is an ordinary
folder of files, and that shapes most of the design: there is no database, no
sync service, and no format that a text editor could not open.

## Getting set up

```bash
git clone https://github.com/Bondyboy2001/tulip.git
cd tulip
npm install
npm start        # build, then launch
```

`npm run dev` rebuilds on change; `npm run app` launches whatever is already
built. Node 24 or newer — the version CI uses, and the one the `engines` field
names.

## Before you open a pull request

```bash
npm run verify   # tests, a production build, and the staging checks
```

`npm run lint` and `npm run typecheck` are the fast pair to run while working;
`verify` includes both. CI runs all of it on Linux, macOS and Windows, and
fails on any dependency advisory rated high or above.

Two suites drive a real Electron window and need a display: `test:table` and
`test:agent-diff`. On a headless Linux machine, put `xvfb-run
--auto-servernum` in front of the command.

## How the code is arranged

| Where | What |
| --- | --- |
| `electron/main.js` | The main process: filesystem, IPC, menus, subprocesses |
| `electron/preload.js` | The renderer's entire view of the outside world |
| `src/renderer.js` | The window: tabs, tree, panes, and everything that draws |
| `src/editor.js` | The CodeMirror instance and its extensions |
| `build.mjs` | esbuild, staged so a failed build cannot replace a good one |
| `scripts/` | Tests, benchmarks, and the local packaging script |

Two rules are worth knowing before touching the boundary between the first two:

- **The preload adds no generic escape hatch.** Every call across the bridge is
  named and shaped, so the main process stays the only thing that can reach the
  filesystem. A new capability is a new named call, never a passthrough.
- **Every path from the renderer goes through `safePath`.** A path that has not
  been resolved and checked against the open vault does not reach `fs`.

## Comments

The existing comments explain *why*, at the points where the reason cannot be
recovered from the code — why the PDF worker fetches over the app's own scheme,
why copying goes through Electron's clipboard rather than the page's. This is
the house style and it is worth keeping. A comment restating what the line
already says is the one kind not to add.

## Releasing

Tag a version and push it; `.github/workflows/release.yml` packages macOS and
Windows and creates the GitHub release.

### Signing

**Releases are currently unsigned.** macOS Gatekeeper refuses to open an
unsigned, un-notarized app downloaded from the internet — the message says the
app "is damaged and can't be opened", which is misleading but final — and
Windows SmartScreen warns. Automatic updates also cannot install an unsigned
build, so `electron-updater` will report a release it cannot apply.

Everything except the certificates is already in place. The workflow turns
signing on by itself once these repository secrets exist, and stays on the
unsigned path until then:

| Secret | What it is |
| --- | --- |
| `MAC_CERTIFICATE` | Developer ID Application certificate, `.p12`, base64-encoded |
| `MAC_CERTIFICATE_PASSWORD` | The password that `.p12` was exported with |
| `APPLE_ID` | The Apple ID that owns the Developer Program membership |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | The 10-character team identifier |
| `WINDOWS_CERTIFICATE` | Authenticode code-signing certificate, `.pfx`, base64-encoded |
| `WINDOWS_CERTIFICATE_PASSWORD` | The password that `.pfx` was exported with |

Notarization is switched on in the same step, but only when `APPLE_ID` is set:
asking for it without an Apple ID fails the build, so it is added to the
packaging command rather than declared in `package.json`.

The hardened runtime is required for notarization and is already configured, as
are the three entitlements it makes necessary — JIT and unsigned executable
memory, which every Electron app needs, and library validation, which fenced
code blocks need in order to spawn the interpreters the user has installed.
They are in `build/entitlements.mac.plist`, with an account of why each one is
there.

Until certificates exist, tell people downloading a macOS build to run:

```bash
xattr -dr com.apple.quarantine /Applications/Tulip.app
```

## Reporting a bug

Say what you did, what happened, and what you expected instead — plus your
platform and the version from **Tulip → About**. If it involves a particular
note, the smallest Markdown that reproduces it is worth more than a screenshot.
