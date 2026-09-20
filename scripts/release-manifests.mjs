/* ================================================== release-manifests.mjs
   The package-manager manifests a tag produces.

   A Homebrew cask and the three winget manifests are only ever restatements
   of a GitHub release — the version in its tag, the assets CI already built
   and verified, and their checksums — so they are generated here from those
   artifacts rather than maintained by hand somewhere they can drift.

   Usage:

     node scripts/release-manifests.mjs --dir artifacts --out manifests

   `--dir` is where the release job has downloaded the two package artifacts:

     artifacts/Tulip-macos/Tulip-macos.dmg
     artifacts/Tulip-windows/Tulip-<version>-win32-x64.zip

   What lands in `--out`:

     Casks/tulip.rb                                   for a homebrew-tap repo
     winget/Tulip.Tulip.yaml                          version manifest
     winget/Tulip.Tulip.installer.yaml                the zip, as a portable app
     winget/Tulip.Tulip.locale.en-US.yaml             the one locale it speaks

   The winget files are a *submission*, not an install: winget's manifests live
   in microsoft/winget-pkgs, so these are attached to the release for whoever
   opens that PR — or installed locally with `winget install --manifest`.
   The cask is the same shape for a tap: `Casks/tulip.rb` drops into a
   homebrew-tap repository unchanged.
   ================================================================== */

import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const dir = arg('dir', 'artifacts')
const out = arg('out', 'manifests')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const version = (arg('version', '') || pkg.version).replace(/^v/, '')
const owner = arg('owner', 'tulip-notes')
const repo = arg('repo', 'tulip')
const releaseBase = `https://github.com/${owner}/${repo}/releases/download/v${version}`

const sha256 = async (file) =>
  createHash('sha256').update(await readFile(file)).digest('hex')

/* The artifacts, found by shape rather than spelled out — the Windows zip's
   name carries the version and CI names it, so asking the directory is the
   honest way to match it. */
const dmg = path.join(dir, 'Tulip-macos', 'Tulip-macos.dmg')
const winDir = path.join(dir, 'Tulip-windows')
const winZipName = (await readdir(winDir)).find((name) => name.endsWith('.zip'))
if (!winZipName) throw new Error(`No .zip under ${winDir} — has the Windows package artifact been downloaded here?`)
const winZip = path.join(winDir, winZipName)

const [dmgHash, winHash] = await Promise.all([sha256(dmg), sha256(winZip)])

/* ------------------------------------------------------------------ cask */

const cask = `cask "tulip" do
  version "${version}"
  sha256 "${dmgHash}"

  url "${releaseBase}/Tulip-macos.dmg"
  name "Tulip"
  desc "A calm, local-first workspace for notes, papers, and study"
  homepage "https://github.com/${owner}/${repo}"

  app "Tulip.app"
end
`

/* ----------------------------------------------------------------- winget */

const wingetVersion = `\
# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.10.0.schema.json
PackageIdentifier: Tulip.Tulip
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.10.0
`

const wingetInstaller = `\
# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.10.0.schema.json
PackageIdentifier: Tulip.Tulip
PackageVersion: ${version}
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
  - RelativeFilePath: Tulip.exe
    PortableCommandAlias: tulip
Installers:
  - Architecture: x64
    InstallerUrl: ${releaseBase}/${winZipName}
    InstallerSha256: ${winHash}
ManifestType: installer
ManifestVersion: 1.10.0
`

const wingetLocale = `\
# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.10.0.schema.json
PackageIdentifier: Tulip.Tulip
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${owner}
PackageName: Tulip
License: Proprietary
ShortDescription: A calm, local-first workspace for notes, papers, and study
Moniker: tulip
Tags:
  - markdown
  - notes
  - local-first
ManifestType: defaultLocale
ManifestVersion: 1.10.0
`

await mkdir(path.join(out, 'Casks'), { recursive: true })
await mkdir(path.join(out, 'winget'), { recursive: true })
await writeFile(path.join(out, 'Casks', 'tulip.rb'), cask)
await writeFile(path.join(out, 'winget', 'Tulip.Tulip.yaml'), wingetVersion)
await writeFile(path.join(out, 'winget', 'Tulip.Tulip.installer.yaml'), wingetInstaller)
await writeFile(path.join(out, 'winget', 'Tulip.Tulip.locale.en-US.yaml'), wingetLocale)

console.log(`release manifests for v${version} written to ${out}/`)
console.log(`  dmg sha256: ${dmgHash}`)
console.log(`  zip sha256: ${winHash}`)
