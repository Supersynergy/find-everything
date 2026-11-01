#!/bin/bash
# Installs the app-independent live index service and the nightly reconcile job.
# Both agents stay user-owned LaunchAgents; existing plists are backed up first.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
BACKUP="$HOME/Library/Application Support/FindEverything/backups/agents-$(date +%Y%m%d-%H%M%S)-$$"
UID_NUM="$(id -u)"
DAEMON_LABEL="com.supersynergy.fe-daemon"
REFRESH_LABEL="de.supersynergy.fe-refresh"
PATH_VALUE="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
CACHE="$HOME/.cache/hypersearch"
CLI="${FE_CLI:-$HOME/.local/bin/fe}"

mkdir -p "$AGENTS" "$CACHE"
for LABEL in "$DAEMON_LABEL" "$REFRESH_LABEL"; do
  if [ -f "$AGENTS/$LABEL.plist" ]; then mkdir -p "$BACKUP"; cp "$AGENTS/$LABEL.plist" "$BACKUP/$LABEL.plist"; fi
done
chmod 0700 "$REPO/scripts/fe-maintain.sh"
[ -x "$CLI" ] || { echo "install-daemon: missing $CLI; install Find Everything first" >&2; exit 1; }

write_agent() {
  local label="$1" plist="$2" tmp="$2.new.$$"
  plutil -lint "$tmp" >/dev/null
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  # A KeepAlive job can still be tearing down; bootstrapping during that
  # window answers "Input/output error" (5) and would fail the install.
  for _ in {1..50}; do
    launchctl print "gui/$UID_NUM/$label" >/dev/null 2>&1 || break
    sleep 0.1
  done
  mv "$tmp" "$plist"
  for _ in {1..10}; do
    launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null && return 0
    sleep 0.3
  done
  launchctl bootstrap "gui/$UID_NUM" "$plist"
}

PLIST="$AGENTS/$DAEMON_LABEL.plist"
cat >"$PLIST.new.$$" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$DAEMON_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$CLI</string>
		<string>serve</string>
		<string>--socket</string>
		<string>auto</string>
		<string>--live</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$PATH_VALUE</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$CACHE/fe-daemon.log</string>
	<key>StandardErrorPath</key>
	<string>$CACHE/fe-daemon.log</string>
</dict>
</plist>
PLIST_EOF
write_agent "$DAEMON_LABEL" "$PLIST"

PLIST="$AGENTS/$REFRESH_LABEL.plist"
cat >"$PLIST.new.$$" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$REFRESH_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$REPO/scripts/fe-maintain.sh</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$PATH_VALUE</string>
	</dict>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>3</integer>
		<key>Minute</key>
		<integer>30</integer>
	</dict>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>$CACHE/maintain.log</string>
	<key>StandardErrorPath</key>
	<string>$CACHE/maintain.log</string>
</dict>
</plist>
PLIST_EOF
write_agent "$REFRESH_LABEL" "$PLIST"

printf 'Installed %s and %s from %s\n' "$DAEMON_LABEL" "$REFRESH_LABEL" "$REPO"
if [ -d "$BACKUP" ]; then printf 'Previous agents: %s\n' "$BACKUP"; fi
