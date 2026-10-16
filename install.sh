#!/bin/bash
# Find Everything — one-command install (macOS).
#   curl -fsSL https://raw.githubusercontent.com/Supersynergy/find-everything/master/install.sh | bash
# Installs: Find Everything.app -> ~/Applications, fe CLI -> ~/.local/bin.
# First launch of the app downloads fd/rg/fzf itself — no brew, no sudo.
set -euo pipefail

REPO="Supersynergy/find-everything"
ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] && FE_ASSET="fe-darwin-arm64" || FE_ASSET="fe-darwin-x64"
DL="https://github.com/$REPO/releases/latest/download"

echo "==> Installing fe CLI to ~/.local/bin"
mkdir -p "$HOME/.local/bin" "$HOME/Applications"
curl -fsSL "$DL/$FE_ASSET" -o "$HOME/.local/bin/fe"
chmod +x "$HOME/.local/bin/fe"

echo "==> Installing Find Everything.app to ~/Applications"
curl -fsSL "$DL/FindEverything.app.zip" -o /tmp/findeverything-app.zip
rm -rf "$HOME/Applications/Find Everything.app"
ditto -xk /tmp/findeverything-app.zip "$HOME/Applications"
rm /tmp/findeverything-app.zip
xattr -dr com.apple.quarantine "$HOME/Applications/Find Everything.app" 2>/dev/null || true

echo "==> Done"
echo "  fe        -> terminal: type 'fe' for the picker, 'fe <query>' to search"
echo "  app       -> ~/Applications/Find Everything.app  (hotkey: Option+Space)"
echo "  tools     -> fd/rg/fzf are downloaded by the app on first launch"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  note: add ~/.local/bin to PATH";; esac
open "$HOME/Applications/Find Everything.app" || true
