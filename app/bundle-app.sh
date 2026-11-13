#!/bin/bash
# Builds Find Everything.app from the Swift package + repo icon.
set -euo pipefail
cd "$(dirname "$0")"

APP="Find Everything.app"
rm -rf "$APP"
(cd .. && bun run build-cli)
swift build -c release --jobs 2 2>&1 | tail -3

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Helpers"
cp .build/release/FindEverything "$APP/Contents/MacOS/FindEverything"
cp ../dist-bin/fe "$APP/Contents/Helpers/fe"
mkdir -p "$APP/Contents/Resources/instantfind"
cp ../runtime/instantfind/*.py "$APP/Contents/Resources/instantfind/"
mkdir -p "$APP/Contents/Resources/Licenses"
cp ../LICENSE ../THIRD-PARTY-NOTICES.md ../docs/release/BUN-LICENSE.md "$APP/Contents/Resources/Licenses/"
swiftc -O MediaProbe.swift -o "$APP/Contents/Helpers/fe-media-probe"
swiftc -O FileEvents.swift -o "$APP/Contents/Helpers/fe-events"
swiftc -swift-version 6 -O ContentProbe.swift -o "$APP/Contents/Helpers/fe-content-probe"

# icon.icns from the repo PNG via iconset + iconutil
ICONWORK=$(mktemp -d)
trap 'rm -rf "$ICONWORK"' EXIT
ICONSET="$ICONWORK/fe.iconset"
mkdir -p "$ICONSET"
SRC=../assets/icon.png
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Find Everything</string>
  <key>CFBundleDisplayName</key><string>Find Everything</string>
  <key>CFBundleIdentifier</key><string>com.supersynergy.findeverything</string>
  <key>CFBundleExecutable</key><string>FindEverything</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleVersion</key><string>0.3.43</string>
  <key>CFBundleShortVersionString</key><string>0.3.43</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
</dict>
</plist>
PLIST

echo "built: $(pwd)/$APP"
