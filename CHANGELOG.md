# Changelog

Notable changes, newest first. Versions follow [semantic
versioning](https://semver.org); while Tulip is pre-1.0, minor versions may
carry breaking changes and patch versions will not.

## Unreleased

### Added

- Tulip checks for updates and installs them. Previously every copy stayed on
  whatever version it was downloaded as, even though the release workflow had
  been publishing the update metadata all along. **Check for Updates…** is in
  the app menu on macOS and under File on Windows.
- Unsaved text is written out when something goes wrong. An uncaught error or
  an unhandled rejection now flushes the draft immediately instead of leaving
  the buffer ahead of both the file and the draft, and a renderer that dies
  outright reloads rather than leaving a dead window.
- Code signing and notarization are configured throughout, and turn themselves
  on as soon as the certificates exist. Builds are still unsigned until then —
  see [CONTRIBUTING.md](CONTRIBUTING.md#signing).
- ESLint and per-file type checking, both in `npm run verify` and in CI.
- Dependabot, and an `npm audit` gate that fails CI on a high-severity
  advisory.

### Changed

- `npm test` finds its tests rather than listing them, runs them in parallel,
  and reports every failure instead of stopping at the first. One suite —
  `test-agent-diff` — had never run in CI at all.
- CI gained a Linux leg, which is cheaper and faster than the macOS and Windows
  runners it now precedes.
- The README described a macOS-only app; Windows builds have shipped for a
  while.

### Fixed

- Updated `pdfjs-dist` past GHSA-hq66-cqwq-w95j (arbitrary JavaScript execution
  on opening a malicious PDF) and `mermaid` past three advisories of its own.
  Neither was exploitable through Tulip's own paths — `isEvalSupported` is off
  and the page CSP has no `unsafe-eval` — but nothing would have reported the
  next one.
- Twenty-five defects the new linter found, including six promise executors
  whose return value was being read and two thrown errors that dropped their
  cause.

### Removed

- The `extensions:list` IPC channel, which handed the renderer the raw source
  of every file in `.tulip/extensions/`. The sandbox its own comments promised
  did not exist and nothing consumed it.

## 0.1.1

The first tagged release, with macOS and Windows builds.
