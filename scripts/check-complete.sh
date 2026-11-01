#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${FE_COMPLETE_EVIDENCE:=$PWD/.git/acceptance-complete-2026-10-18}"
mkdir -p "$FE_COMPLETE_EVIDENCE"
bun run build-cli
cp -p dist-bin/fe "$FE_COMPLETE_EVIDENCE/oracle-cli"
FE_TEST_CLI="$FE_COMPLETE_EVIDENCE/oracle-cli" bun test tests
bun scripts/bench-complete.ts "$FE_COMPLETE_EVIDENCE/oracle-cli" "${FE_BASELINE_CLI:--}" "$FE_COMPLETE_EVIDENCE/benchmark-final.json" 200000
swiftc app/Sources/FindEverything/Presentation.swift tests/native-design/main.swift -o "$FE_COMPLETE_EVIDENCE/presentation-test"
"$FE_COMPLETE_EVIDENCE/presentation-test"
swiftc app/Sources/FindEverything/ResultNavigation.swift tests/native/main.swift -o "$FE_COMPLETE_EVIDENCE/navigation-test"
"$FE_COMPLETE_EVIDENCE/navigation-test"
swiftc app/Sources/FindEverything/VirtualResults.swift app/Sources/FindEverything/WarmResults.swift tests/virtual/main.swift -o "$FE_COMPLETE_EVIDENCE/virtual-test"
"$FE_COMPLETE_EVIDENCE/virtual-test"
(cd app && swift build -c release --jobs 2)
