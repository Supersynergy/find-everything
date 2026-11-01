#!/bin/bash
# Reconciles drifted indexes, then refreshes derived and fast-search data.
# Incremental updates come from the live daemon; this only rebuilds what is
# explicitly flagged, missing or older than FE_MAX_AGE_DAYS, and merges
# "everything" from the saved indexes instead of walking the disk again.
set -uo pipefail
FE="${FE_CLI:-$HOME/.local/bin/fe}"
CACHE="${FE_DATA_DIR:-$HOME/.cache/hypersearch}"
LOG="$CACHE/maintain.log"
LOCK="$CACHE/maintain.lock"
LIVE="$CACHE/live.sqlite"
MAX_AGE_DAYS="${FE_MAX_AGE_DAYS:-7}"
PREPARE_SECONDS="${FE_PREPARE_SECONDS:-240}"
COMBINE_SECONDS="${FE_COMBINE_SECONDS:-300}"
PREPARE_PASSES="${FE_PREPARE_PASSES:-4}"
INDEX_SECONDS="${FE_INDEX_SECONDS:-3600}"
DERIVED=" everything all "
SCOPES=("$@")
[ ${#SCOPES[@]} -gt 0 ] || read -r -a SCOPES <<<"${FE_MAINTAIN_SCOPES:-home downloads applications master base hypersearch sounds}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Wall-clock bound, so a hung child cannot keep maintain.lock forever.
bounded() {
  local limit="$1"; shift
  local started pid
  started=$(date -u +%s)
  "$@" & pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ $(( $(date -u +%s) - started )) -ge "$limit" ]; then
      kill -TERM "$pid" 2>/dev/null
      sleep 2
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 2
  done
  wait "$pid"
}

mkdir -p "$CACHE"
if [ -d "$LOCK" ]; then
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "skip: maintenance already running as $holder"
    exit 0
  fi
  rm -rf "$LOCK"
fi
mkdir "$LOCK" || { log "skip: cannot take lock"; exit 0; }
printf '%s\n' "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

if [ -s "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 2000 ]; then
  tail -n 1000 "$LOG" >"$LOG.trim" && mv "$LOG.trim" "$LOG"
fi
exec >>"$LOG" 2>&1

if [ ! -x "$FE" ]; then
  log "fail: missing $FE"
  exit 1
fi

problem_of() {
  [ -f "$LIVE" ] || return 0
  command -v sqlite3 >/dev/null || return 0
  sqlite3 "$LIVE" "select coalesce(problem,'') from scopes where name='$1'" 2>/dev/null
}

# name, exists, indexedAt, stale
status_rows=$("$FE" status --json 2>/dev/null | /usr/bin/python3 -c '
import json,sys
try: data=json.load(sys.stdin)
except Exception: sys.exit(0)
for i in data.get("indexes",[]):
    print("%s\t%s\t%s\t%s" % (i.get("name"), 1 if i.get("exists") else 0, i.get("indexedAt") or "", 1 if i.get("stale") else 0))
')
[ -n "$status_rows" ] || { log "fail: fe status --json unavailable"; exit 1; }

reason_for() {
  local name="$1" exists="$2" indexed="$3" stale="$4" problem age_limit
  if [ "$exists" = 0 ]; then echo "never built"; return; fi
  problem=$(problem_of "$name")
  if [ -n "$problem" ]; then echo "$problem"; return; fi
  if [ "$stale" = 1 ]; then echo "reported stale"; return; fi
  age_limit=$(( MAX_AGE_DAYS * 86400 ))
  if [ -n "$indexed" ]; then
    local epoch
    epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%S" "${indexed%%.*}" +%s 2>/dev/null || echo "")
    if [ -n "$epoch" ] && [ $(( $(date -u +%s) - epoch )) -gt "$age_limit" ]; then echo "older than ${MAX_AGE_DAYS}d"; return; fi
  fi
  echo ""
}

search_ready() {
  "$FE" status --json 2>/dev/null | /usr/bin/python3 -c '
import json,sys
name=sys.argv[1]
try: data=json.load(sys.stdin)
except Exception: sys.exit(1)
for i in data.get("indexes",[]):
    if i.get("name")==name: sys.exit(0 if (i.get("search") or {}).get("ready") else 1)
sys.exit(1)
' "$1"
}

# Large snapshots need several bounded passes; one 240s pass is not enough.
prepare_ready() {
  local pass
  for pass in $(/usr/bin/seq 1 "$PREPARE_PASSES"); do
    bounded $(( PREPARE_SECONDS + 60 )) /usr/bin/nice -n 10 "$FE" prepare --index "$1" --seconds "$PREPARE_SECONDS" >/dev/null || return 1
    search_ready "$1" && return 0
  done
  return 1
}

# Record the daemon's own view first: that is the run trail for "Vorgänge heute".
if [ -f "$LIVE" ] && command -v sqlite3 >/dev/null; then
  while IFS='|' read -r name problem; do
    [ -n "$name" ] && log "state $name: ${problem:-no problem}"
  done < <(sqlite3 "$LIVE" "select name,coalesce(problem,'') from scopes order by name" 2>/dev/null)
fi

failed=0 rebuilt=0 skipped=0 blocked=0
ready_sources=()
for scope in "${SCOPES[@]}"; do
  case "$DERIVED" in *" $scope "*) log "skip $scope: derived index, rebuilt by combine"; continue;; esac
  row=$(printf '%s\n' "$status_rows" | /usr/bin/awk -F'\t' -v n="$scope" '$1==n{print;exit}')
  if [ -z "$row" ]; then log "skip $scope: unknown index"; skipped=$((skipped+1)); continue; fi
  IFS=$'\t' read -r _ exists indexed stale <<<"$row"
  reason=$(reason_for "$scope" "$exists" "$indexed" "$stale")
  if [ -z "$reason" ]; then
    log "ok $scope: current ($indexed)"; skipped=$((skipped+1))
    if search_ready "$scope" || prepare_ready "$scope"; then ready_sources+=("$scope"); else log "skip $scope: fast search not ready, excluded from combine"; fi
    continue
  fi
  log "reconcile $scope: $reason"
  start=$(date -u +%s)
  out_file=$(mktemp)
  bounded "$INDEX_SECONDS" /usr/bin/nice -n 10 "$FE" index --index "$scope" >"$out_file" 2>&1
  index_status=$?
  out=$(cat "$out_file")
  rm -f "$out_file"
  if [ "$index_status" = 124 ]; then
    log "fail $scope: index exceeded the ${INDEX_SECONDS}s wall-clock budget"
    failed=$((failed+1))
    continue
  fi
  if [ "$index_status" = 0 ]; then
    if prepare_ready "$scope"; then
      log "done $scope in $(( $(date -u +%s) - start ))s"
      rebuilt=$((rebuilt+1)); ready_sources+=("$scope")
      continue
    fi
    log "fail $scope: prepare failed after $(( $(date -u +%s) - start ))s"
  elif printf '%s' "$out" | /usr/bin/grep -q 'exceeds 1 GiB'; then
    log "blocked $scope: path snapshot exceeds the 1 GiB cap; reduce the tree or decide on exclusions"
    blocked=$((blocked+1))
    continue
  else
    log "fail $scope: index failed after $(( $(date -u +%s) - start ))s: $(printf '%s' "$out" | tail -n 1)"
  fi
  failed=$((failed+1))
done

if [ ${#ready_sources[@]} -eq 0 ]; then
  log "skip everything: no current source index"
elif printf '%s\n' "$status_rows" | /usr/bin/awk -F'\t' '$1=="everything" && $2==1{found=1} END{exit !found}'; then
  source_list=$(IFS=,; echo "${ready_sources[*]}")
  log "combine everything from ${source_list}"
  if ! bounded "$(( COMBINE_SECONDS + 60 ))" /usr/bin/nice -n 10 "$FE" combine --name everything --replace --sources "$source_list" --seconds "$COMBINE_SECONDS" >/dev/null; then
    log "fail everything: combine failed"
    failed=$((failed+1))
  fi
else
  source_list=$(IFS=,; echo "${ready_sources[*]}")
  log "create everything from ${source_list}"
  if ! bounded "$(( COMBINE_SECONDS + 60 ))" /usr/bin/nice -n 10 "$FE" combine --name everything --sources "$source_list" --seconds "$COMBINE_SECONDS" >/dev/null; then
    log "fail everything: combine failed"
    failed=$((failed+1))
  fi
fi

log "summary: rebuilt=$rebuilt current=$skipped blocked=$blocked failed=$failed"
[ "$failed" = 0 ] || exit 1
