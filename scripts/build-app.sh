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
VERSION=$(node -p "require('./package.json').version")
IDENTIFIER=com.hb.tulip

[ -d "$ELECTRON" ] || { echo "electron is not installed — run npm install"; exit 1; }

echo "› bundling the renderer"
npm run build --silent

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
  <key>LSMinimumSystemVersion</key><string>11.0</string>
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
  </array>
</dict>
</plist>
PLIST

# An edited bundle fails Gatekeeper's signature check on Apple Silicon and dies
# on launch as "damaged". An ad-hoc signature is enough for a local app.
echo "› signing"
codesign --force --deep --sign - "$APP" 2>/dev/null

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
