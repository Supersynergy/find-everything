#!/bin/bash
# Builds Find Everything.app from the Swift package + repo icon.
set -euo pipefail
cd "$(dirname "$0")"

APP="Find Everything.app"
rm -rf "$APP"
swift build -c release 2>&1 | tail -3

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/FindEverything "$APP/Contents/MacOS/FindEverything"

# icon.icns from the repo PNG via iconset + iconutil
ICONSET=/tmp/fe-icon.iconset
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
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
  <key>CFBundleVersion</key><string>0.2.0</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

echo "built: $(pwd)/$APP"
