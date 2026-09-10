#!/bin/bash
# Put the assembled macOS app in the ordinary drag-to-Applications disk image.
# A configured Developer ID signs the image; a configured notary profile also
# submits and staples it, so the downloaded container and the app inside it are
# both Gatekeeper-verifiable.
set -euo pipefail

cd "$(dirname "$0")/.."
APP=${1:-build/Tulip.app}
DMG=${2:-build/Tulip-macos.dmg}
SIGN_IDENTITY=${TULIP_SIGN_IDENTITY:-}
NOTARY_PROFILE=${TULIP_NOTARY_PROFILE:-}

[ -d "$APP" ] || { echo "$APP does not exist — package the app first"; exit 1; }
if [ -n "$NOTARY_PROFILE" ] && [ -z "$SIGN_IDENTITY" ]; then
  echo "TULIP_NOTARY_PROFILE requires TULIP_SIGN_IDENTITY"
  exit 1
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/tulip-dmg.XXXXXX")
cleanup () { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "› staging the disk image"
ditto "$APP" "$STAGE/Tulip.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"

echo "› creating $(basename "$DMG")"
hdiutil create -quiet -volname Tulip -srcfolder "$STAGE" -ov -format UDZO "$DMG"

if [ -n "$SIGN_IDENTITY" ]; then
  echo "› signing the disk image as $SIGN_IDENTITY"
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
  codesign --verify --strict --verbose=2 "$DMG"
fi

if [ -n "$NOTARY_PROFILE" ]; then
  echo "› notarising the disk image"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi

echo "✓ $DMG"
