#!/bin/bash
# Offscreen rendering only: never captures a screen or launches the actual app.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p release-artifacts docs/release/images
# Prove the synthetic filenames match the production query before drawing them.
bun test tests/presentation.test.ts -t 'product screenshots|production search backend'
# Pillow is an artwork-authoring prerequisite, never downloaded by this script.
python3 -c 'from PIL import Image'
# Use the same production-source isolation as scripts/check-keyboard.sh.
python3 - <<'PY'
from pathlib import Path
source = Path('app/Sources/FindEverything/main.swift').read_text()
startup = '''MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  withExtendedLifetime(delegate) { app.run() }
}
'''
if source.count(startup) != 1:
    raise SystemExit('Expected exactly one app startup block')
Path('release-artifacts/model-source.swift').write_text(source.replace(startup, '', 1))
PY
sources=()
for source in app/Sources/FindEverything/*.swift; do
  if [[ "$source" != app/Sources/FindEverything/main.swift ]]; then sources+=("$source"); fi
done
swiftc -parse-as-library -D FE_NATIVE_TESTS "${sources[@]}" release-artifacts/model-source.swift tests/native/release-preview.swift -o release-artifacts/render-preview
release-artifacts/render-preview docs/release/images
python3 scripts/release/compose-hero.py docs/release/images docs/release/images
