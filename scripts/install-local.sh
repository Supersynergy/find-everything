#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash app/bundle-app.sh
bash scripts/sign-app.sh 'app/Find Everything.app'
APP="$HOME/Applications/Find Everything.app"
CLI="$HOME/.local/bin/fe"
SUPPORT="$HOME/Library/Application Support/FindEverything"
RUNTIME="$SUPPORT/semantic-runtime"
BACKUP="$SUPPORT/backups/$(date +%Y%m%d-%H%M%S)-$$"
STAGE="$HOME/Applications/.find-everything-update-$$.app"
AGENT="$HOME/Library/LaunchAgents/com.supersynergy.findeverything.plist"
DAEMON="$HOME/Library/LaunchAgents/com.supersynergy.fe-daemon.plist"
REFRESH="$HOME/Library/LaunchAgents/de.supersynergy.fe-refresh.plist"
mkdir -p "$BACKUP" "$HOME/.local/bin" "$HOME/Applications" "$HOME/.zsh/completions" "$RUNTIME"
if [ -e "$CLI" ] || [ -L "$CLI" ]; then cp -Pp "$CLI" "$BACKUP/fe"; fi
if [ -e "$HOME/.zsh/completions/_fe" ]; then cp -p "$HOME/.zsh/completions/_fe" "$BACKUP/_fe"; fi
if [ -e "$HOME/.zshrc" ]; then cp -p "$HOME/.zshrc" "$BACKUP/zshrc"; fi
if [ -e "$AGENT" ]; then cp -p "$AGENT" "$BACKUP/agent.plist"; fi
AGENTS_EXISTED=0
if [ -e "$DAEMON" ] || [ -e "$REFRESH" ]; then
  AGENTS_EXISTED=1
  [ -e "$DAEMON" ] && cp -p "$DAEMON" "$BACKUP/daemon.plist"
  [ -e "$REFRESH" ] && cp -p "$REFRESH" "$BACKUP/refresh.plist"
fi
MOVED=0
CLI_CHANGED=0
# launchd can still be tearing a job down right after bootout, and then
# bootstrap answers "Input/output error" (5) for an unchanged plist.
# Wait for the label to disappear, and retry the load instead of
# rolling back a valid app over that race.
bootout_agent() {
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  for _ in {1..30}; do
    launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
}
bootstrap_agent() {
  for _ in {1..10}; do
    launchctl bootstrap "gui/$(id -u)" "$1" 2>/dev/null && return 0
    sleep 0.3
  done
  launchctl bootstrap "gui/$(id -u)" "$1"
}
rollback() {
  bootout_agent com.supersynergy.findeverything
  if [ "$MOVED" = 1 ]; then
    if [ -d "$APP" ]; then mv "$APP" "$BACKUP/failed-candidate.app"; fi
    if [ -d "$BACKUP/Find Everything.app" ]; then mv "$BACKUP/Find Everything.app" "$APP"; fi
  fi
  if [ "$CLI_CHANGED" = 1 ]; then
    if [ -e "$BACKUP/fe" ] || [ -L "$BACKUP/fe" ]; then cp -Pp "$BACKUP/fe" "$CLI.restore-$$"; mv -f "$CLI.restore-$$" "$CLI"; fi
  fi
  if [ -e "$BACKUP/_fe" ]; then cp -p "$BACKUP/_fe" "$HOME/.zsh/completions/_fe"; fi
  if [ -e "$BACKUP/zshrc" ]; then cp -p "$BACKUP/zshrc" "$HOME/.zshrc"; fi
  if [ -e "$BACKUP/agent.plist" ]; then cp -p "$BACKUP/agent.plist" "$AGENT"; bootstrap_agent "$AGENT" || true; fi
  bootout_agent com.supersynergy.fe-daemon
  bootout_agent de.supersynergy.fe-refresh
  if [ "$AGENTS_EXISTED" = 1 ]; then
    [ -e "$BACKUP/daemon.plist" ] && cp -p "$BACKUP/daemon.plist" "$DAEMON" && bootstrap_agent "$DAEMON" || true
    [ -e "$BACKUP/refresh.plist" ] && cp -p "$BACKUP/refresh.plist" "$REFRESH" && bootstrap_agent "$REFRESH" || true
  else
    rm -f "$DAEMON" "$REFRESH"
  fi
  echo "Installation failed; previous app restored. Evidence: $BACKUP" >&2
}
trap rollback ERR
for FILE in package.json bun.lock setup.sh worker.mjs; do
  if ! cmp -s "runtime/$FILE" "$RUNTIME/$FILE"; then cp "runtime/$FILE" "$RUNTIME/$FILE"; fi
done
ditto 'app/Find Everything.app' "$STAGE"
codesign --verify --deep --strict "$STAGE"
bootout_agent com.supersynergy.findeverything
# Finder-started copies are not owned by the LaunchAgent.
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
ln -s "$APP/Contents/Helpers/fe" "$HOME/.local/bin/.fe-new-$$"
mv -f "$HOME/.local/bin/.fe-new-$$" "$CLI"
CLI_CHANGED=1
"$CLI" --version
"$CLI" completions zsh > "$HOME/.zsh/completions/_fe"
if ! rg --quiet --fixed-strings '# Find Everything completion' "$HOME/.zshrc" 2>/dev/null; then
  cat >> "$HOME/.zshrc" <<'ZSH'

# Find Everything completion
[[ -f "$HOME/.zsh/completions/_fe" ]] && source "$HOME/.zsh/completions/_fe"
ZSH
fi
zsh -n "$HOME/.zshrc"
mkdir -p "$(dirname "$AGENT")"
/usr/libexec/PlistBuddy -c 'Clear dict' -c 'Add :Label string com.supersynergy.findeverything' \
  -c 'Add :ProgramArguments array' -c "Add :ProgramArguments:0 string $APP/Contents/MacOS/FindEverything" \
  -c 'Add :RunAtLoad bool true' -c 'Add :ProcessType string Interactive' "$AGENT"
bootstrap_agent "$AGENT"
# Installation must not enable watchers or replace the user's maintenance scopes.
# Existing background-service configuration is deliberately left unchanged.
trap - ERR
echo "Installed $CLI -> $APP/Contents/Helpers/fe"
echo "Previous app: $BACKUP"
