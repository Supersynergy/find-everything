#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
EVIDENCE="$PWD/.git/search-audit-20261112"
mkdir -p "$EVIDENCE"
HASH=$(bun -e 'import fs from "node:fs";import{createHash}from"node:crypto";const h=createHash("sha256");for(const p of [...new Bun.Glob("{src,tests}/**/*").scanSync({onlyFiles:true})].sort()){h.update(p);h.update(fs.readFileSync(p));}for(const p of ["package.json","bun.lock","tsconfig.json"]){h.update(fs.readFileSync(p));}console.log(h.digest("hex"))')
if [ "$(cat "$EVIDENCE/tests.hash" 2>/dev/null || true)" != "$HASH" ]; then
  bun test ./tests/*.test.ts > "$EVIDENCE/tests-final.log" 2>&1
  printf '%s\n' "$HASH" > "$EVIDENCE/tests.hash"
  printf '{"id":"search-release:tests","hash":"%s","result":"pass","ts":"%s","proof":"tests-final.log"}\n' "$HASH" "$(date -Iseconds)" >> "$EVIDENCE/test-ledger.jsonl"
fi
if [ "$(cat "$EVIDENCE/typecheck.hash" 2>/dev/null || true)" != "$HASH" ]; then
  ./node_modules/.bin/tsc --noEmit > "$EVIDENCE/typecheck-final.log" 2>&1
  printf '%s\n' "$HASH" > "$EVIDENCE/typecheck.hash"
  printf '{"id":"search-release:typecheck","hash":"%s","result":"pass","ts":"%s","proof":"typecheck-final.log"}\n' "$HASH" "$(date -Iseconds)" >> "$EVIDENCE/test-ledger.jsonl"
fi
NATIVE_HASH=$(bun -e 'import fs from "node:fs";import{createHash}from"node:crypto";const h=createHash("sha256");for(const pattern of ["app/Sources/**/*.swift","tests/**/*.swift"]){for(const p of [...new Bun.Glob(pattern).scanSync({onlyFiles:true})].sort()){h.update(p);h.update(fs.readFileSync(p));}}h.update(fs.readFileSync("scripts/check-keyboard.sh"));console.log(h.digest("hex"))')
if [ "$(cat "$EVIDENCE/native.hash" 2>/dev/null || true)" != "$NATIVE_HASH" ]; then
  FE_KEYBOARD_EVIDENCE="$EVIDENCE/native" bash scripts/check-keyboard.sh > "$EVIDENCE/native.log" 2>&1
  printf '%s\n' "$NATIVE_HASH" > "$EVIDENCE/native.hash"
  printf '{"id":"search-release:native","hash":"%s","result":"pass","ts":"%s","proof":"native.log"}\n' "$NATIVE_HASH" "$(date -Iseconds)" >> "$EVIDENCE/test-ledger.jsonl"
fi
bun -e 'import fs from "node:fs"; import {createHash} from "node:crypto"; import assert from "node:assert/strict"; const dir=".git/search-audit-20261112"; const report=JSON.parse(fs.readFileSync(dir+"/hyperfine-release/summary.json","utf8")); assert.equal(report.passed,true); assert.equal(report.candidateSha256,createHash("sha256").update(fs.readFileSync(dir+"/fe-candidate")).digest("hex")); assert.deepEqual(JSON.parse(fs.readFileSync(dir+"/dependency-audit-final.json","utf8")),{}); console.log(JSON.stringify({benchmark:"passed",rows:report.rows,dependencyAudit:"passed"}));'
bun scripts/verify-release.ts --published > "$EVIDENCE/release-published.log" 2>&1
git diff --check
printf 'Search release checks passed; logs: %s\n' "$EVIDENCE"
