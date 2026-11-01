#!/bin/bash
# Local development: bash install.sh --local. Release install: signed artifacts only.
set -euo pipefail
if [ "${1:-}" = "--local" ]; then exec bash "$(dirname "$0")/scripts/install-local.sh"; fi
REPO="Supersynergy/find-everything"
DL="https://github.com/$REPO/releases/latest/download"
APP="$HOME/Applications/Find Everything.app"
CLI="$HOME/.local/bin/fe"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "$DL/FindEverything.app.zip" -o "$WORK/app.zip"
ditto -xk "$WORK/app.zip" "$WORK/bundle"
CANDIDATE="$WORK/bundle/Find Everything.app"
# Public trust anchor, independent of the downloaded candidate's own requirement.
EXPECTED_REQUIREMENT='identifier "com.supersynergy.findeverything" and certificate leaf = H"E3CCA459395B95C297D5EA7954398559810A4819"'
codesign --verify --deep --strict --test-requirement "=$EXPECTED_REQUIREMENT" "$CANDIDATE"
# Preview artifacts are locally signed, not notarized: refuse them here.
if ! spctl --assess --type execute "$CANDIDATE"; then
  echo 'This download is not approved for normal macOS distribution. Existing installation kept; see the preview source-build instructions.' >&2
  exit 1
fi
if [ ! -x "$CANDIDATE/Contents/Helpers/fe" ]; then echo 'Release is missing its signed bundled CLI; existing installation kept.' >&2; exit 1; fi
RULE=$(codesign -d -r- "$CANDIDATE" 2>&1)
if ! printf '%s\n' "$RULE" | /usr/bin/grep -q 'certificate'; then echo 'Release has no stable signing identity. Existing installation kept; use the local installer.' >&2; exit 1; fi
if [ -d "$APP" ]; then
  OLD_RULE=$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')
  if ! printf '%s\n' "$OLD_RULE" | /usr/bin/grep -q 'certificate'; then echo 'One-time migration from the old ad-hoc build requires the local installer.' >&2; exit 1; fi
  codesign --verify --deep --strict --test-requirement "=$OLD_RULE" "$CANDIDATE"
fi
# No quarantine removal, TCC edits, or permission resets.
mkdir -p "$HOME/Applications" "$HOME/.local/bin" "$HOME/Library/Application Support/FindEverything/backups"
BACKUP="$HOME/Library/Application Support/FindEverything/backups/release-$(date +%Y%m%d-%H%M%S)-$$"
mkdir "$BACKUP"
if [ -e "$CLI" ] || [ -L "$CLI" ]; then cp -Pp "$CLI" "$BACKUP/fe"; fi
AGENT="$HOME/Library/LaunchAgents/com.supersynergy.findeverything.plist"
if [ -f "$AGENT" ]; then cp "$AGENT" "$BACKUP/agent.plist"; fi
STAGE="$HOME/Applications/.find-everything-release-$$.app"
DAEMON="$HOME/Library/LaunchAgents/com.supersynergy.fe-daemon.plist"
if [ -f "$DAEMON" ]; then cp "$DAEMON" "$BACKUP/daemon.plist"; fi
ditto "$CANDIDATE" "$STAGE"
MOVED=0
rollback() {
  launchctl bootout "gui/$(id -u)/com.supersynergy.findeverything" 2>/dev/null || true
  if [ "$MOVED" = 1 ]; then
    if [ -d "$APP" ]; then mv "$APP" "$BACKUP/failed-candidate.app"; fi
    if [ -d "$BACKUP/Find Everything.app" ]; then mv "$BACKUP/Find Everything.app" "$APP"; fi
  fi
  if [ -e "$BACKUP/fe" ] || [ -L "$BACKUP/fe" ]; then cp -Pp "$BACKUP/fe" "$CLI.restore-$$"; mv -f "$CLI.restore-$$" "$CLI"; fi
  if [ -f "$BACKUP/agent.plist" ]; then cp "$BACKUP/agent.plist" "$AGENT"; launchctl bootstrap "gui/$(id -u)" "$AGENT" || true; fi
  echo "Release installation failed; previous version restored from $BACKUP" >&2
}
trap rollback ERR
launchctl bootout "gui/$(id -u)/com.supersynergy.findeverything" 2>/dev/null || true
while read -r PID EXECUTABLE; do
  if [ "$EXECUTABLE" = "$APP/Contents/MacOS/FindEverything" ]; then kill -TERM "$PID" 2>/dev/null || true; fi
done < <(ps -wwaxo pid=,comm=)
for ATTEMPT in {1..30}; do
  if ! ps -wwaxo comm= | /usr/bin/grep -Fx "$APP/Contents/MacOS/FindEverything" >/dev/null; then break; fi
  if [ "$ATTEMPT" = 30 ]; then echo 'Installed app did not stop; update cancelled.' >&2; false; fi
  sleep 0.1
done
if [ -d "$APP" ]; then mv "$APP" "$BACKUP/Find Everything.app"; fi
MOVED=1
mv "$STAGE" "$APP"
ln -s "$APP/Contents/Helpers/fe" "$HOME/.local/bin/.fe-release-$$"
mv -f "$HOME/.local/bin/.fe-release-$$" "$CLI"
mkdir -p "$(dirname "$AGENT")"
/usr/libexec/PlistBuddy -c 'Clear dict' -c 'Add :Label string com.supersynergy.findeverything' \
  -c 'Add :ProgramArguments array' -c "Add :ProgramArguments:0 string $APP/Contents/MacOS/FindEverything" \
  -c 'Add :RunAtLoad bool true' -c 'Add :ProcessType string Interactive' "$AGENT"
launchctl bootstrap "gui/$(id -u)" "$AGENT"
# Preserve any existing watcher and maintenance configuration; no implicit opt-in.
trap - ERR
printf 'Installed signed release; existing background indexing is unchanged. Previous version: %s\n' "$BACKUP"
