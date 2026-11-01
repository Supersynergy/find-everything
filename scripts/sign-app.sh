#!/bin/bash
set -euo pipefail
APP=${1:?Usage: sign-app.sh /path/Find-Everything.app}
CONFIG=${FE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/find-everything}
PIN="$CONFIG/signing-identity"
IDENTITY=${FE_SIGN_IDENTITY:-}
if [ -z "$IDENTITY" ] && [ -f "$PIN" ]; then IDENTITY=$(cat "$PIN"); fi
if [ -z "$IDENTITY" ]; then
  IDENTITIES=$(security find-identity -v -p codesigning | awk '/"/ {print $2}')
  COUNT=$(printf '%s\n' "$IDENTITIES" | awk 'NF {n++} END {print n+0}')
  if [ "$COUNT" != 1 ]; then echo 'Choose an existing codesigning identity with FE_SIGN_IDENTITY; no ad-hoc fallback.' >&2; exit 1; fi
  IDENTITY=$IDENTITIES
fi
if ! [[ "$IDENTITY" =~ ^[[:xdigit:]]{40}$ ]]; then echo 'Signing identity must be a certificate fingerprint.' >&2; exit 1; fi
if ! security find-identity -v -p codesigning | awk '/"/ {print $2}' | /usr/bin/grep -iqx "$IDENTITY"; then echo 'Pinned signing identity unavailable; installed app has been preserved.' >&2; exit 1; fi
INSTALLED=${FE_INSTALLED_APP:-$HOME/Applications/Find Everything.app}
if [ -d "$INSTALLED" ]; then
  PREVIOUS=$(codesign -d -r- "$INSTALLED" 2>&1 | sed -n 's/.*certificate leaf = H"\([[:xdigit:]]*\)".*/\1/p')
  if [ -n "$PREVIOUS" ] && [ "$(printf %s "$PREVIOUS" | tr '[:lower:]' '[:upper:]')" != "$(printf %s "$IDENTITY" | tr '[:lower:]' '[:upper:]')" ]; then echo 'Refusing to rotate the installed app identity implicitly.' >&2; exit 1; fi
fi
for NAME in fe fe-media-probe fe-events fe-content-probe; do
  codesign --force --sign "$IDENTITY" --timestamp=none --preserve-metadata=entitlements --identifier "com.supersynergy.findeverything.$NAME" "$APP/Contents/Helpers/$NAME"
done
codesign --force --sign "$IDENTITY" --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"
"$APP/Contents/Helpers/fe" --version
RULE=$(codesign -d -r- "$APP" 2>&1)
if ! printf '%s\n' "$RULE" | /usr/bin/grep -q 'certificate'; then echo 'Stable certificate requirement missing.' >&2; exit 1; fi
mkdir -p "$CONFIG"
if [ ! -f "$PIN" ] || [ "$(cat "$PIN")" != "$IDENTITY" ]; then
  umask 077
  printf '%s\n' "$IDENTITY" > "$PIN.tmp-$$"
  mv "$PIN.tmp-$$" "$PIN"
fi
printf '%s\n' "$RULE"
