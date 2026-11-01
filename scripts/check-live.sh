#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${FE_LIVE_EVIDENCE:=$PWD/.git/acceptance-live-2026-10-18}"
mkdir -p "$FE_LIVE_EVIDENCE"
swiftc -O app/FileEvents.swift -o "$FE_LIVE_EVIDENCE/fe-events"
bun run build-cli
bun scripts/verify-live.ts "$PWD/dist-bin/fe" "$FE_LIVE_EVIDENCE"
(cd app && swift build -c release --jobs 2)
swiftc app/Sources/FindEverything/ResultNavigation.swift tests/native/main.swift -o "$FE_LIVE_EVIDENCE/navigation-test"
"$FE_LIVE_EVIDENCE/navigation-test"
