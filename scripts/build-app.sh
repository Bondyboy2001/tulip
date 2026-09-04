#!/bin/bash
# =========================================================== build-app.sh
# Packages Tulip into /Applications/Tulip.app.
#
#   ./scripts/build-app.sh            build and install
#   ./scripts/build-app.sh --no-install   leave it in build/ only
#
# Hand-rolled rather than electron-builder: the whole job is copying the
# Electron bundle, swapping in our payload, our Info.plist and our icon, then
# re-signing. That is a page of shell against a large dependency tree, and it
# uses only what macOS already ships (sips, iconutil, codesign, lsregister).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
BUILD=$ROOT/build
APP=$BUILD/Tulip.app
ELECTRON=$ROOT/node_modules/electron/dist/Electron.app
IDENTIFIER=com.hb.tulip

[ -d "$ELECTRON" ] || { echo "electron is not installed — run npm install"; exit 1; }

echo "› bundling the renderer"
# `--release` is what advances the patch version, and this script is the only
# caller that passes it: packaging is the release boundary, `npm start` is not.
# Trimmed dictionaries: `TULIP_SPELL_LANGUAGES=fr,de ./scripts/build-app.sh`
# (or `=none`) shrinks the ~16MB of Hunspell dictionaries to the named
# languages. Unset builds all fifteen, which stays the default because the app
# runs offline and cannot fetch a dictionary later. The variable needs no
# forwarding here — the environment passes it to build.mjs untouched; see
# SPELL_LANGUAGE_IDS there.
node build.mjs --release

# Read after the build, not before: the build has just advanced the version, and
# the bundle should say what the source tree now says rather than lag it by one.
VERSION=$(node -p "require('./package.json').version")

echo "› drawing the icon"
"$ROOT/node_modules/.bin/electron" scripts/make-icon.cjs > /dev/null

echo "› building the iconset"
ICONSET=$BUILD/Tulip.iconset
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
# iconutil wants every size named exactly this way; the @2x entries are the
# same pixel dimensions as the next size up, under a different name.
for size in 16 32 128 256 512; do
  sips -z $size $size "$BUILD/icon.png" --out "$ICONSET/icon_${size}x${size}.png" > /dev/null
  sips -z $((size * 2)) $((size * 2)) "$BUILD/icon.png" \
       --out "$ICONSET/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/Tulip.icns"

echo "› assembling the bundle"
rm -rf "$APP"
cp -R "$ELECTRON" "$APP"

# The executable's name is what shows in Activity Monitor and in the crash
# reporter, so it is renamed rather than left as "Electron".
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Tulip"
rm -f "$APP/Contents/Resources/electron.icns"
cp "$BUILD/Tulip.icns" "$APP/Contents/Resources/Tulip.icns"
rm -rf "$APP/Contents/Resources/default_app.asar"

# Squirrel.framework, Mantle.framework and ReactiveObjC.framework look like dead
# weight — Tulip has no autoUpdater, so no Tulip code can reach them. They are
# NOT removable: `Electron Framework` hard-links all three (LC_LOAD_DYLIB, not
# weak — check with `otool -L`), so deleting them makes dyld kill the app at
# launch. Removing them means patching load commands out of a binary that is
# then signed, which is a far worse trade than 760 KB. Leave them.

# Electron runs Contents/Resources/app/package.json's "main". Only the three
# things that file reaches are copied: everything the renderer needs is already
# bundled into dist/ by esbuild, so no node_modules travel with the app.
PAYLOAD=$APP/Contents/Resources/app
mkdir -p "$PAYLOAD"
cp -R "$ROOT/electron" "$PAYLOAD/electron"
cp -R "$ROOT/dist" "$PAYLOAD/dist"
node -e '
  const pkg = require("./package.json")
  const { name, version, description, main, license } = pkg
  require("fs").writeFileSync(
    process.argv[1],
    JSON.stringify({ name, version, description, main, license }, null, 2)
  )
' "$PAYLOAD/package.json"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Tulip</string>
  <key>CFBundleDisplayName</key><string>Tulip</string>
  <key>CFBundleExecutable</key><string>Tulip</string>
  <key>CFBundleIdentifier</key><string>$IDENTIFIER</string>
  <key>CFBundleIconFile</key><string>Tulip</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <!-- Electron 43 does not run on macOS 11; claiming it only turns a clear
       "requires macOS 12" into a launch that dies without saying why. -->
  <key>LSMinimumSystemVersion</key><string>12.0.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSRequiresAquaSystemAppearance</key><false/>
  <key>NSHumanReadableCopyright</key><string>MIT</string>
  <!-- Alternate rank on purpose: Tulip appears under "Open With" for markdown
       without taking the association away from whatever owns it today. -->
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Markdown Document</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>net.daringfireball.markdown</string>
        <string>public.plain-text</string>
      </array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>CSV Document</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>public.comma-separated-values-text</string>
      </array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>PDF Document</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>com.adobe.pdf</string>
        <string>public.pdf</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST

# An edited bundle fails Gatekeeper's signature check on Apple Silicon and dies
# on launch as "damaged", so it always gets signed. WHICH signature depends on
# whether this machine has a Developer ID to hand:
#
#   TULIP_SIGN_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"
#   TULIP_NOTARY_PROFILE  a `notarytool store-credentials` profile name
#
# With neither, the signature is ad-hoc: fine for the app this script installs
# locally, but `spctl -a` rejects an ad-hoc bundle that has been downloaded, so
# a copy sent to anyone else is refused as "unidentified developer". With the
# identity it is distributable; with the profile as well it is notarised and
# stapled, so it opens on a machine that has never seen it and has no network.
SIGN_IDENTITY=${TULIP_SIGN_IDENTITY:-}
NOTARY_PROFILE=${TULIP_NOTARY_PROFILE:-}

# The hardened runtime is required for notarisation, and Electron cannot run
# under it without these three: V8 writes and then executes JIT pages, and
# Electron's own launcher reads DYLD_ environment variables.
ENTITLEMENTS=$BUILD/entitlements.plist
cat > "$ENTITLEMENTS" <<'ENTS'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
</dict>
</plist>
ENTS

if [ -z "$SIGN_IDENTITY" ]; then
  echo "› signing (ad-hoc — set TULIP_SIGN_IDENTITY to make a distributable app)"
  codesign --force --deep --sign - "$APP" 2>/dev/null
else
  echo "› signing as $SIGN_IDENTITY"
  # Inside out, one component at a time. `--deep` is Apple-deprecated and gets
  # this wrong: it applies the app's entitlements to helpers that must not have
  # them and skips components it does not recognise, and a bundle signed that
  # way is rejected at notarisation rather than at build time.
  sign () {
    codesign --force --timestamp --options runtime \
             --entitlements "$ENTITLEMENTS" --sign "$SIGN_IDENTITY" "$1"
  }

  # Frameworks and their versioned contents first.
  find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.framework' -print0 |
    while IFS= read -r -d '' framework; do
      find "$framework" -type f -perm +111 -print0 |
        while IFS= read -r -d '' binary; do sign "$binary"; done
      sign "$framework"
    done

  # Then the helper apps, then anything else executable in the payload, then the
  # app itself — a parent's signature seals its children, so it must go last.
  find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.app' -print0 |
    while IFS= read -r -d '' helper; do
      sign "$helper/Contents/MacOS/"* 2>/dev/null || true
      sign "$helper"
    done

  find "$APP/Contents/Resources" -type f \( -name '*.dylib' -o -name '*.so' -o -perm +111 \) -print0 |
    while IFS= read -r -d '' binary; do
      # Skip anything that is not actually Mach-O: scripts and data files carry
      # the execute bit too, and signing them is an error, not a no-op.
      file -b "$binary" | grep -q 'Mach-O' && sign "$binary" || true
    done

  sign "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"

  if [ -z "$NOTARY_PROFILE" ]; then
    echo "  (not notarised — set TULIP_NOTARY_PROFILE to submit)"
  else
    echo "› notarising (this waits on Apple, usually a few minutes)"
    ZIP=$BUILD/Tulip-notarize.zip
    rm -f "$ZIP"
    # ditto, not zip: the bundle's symlinks and extended attributes have to
    # survive the round trip or the signature does not.
    ditto -c -k --keepParent "$APP" "$ZIP"
    xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    rm -f "$ZIP"
    # The real test: this is what Gatekeeper asks on the receiving machine.
    spctl -a -vvv -t install "$APP"
  fi
fi

if [ "${1:-}" = "--no-install" ]; then
  echo "✓ $APP"
  exit 0
fi

echo "› installing to /Applications"
rm -rf /Applications/Tulip.app
cp -R "$APP" /Applications/Tulip.app

# Spotlight indexes from Launch Services, so a fresh bundle at a path that used
# to hold a different app needs to be re-registered or the old entry lingers.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -f /Applications/Tulip.app
touch /Applications/Tulip.app

echo "✓ /Applications/Tulip.app ($VERSION)"
