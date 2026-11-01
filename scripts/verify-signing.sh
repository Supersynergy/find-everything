#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d /tmp/fe-signing-XXXXXX)
cleanup() { local code=$?; if [ "$code" != 0 ]; then for log in "$WORK"/sign-*.log; do if [ -f "$log" ]; then cat "$log" >&2; fi; done; fi; rm -rf "$WORK"; }
trap cleanup EXIT
IDENTITY=${FE_SIGN_IDENTITY:-$(cat "${FE_CONFIG_DIR:-$HOME/.config/find-everything}/signing-identity" 2>/dev/null || security find-identity -v -p codesigning | awk '/"/ {print $2;exit}')}
export FE_SIGN_IDENTITY="$IDENTITY"
export FE_CONFIG_DIR="$WORK/config"
printf '#include <stdio.h>\nint main(void){puts("signing-fixture-v1");return 0;}\n' > "$WORK/v1.c"
printf '#include <stdio.h>\nint main(void){puts("signing-fixture-v2");return 0;}\n' > "$WORK/v2.c"
clang "$WORK/v1.c" -o "$WORK/tool-1"
clang "$WORK/v2.c" -o "$WORK/tool-2"
for VERSION in 1 2; do
  APP="$WORK/v$VERSION.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers"
  cp "$WORK/tool-$VERSION" "$APP/Contents/MacOS/FindEverything"
  for HELPER in fe fe-media-probe fe-events fe-content-probe; do cp "$WORK/tool-$VERSION" "$APP/Contents/Helpers/$HELPER"; done
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.supersynergy.findeverything' -c 'Add :CFBundleExecutable string FindEverything' -c "Add :CFBundleVersion string $VERSION" "$APP/Contents/Info.plist" >/dev/null
  if [ "$VERSION" = 1 ]; then export FE_INSTALLED_APP="$WORK/not-installed.app"; else export FE_INSTALLED_APP="$WORK/v1.app"; fi
  bash scripts/sign-app.sh "$APP" > "$WORK/sign-$VERSION.log" 2>&1
  codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p' > "$WORK/rule-$VERSION"
  for HELPER in fe fe-media-probe fe-events fe-content-probe; do
    codesign -d -r- "$APP/Contents/Helpers/$HELPER" 2>&1 | sed -n 's/^designated => //p' > "$WORK/$HELPER-rule-$VERSION"
  done
done
cmp "$WORK/rule-1" "$WORK/rule-2"
RULE=$(cat "$WORK/rule-1")
codesign --verify --deep --strict --test-requirement "=$RULE" "$WORK/v2.app"
for HELPER in fe fe-media-probe fe-events fe-content-probe; do
  cmp "$WORK/$HELPER-rule-1" "$WORK/$HELPER-rule-2"
  HELPER_RULE=$(cat "$WORK/$HELPER-rule-1")
  codesign --verify --strict --test-requirement "=$HELPER_RULE" "$WORK/v2.app/Contents/Helpers/$HELPER"
done
cp "$WORK/tool-1" "$WORK/wrong-app"
codesign --force --sign "$IDENTITY" --timestamp=none --identifier com.example.different "$WORK/wrong-app" 2>/dev/null
if codesign --verify --test-requirement "=$RULE" "$WORK/wrong-app" 2>/dev/null; then echo 'Different app identity was accepted' >&2; exit 1; fi
BEFORE=$(shasum -a 256 "$WORK/v2.app/Contents/MacOS/FindEverything")
if FE_SIGN_IDENTITY=0000000000000000000000000000000000000000 bash scripts/sign-app.sh "$WORK/v2.app" > "$WORK/unavailable.log" 2>&1; then echo 'Unavailable certificate was accepted' >&2; exit 1; fi
AFTER=$(shasum -a 256 "$WORK/v2.app/Contents/MacOS/FindEverything")
[ "$BEFORE" = "$AFTER" ]
printf 'Signing: changed binaries share a certificate-bound requirement; other app identity rejected.\n'
cat "$WORK/rule-1"
