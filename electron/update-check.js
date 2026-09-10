'use strict'

/* The update boundary is deliberately read-only: it interprets GitHub's
 * latest-release response and returns a release or asset URL. Downloading and
 * replacing Tulip remain explicit user actions in the renderer. Keeping the
 * network contract here also removes one more self-contained concern from the
 * main-process monolith. */

const { installAsset } = require('./update-install')

const RELEASES_URL = 'https://api.github.com/repos/Bondyboy2001/tulip/releases/latest'

/** `v0.1.26` and `0.1.26` alike, as numbers, so they can be compared. */
function versionParts (text) {
  return String(text).replace(/^v/, '').split('.').map((part) => parseInt(part, 10) || 0)
}

/** Whether `candidate` is a later version than `current`. */
function isNewer (candidate, current) {
  const a = versionParts(candidate)
  const b = versionParts(current)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0)
  }
  return false
}

/** Prefer the artifact the current OS can open directly. A release page is
 * always retained as the fallback for older releases with no named assets. */
function downloadAsset (release, platform, arch) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const usable = assets.filter((asset) => asset?.name && asset?.browser_download_url)
  const ranked = usable.map((asset) => {
    const name = String(asset.name).toLowerCase()
    let score = 0
    if (platform === 'darwin') {
      if (name.endsWith('.dmg')) score += 100
      if (/mac|darwin|osx/.test(name)) score += 50
    } else if (platform === 'win32') {
      if (name.endsWith('.zip')) score += 80
      if (/windows|win32|win64/.test(name)) score += 60
      if (arch && name.includes(String(arch).toLowerCase())) score += 10
    }
    return { asset, score }
  }).filter(({ score }) => score >= 100)
    .sort((left, right) => right.score - left.score)
  return ranked[0]?.asset || null
}

async function checkForUpdate ({ current, fetch, platform = process.platform, arch = process.arch }) {
  let latest
  try {
    const response = await fetch(RELEASES_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `Tulip/${current}`
      }
    })
    if (response.status === 404) return { ok: true, current, latest: null, newer: false }
    if (!response.ok) return { ok: false, current, reason: `GitHub answered ${response.status}` }
    latest = await response.json()
  } catch (error) {
    return {
      ok: false,
      current,
      reason: error instanceof Error ? error.message : 'the network could not be reached'
    }
  }

  const tag = String(latest?.tag_name || '')
  if (!tag) return { ok: true, current, latest: null, newer: false }
  const asset = downloadAsset(latest, platform, arch)
  return {
    ok: true,
    current,
    latest: tag.replace(/^v/, ''),
    newer: isNewer(tag, current),
    canInstall: !!installAsset(latest, platform),
    url: String(latest?.html_url || ''),
    downloadUrl: asset ? String(asset.browser_download_url) : '',
    downloadName: asset ? String(asset.name) : '',
    notes: String(latest?.body || '').slice(0, 2000)
  }
}

module.exports = { checkForUpdate, downloadAsset, isNewer }
