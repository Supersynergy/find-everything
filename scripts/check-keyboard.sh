#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${FE_KEYBOARD_EVIDENCE:=$PWD/.git/acceptance-keyboard-2026-10-19}"
mkdir -p "$FE_KEYBOARD_EVIDENCE"
swiftc app/Sources/FindEverything/ResultNavigation.swift tests/native/main.swift -o "$FE_KEYBOARD_EVIDENCE/navigation-test"
"$FE_KEYBOARD_EVIDENCE/navigation-test"
swiftc -parse-as-library app/Sources/FindEverything/ResultNavigation.swift tests/native/batch.swift -o "$FE_KEYBOARD_EVIDENCE/batch-test"
"$FE_KEYBOARD_EVIDENCE/batch-test"
swiftc -parse-as-library app/Sources/FindEverything/ResultNavigation.swift app/Sources/FindEverything/VirtualResultTable.swift tests/native/ui.swift -o "$FE_KEYBOARD_EVIDENCE/table-test"
"$FE_KEYBOARD_EVIDENCE/table-test"
# Compile the real model in an isolated test executable, omitting only app startup.
python3 - "$FE_KEYBOARD_EVIDENCE/model-source.swift" <<'PY'
from pathlib import Path
import sys
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
Path(sys.argv[1]).write_text(source.replace(startup, '', 1))
PY
model_sources=()
for source in app/Sources/FindEverything/*.swift; do
  if [[ "$source" != app/Sources/FindEverything/main.swift ]]; then model_sources+=("$source"); fi
done
swiftc -parse-as-library -D FE_NATIVE_TESTS "${model_sources[@]}" "$FE_KEYBOARD_EVIDENCE/model-source.swift" tests/native/model.swift -o "$FE_KEYBOARD_EVIDENCE/model-test"
"$FE_KEYBOARD_EVIDENCE/model-test"
swiftc app/Sources/FindEverything/Presentation.swift tests/native-design/main.swift -o "$FE_KEYBOARD_EVIDENCE/presentation-test"
"$FE_KEYBOARD_EVIDENCE/presentation-test"
swiftc app/Sources/FindEverything/VirtualResults.swift app/Sources/FindEverything/WarmResults.swift tests/virtual/main.swift -o "$FE_KEYBOARD_EVIDENCE/virtual-test"
"$FE_KEYBOARD_EVIDENCE/virtual-test"
(cd app && swift build -c release --jobs 2)
