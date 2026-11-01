#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${FE_DESIGN_EVIDENCE:=$PWD/.git/acceptance-design-2026-10-18}"
mkdir -p "$FE_DESIGN_EVIDENCE"
bash -n install.sh scripts/install-local.sh scripts/sign-app.sh scripts/verify-signing.sh
swiftc app/Sources/FindEverything/Presentation.swift tests/native-design/main.swift -o "$FE_DESIGN_EVIDENCE/presentation-test"
"$FE_DESIGN_EVIDENCE/presentation-test"
swiftc app/Sources/FindEverything/ResultNavigation.swift tests/native/main.swift -o "$FE_DESIGN_EVIDENCE/navigation-test"
"$FE_DESIGN_EVIDENCE/navigation-test"
bash scripts/verify-signing.sh
(cd app && swift build -c release --jobs 2)
