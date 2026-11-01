#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${FE_ACCEPTANCE_EVIDENCE:=$PWD/.git/acceptance-semantic-2026-10-18}"
bun run build-cli
bun scripts/verify-semantic.ts "$PWD/dist-bin/fe" "$FE_ACCEPTANCE_EVIDENCE"
(cd app && swift build -c release --jobs 2)
swiftc app/Sources/FindEverything/ResultNavigation.swift tests/native/main.swift -o "$FE_ACCEPTANCE_EVIDENCE/navigation-test"
"$FE_ACCEPTANCE_EVIDENCE/navigation-test"
