# Changelog

## 0.3.47 — 2026-11-14

- Speed up exact file-property counts on sparse indexes in `fe status`.

## 0.3.46 — 2026-11-14

- Consolidate pending path changes during live indexing and index recent changes by scope and revision.
- Batch durable flat-export checkpoints across multiple read pages.

## 0.3.45 — 2026-11-14

- Coalesce repeat file removals and skip property refreshes for the watcher's own databases. Preserve membership changes, directory tombstones and ordinary file metadata.
- Cache per-scope options and journal counts, continue large event batches across event-loop yields, and checkpoint otherwise quiet streams at most once a minute during activity.

## 0.3.44 — 2026-11-13

- Keep `fe explain` metadata-only by skipping the full property-count scan. Report the count as unknown with an explicit exactness flag; retain exact status counting for existing callers.

## 0.3.43 — 2026-11-13

- Reuse bounded passage embeddings within the resident model worker, retaining exact ranking, filters and source-version checks. Invalidate query and passage caches when the configured model/runtime identity changes or the worker closes.
- Bound passage payloads to 512 entries / 2 MiB and query payloads to 128 entries / 1 MiB. Record cache reuse in search diagnostics without writing document text or a new disk cache.

## 0.3.42 — 2026-11-13

- Refine document ranking with up to twelve query-selected late passages from the full-text cache. Keep snippets in SQLite until requested; preserve hard filters and original cosine scores. Split the pinned model graph from its token table and map only requested rows to reduce search memory without changing model vectors. Passage refinement adds query latency.


## 0.3.41 — 2026-11-13

- Add literal punctuation queries, Unicode smart case, explicit case and whole-word controls, native filter controls and read-only query explanations. Preserve quoted type-like text instead of rewriting it.
- Validate compaction source, stage and backup identities before publication, and reject damaged checkpoints or unknown subcommands without replacing saved files.
- Bound native AppKit tables to a moving 10,000-row window, retaining global selection, scrolling and direct navigation across tens of millions of results.

## 0.3.40 — 2026-11-13

- Add resumable compaction from a pinned prepared snapshot, preserving changes after its journal watermark, CR/LF paths, coverage warnings and previous files. Recover interrupted publication before using the snapshot. Keep real journal gaps until explicit reconciliation.
- Persist up to 128 exact count results for scopes with at least 100,000 paths in a bounded private SQLite cache. Bind entries to physical and logical snapshot identity; first-time counts still run the exhaustive query. Reuse them across reader/process restarts without changing ordering or filters.
- Add explicit local Vision OCR for scanned PDFs and images, page/method/confidence provenance, per-file page limits, changed-file validation and a native Settings action. Keep OCR out of the search path and retain existing Instantfind support.

## 0.3.9 — 2026-11-13

- Move live event handling and metadata work into one owned worker process so those batches do not run on the API event loop. Reuse the existing process-group guardian to stop the worker and its helpers when the owning service exits.
- Synchronize prepared search snapshots inside the disposable search reader. Bind cached responses to the returned snapshot while preserving non-snapshot query dependencies. Mark responses behind the journal as pending, and retain journal-gap warnings.
- Recover a hot SQLite rollback journal before opening read-only lookup handles after an interrupted search writer. Add crash, ownership, pending-state and live replay regressions.

- Reduce Instantfind memory with a bounded SQLite BPE tokenizer while retaining the pinned model and existing vectors. Process document embeddings sequentially to bound indexing memory. Keep a successfully used document model in the app-owned reader across idle periods; plain readers still retire. Add a frozen real-file DE/EN comparison.

- Add optional `meaning:"…"` retrieval for explicitly prepared document and project-text caches, using a pinned local Gemma model. Keep filename, literal-content and audio search separate.
- Preserve path/type/date/favorite filters, reject stale content, recheck source files after inference and publish complete vector indexes atomically. Interrupted budgeted builds retain a resumable checkpoint.
- Add local setup/status/index/clear commands and a fresh German/English document benchmark. No model download or source-document scan occurs while searching.

## 0.3.8 — 2026-11-13

- Use the existing media path index for live subtree cleanup. Avoid a complete media-table scan for every removed directory, and match non-BMP directory prefixes without mixing JavaScript UTF-16 lengths with SQLite character lengths.
- Retain prepared filename candidate sets, directory counts and exact name counts across metadata hydration and property-only live events. Recompute size/date-dependent counts, reload row properties and invalidate membership caches after additions, removals or path representation changes. Existing prepared snapshots remain readable; no full rebuild is required.
- Share equivalent in-flight searches across clients with independent cancellation, generations and prefetch handling. Preserve the two-job admission limit and separate preview/exact work.
- Bind API cache entries to the snapshot searched after synchronization. Use parsed query structure and scope-local journal clocks, preserve caller query echoes and live warnings, and avoid dependencies on unrelated search backends. Rolling date queries use minute buckets.
- Bound cached keys and bodies together to 16 MiB/256 entries; allow individual responses up to 1 MiB. Add regression coverage for large pages, cache bounds, snapshot binding, canonical query semantics and shared cancellation.

## 0.3.7 — 2026-11-13

- Produce early relevance matches for a single lowercase ASCII term from the indexed filename-prefix range. Exact/stem and prefix tiers outrank other matches even with bounded learning. Preview responses stay provisional; complete responses use the shortcut only when it covers the entire requested page, preserving all other matches through the existing path.
- Keep an exact request in flight after publishing its preview, so automatic live polling does not cancel it. Preserve usable preliminary rows if the exact count times out and report that count failure in the search note.
- Compare prefix previews and complete pages against independent relevance ordering, including non-prefix, folder-only, uppercase and alternative terms. On the live full index, the `ne` preview changed from a 10-second abort to a 965-ms, 1,000-row provisional response. Its complete global count still exceeded the 10-second measurement budget; this release does not claim every broad query is instantaneous.

## 0.3.6 — 2026-11-13

- Stop counting an entire relevance bucket just to decide whether a page offset fits inside it. Probe at most offset + 1 matching rows and cache only exhausted buckets as exact counts. This removes a full-index scan from speculative page-two loading while preserving result order, exact total matches and page boundaries.
- Add pagination regressions across content-type boundaries, including revisits after a bounded probe. An isolated reader on the installed 68-million-path index exceeded 10 seconds before the fix; the candidate returned the same-sized second page in 67 ms. A separate 500,000-row Hyperfine counter fixture measured 358.0 ms versus 22.0 ms; these are bounded observations, not an all-query latency guarantee.

## 0.3.5 — 2026-11-13

- Recheck directories when a live subtree scan fails. If a temporary directory disappeared or became a file, remove its old descendants and index its current state; retain genuine scanner and permission errors.
- Replace a coalesced directory's descendants only after a complete successful scan, so deleted children do not remain searchable. Keep rescan bounds and preserve prefix siblings. Add deterministic disappearance, replacement and stale-child regressions.

## 0.3.4 — 2026-11-13

- Coalesce pending events by path before checking the queue budget. More than 20,000 repeated notifications for a few paths no longer discard the replay; the finite limit still applies to 20,000 distinct pending paths per root.
- Preserve all flags and the union of target scopes. An unscoped notification continues to apply to every matching scope when combined with scoped duplicates. Add a 65,536-duplicate replay regression across two saved scopes.

## 0.3.3 — 2026-11-13

- Use indexed, case-sensitive directory ranges when applying subtree deletions. Avoid scanning every directory for each deleted subtree; preserve Unicode spelling and sibling boundaries.
- Raise the finite live-journal and lookup-sync bounds together from 100,000 to 1,000,000 paths. Count new keys rather than replacements against the overlay budget. Give each saved scope its own event-processing budget.
- Keep CR/LF filenames in the NUL-delimited live updater and prepared lookup. The line-delimited scan snapshot still reports these as skipped; an existing path can be recovered through live events without changing the flat format.
- Add regressions for more than 100,000 pending deltas, Unicode subtree boundaries and live CR/LF names, plus a synthetic Hyperfine comparison of the directory predicates.

## 0.3.2 — 2026-11-12

- Fix a real full-disk rebuild stopping at 59,480,395 paths because the path snapshot crossed the fixed 8-GiB cap. Keep atomic publication and finite limits: up to 32 GiB for saved paths, bounded by initial free space minus 2 GiB.
- Allow search preparation to grow beyond its former 6-GiB limit. Bound its main database and WAL to a 48-GiB budget, include existing checkpoints in free-space accounting, and check the 2-GiB free-space reserve during insertion and finalization. Preparation remains resumable.
- Keep all query, permission, explicit-exclusion and display-filter behavior from 0.3.1. Capacity regressions cross the old threshold using byte accounting without allocating a large fixture.

## 0.3.1 — 2026-11-12

- Add explicit inclusive indexing with `--exhaustive`, persisted across rebuilds and live updates. Include hidden/ignored/generated folders, Library, .local and mounted volumes; preserve explicit exclusions and permissions. Add native rebuild/show-all actions and show all indexed files by default for new preferences.
- Match canonically equivalent Unicode filename spellings in path, filename, folder, media and document-path filters. Keep old accelerators readable and upgrade derived keys through explicit preparation.
- Fix absolute folder filters matching similarly named sibling folders. Use the indexed directory prefix for prepared folder queries.
- Remove stale descendants after live subtree deletion under non-BMP folder names. Discover application directories consistently before and after lookup preparation.
- Report scanner diagnostics and skipped newline-containing paths as incomplete coverage. Handle missing watcher PIDs without signaling an invalid process.
- Update the Raycast API and lockfiles; add synthetic correctness fixtures and a Hyperfine comparison harness with source/binary identities and explicit measurement limits.

## 0.3.0 — 2026-11-01 (preview; correct sequence after 0.2.0)

- Correct the previously published 0.14.0 label to 0.3.0. After 0.3.0 was verified, the owner explicitly requested deletion of the incorrect public release, its downloads and tag. Local rollback copies are retained; 0.2.0 and 0.3.0 are unchanged.
- First app launch schedules the All path index once; existing All snapshots are reused. Show a compact footer with real file count, measured preparation percentage, a contrasted progress bar, Pause/Continue and phase-specific Cancel behaviour.
- Pause stops owned disk/CPU workers and excludes paused time from timeouts. Independent supervisor and native-parent lifetime guards prevent paused orphan workers; isolated source/compiled/native regressions exercise the controls.
- Core indexing uses macOS system find when optional fd is absent, without downloading helpers or requiring Homebrew. Explicit exclusions, resource bounds and macOS permissions remain; fallback project-ignore interpretation is not promised.

- Add explicit local document full-text indexing and `content:` search across native app, CLI and shared API/MCP/Raycast search. Support bounded UTF-8 text/code, extractable PDFs through a bundled PDFKit helper, and macOS Office/RTF extraction; report unsupported/stale coverage and provide private, unencrypted cache clearing without touching originals. No OCR or query-time directory/content scans. Cached zero results never claim exhaustive current-filesystem coverage.
- Enforce the same 1,000-page PDF limit in the optional `pdftotext` fallback using bounded `pdfinfo` verification. Skip oversized or unverifiable PDFs rather than caching partial text; both subprocesses share the extraction deadline.
- Add content parser, filtering/pagination, snapshot invalidation, extraction/privacy and native preparation/recovery regressions. Scope test discovery to repository test files rather than duplicate release-worktree copies.

- Rebuilt the GitHub feature presentation from a source-backed capability audit, with copyable queries and explicit native/CLI/Raycast, metadata and optional sound-setup boundaries. Removed the unsupported optional document-content-search claim from the release presentation.
- Replaced parent-folder-only demo results with a shared filename-search fixture spanning unrelated folders. Production-backend regressions verify the illustrated query, including folder-only, draft and wrong-extension distractors.
- Added a native filter-control image, reproducible hero artwork and an accessible seven-card query-example graphic. Synthetic data, optional setup and the distinction between examples and captured results remain explicit; no app runtime dependency or benchmark claim is added.

## 0.14.0 — 2026-11-01 (withdrawn numbering mistake)

This preview label was incorrect. Use 0.3.0; the intended sequence is 0.2.0 → 0.3.0.

- Large indexes: replace the 1-GiB streamed-output cutoff with a finite 8-GiB disk budget limited by initial free space minus a 256-MiB reserve. Preserve backpressure, path guards, scan timeout and atomic replacement. Regression tests cross the old accounting threshold without a full scan.
- Release installation pins the expected publisher and requires Gatekeeper approval before changing an existing installation; unapproved preview downloads are rejected.
- Remove unchecked in-app tool downloads and implicit installer opt-in to background indexing. Preserve existing services and saved typing-delay choices.
- Add native light/dark/missing-index demo images, release verification, checksums and third-party notices. Explicitly label the locally signed, non-notarized Apple Silicon preview and unverified manual accessibility/platform coverage.
- Improve missing-index/loading copy, control labels and shared focus/boundary contrast.

### Earlier development notes — 2026-10-30

- Fix native startup when the saved scope has no index: reuse an existing combined or saved snapshot and persist the recovered selection without scanning folders. Explicit unindexed scopes now show index-creation actions instead of a failing search retry; completed indexing reloads scope availability. Direct file paths still work without an index.

- The service starts its search reader before the first keystroke (`SearchProcess.warm()`) and arms the same idle timer for it, so a service that is started and never searched does not hold its reader forever: the reader retires after 10 minutes, whether it was warmed or answered a query (60 seconds before). `scripts/bench-latency.ts ab` on the `everything` index (57 typed prefixes, alternating A/B, priming run discarded) puts the first keystroke at 21.8 ms instead of 29.2 ms (−25 %) and the warm total at 3147 ms instead of 3304 ms (−4.7 %). Regression test: the service has a reader child before the first request.
- The search result cache keeps its answers for five minutes instead of two seconds. The key carries the fingerprint of index, live overlay, media, semantic, favourites and learning files plus the hourly learning bucket, so a changed source still misses; retyping or backspacing to a previous query answers in ~0.3 ms instead of re-running the full trigram query (measured 5–200 ms per key). Only the snapshot body is cached: `presentSearch()` recomputes `stale`, `live`, `complete` and the warning list for the current moment on every hit, so a long-lived entry cannot report an expired age limit or a recovered watcher problem as still current. Eviction is LRU (a hit is touched) instead of insertion order, at 256 entries/16 MiB instead of 64/4 MiB. Regression tests: a hit survives 2.5 s, a reindexed or re-stamped source misses, and after 260 distinct keys the oldest entry is recomputed while the newest still hits.
- A live writer no longer turns a search into a full index scan. When the accelerator answered `SQLITE_BUSY` (the service writes the live overlay while a search runs), `searchPrepared` threw and the service fell back to `searchStreaming`, reading the whole 1 GB path snapshot and hitting its 10-second deadline (observed: `fe search` right after a service start answered `Complete search exceeded 10 seconds; run fe prepare --index everything`). A busy accelerator is now retried once after 200 ms before any fallback; every other error keeps the previous behaviour. Regression test holds `BEGIN IMMEDIATE` on the accelerator for 400 ms and asserts the search still answers from `sqlite-trigram` with no `Fast lookup is unavailable` warning.
- `scripts/bench-latency.ts` makes the keystroke numbers reproducible: `typing <cli>` types every prefix of ten words against the default index over the socket and prints first/mean/p50/p95/max, `ab <cliA> <cliB> [pairs]` primes the page cache for both binaries and runs them alternately so a position effect cannot pass for a speedup. `hyperfine --runs 2 'bun scripts/bench-latency.ts ab /tmp/fe-before ./dist-bin/fe 2'` measured 20.15 s ± 0.14 s per A/B session.
- Read-only accelerator connections map the 3.15 GB search database (`PRAGMA mmap_size=2147483648`) and hold a 64 MiB page cache instead of 8 MiB, so pages stop travelling through `read()`. Warm keystrokes are unchanged within noise (−2.9 % and +0.1 % across two A/B sessions), the first search against a cold page cache measured 3.2 s instead of 10.7 s in a single unpaired observation, which is not proof.
- Reconciliation now ends clean instead of re-flagging the scope. Two causes: the FSEvents helper dropped the journal replay of a freshly rebuilt snapshot after 5 s (base replays millions of paths), and the live service treated `kFSEventStreamEventFlagMustScanSubDirs` — macOS merely asking for a rescan of one coalesced directory — as a whole-scope drift marker. The replay budget is 30 s, a coalesced directory event rescans exactly that directory through the existing bounded `subtree()` path, and only a subtree above 20 000 paths keeps the marker. Measured on this Mac: `base` went from `Journal replay timeout` to no problem after `fe index base` + `fe prepare` + `fe combine`, and a socket search on `base` answers `complete: true`. Regression test injects `flags: 1` and asserts the coalesced file is found with no problem marker.
- ⌥Space now belongs to Find Everything alone: the hotkey is registered with `kEventHotKeyExclusive` instead of the non-exclusive default. The HIToolbox header states that non-exclusive hotkeys notify *every* registrant of the same key code and modifiers, which is why the panel appeared together with another launcher; exclusive registration suppresses those non-exclusive registrants while this app is running. A second exclusive registration now answers `eventHotKeyExistsErr` (-9878) while Find Everything runs, and an already occupied ⌥Space is reported as such instead of a generic failure.
- The Raycast command waits 30 s for `fe search` instead of killing it after 10 s, so the first search after a restart reports the service's own answer instead of a bare timeout.
- Retiring a search reader no longer takes the service down: `process.kill(-pid, 'SIGKILL')` threw `EPERM` on this Mac, and because `retire()` ran inside request, exit and close callbacks the throw killed `fe serve` (`fe-daemon.log`, 2026-10-30). A refused group signal now falls back to `child.kill('SIGKILL')` and finally closes the reader's stdin; no error leaves `retire()`. Regression test forces `EPERM` on group signals and checks that the reader is reaped and replaced.
- The native app no longer reports `Search service timed out` for the first query after a service restart: the socket deadline is 20 s instead of 10 s, above the service's own 12-second search deadline, so its answer or error reaches the UI instead of a bare client timeout; `recv` retries on `EINTR` instead of misreporting a signal as a timeout. Fast transient failures (service starting, unavailable, timed out, read failed) are retried with a 10-second budget, while a genuinely slow search is still reported as is.
- `scripts/install-local.sh` and `scripts/install-daemon.sh` no longer roll back a valid install over launchd timing: after a `bootout` they wait for the label to disappear and retry `launchctl bootstrap`, because loading an agent while launchd is still tearing the previous job down answers `Bootstrap failed: 5: Input/output error`. Observed with the KeepAlive `fe-daemon`; the same file now installs the app, CLI and both agents in one run.
- The native search field can clear its line: ⌘⌫ while typing now empties the query instead of moving the highlighted result to the Trash, a small cancel button appears at the right edge, Esc keeps clearing, and ⌘Z brings an accidentally cleared query back. Home/End and ⌘↑/⌘↓ stay text navigation while the caret is in the field. Regression test covers clearing, restoring and the unchanged ⌘⌫ trash in the results.

- `fe serve --live` accepts repeatable `--live-index NAME`, so a service can keep only the scopes it needs live. Names that are unknown or not indexed yet are reported as `--live-index ignored (not indexed): …` and skipped instead of aborting startup, because a `KeepAlive` agent must not restart-loop over a stale name. The daemon agent now lists `everything`, `base`, `downloads`, `applications`, `sounds` and `hypersearch`; the duplicate 5-million-path roots `home` and `master` stay out of the journal watch (`everything` does not root at `~`, so the home root including `~/Library` is no longer watched) while their overlays report `explicit compaction required`. Measured idle CPU of the daemon: 0.07 s per 25 s window (about 0.2 % of a core) instead of 2.0 s per 21 s (about 10 %).
- Keep incremental indexing alive without the app: a `KeepAlive` LaunchAgent runs `fe serve --socket auto --live`, and `fe serve --live` now waits for a running owner (checked by connecting to the socket, not by trusting a stored pid) before taking the live journal and socket. No wrapper script, so the installer and the agent cannot drift, and quitting the app no longer stops journal updates until the next launch.
- Add a regression test for the takeover: a second live service waits while the first owner runs and becomes the owner after it stops.
- Clear the `Event stream stopped` marker once a root's journal is watching again: restarting the service is not lost data, so a restart no longer forces a full reindex of every scope. Gap and overlay problems stay. Regression test covers the restart.
- Replace the weekly sequential reindex loop with `scripts/fe-maintain.sh`: reconcile only scopes that are missing, stale, older than `FE_MAX_AGE_DAYS` or carry a recorded problem, run bounded prepare passes until fast search is ready, merge `everything` via `fe combine` from the scopes that are actually current instead of walking the disk again, hold a single maintenance lock and log start, duration and result per scope to `~/.cache/hypersearch/maintain.log`. Scopes whose path snapshot exceeds the documented 1 GiB cap are reported as `blocked` instead of retried as plain failures; index and prepare steps run under a wall-clock budget so a hung child cannot keep the maintenance lock.
- `scripts/install-daemon.sh` installs both agents for checkouts and is called by `scripts/install-local.sh` inside its rollback scope. The release installer writes the same daemon plist itself (heredoc, because long `PlistBuddy -c` chains abort on this macOS) inside its rollback scope and does not install the nightly reconcile agent, which needs this repository.

## Unreleased — 2026-10-28

- Keep selected files tied to their paths across result refreshes and provisional results; pause unsafe updates with an explicit refresh option. Restore search-field focus on reopening, multi-file preview stability, filter synchronization and the empty-search web fallback.

- Make native result rows use AppKit selection, multiple selection, double-click and a contextual Open With menu; keep folder, path and existing file actions available. Add Shift-arrow range selection and prevent actions on stale results.
- Open up to 1,000 selected files together, resolving missing pages against the same search snapshot and reporting failures. Quick Look can step through the selected files. Filter multiple extensions by typing a list or using selected file types.
- Add persistent per-extension application choices in Settings, limited to Find Everything; macOS defaults remain unchanged. Add bounded selection, preference and off-screen native table regressions.

- Fix review regressions: explicit Hidden presets now override default hidden omissions; all visibility toggles use one tested search-refresh predicate; learning controls also refresh after their backend update.
- Keep `sort:relevance` on text/learned relevance for media filters and on acoustic similarity for semantic search. Reject non-property sorts in the property comparator; propagate media learning warnings and preference-aware snapshot IDs. Add hidden-alias SQL/streaming, visibility-toggle, media paging/learning and deterministic acoustic-order regressions.

- Share global human-first ranking between native app and Raycast, before pagination: basename relevance first, then documents/Markdown/media ahead of source/config/JSON. Preserve explicit sorting and existing acoustic ranking. Raycast retains backend ordering instead of re-filtering it and starts in the combined saved index when available.
- Add reversible `view:smart`, `sort:relevance`, `omit:noise`, `omit:none`, and `learn:off`. Default app/Raycast views hide system/generated/hidden paths and common logs, lockfiles and compiled artifacts; explicit filenames/extensions reveal artifacts. Hide app-bundle internals and additional generated caches without removing saved paths. Preserve saved visibility choices.
- Require private socket API revision 7 so old services cannot silently serve obsolete smart-view semantics; existing externally owned services remain under their owner's control.
- Learn only from successful opens through shared local, query-scoped, decaying feedback. Add enable/disable/reset/status controls, bounded atomic 0600 storage, hashed query contexts, corruption warnings and feedback-aware cache invalidation. No historical-query pseudo-labels, external training service or new dependencies.
- Avoid a whole-index noise-ID scan and whole-index relevance sort for empty smart previews. Add SQL/streaming parity, deep-page/global ranking, Unicode, reversibility, explicit technical intent, read-only search, opt-out, reset and positive-feedback regressions. See [research and evidence](docs/SEARCH-RELEVANCE.md).

## 0.13.0 — 2026-10-19

- Translate opt-in German/English file clauses into existing indexed filters: file groups, sizes, rolling day ranges, favorites, folders, names and sorting. Preserve quoted folder/name values, literal parentheses and local sound clauses. Reject unsupported or conflicting conditions; no additional model or query-time folder traversal.
- Coalesce identical native query notifications and unquoted whitespace changes. Keep explicit refreshes after indexing, property extraction, sound analysis, favorites and live updates. Wait quietly for closing parentheses/quotes with an inline footer hint instead of sending incomplete requests.
- Add Search in This Folder to result menus, Quick Actions and Command-Option-F. Keep the current text and other filters, quote folder paths and include the directory separator to avoid sibling-prefix matches. Open the existing inline folder filter for easy adjustment.
- Invalidate natural-language favorite responses when pins change. Add fixed development/validation cases and real indexed-file tests covering metadata, unknown values, folder boundaries and existing sound behavior.
- Extend the first-result phase to empty views and size/date filters. Use metadata range indexes before sorting instead of counting all matching/unknown properties first. Explain zero matches with unknown file properties in the empty state.
- Require socket API revision 6 so an older shared service cannot silently interpret new file clauses as audio descriptions. Existing externally owned services remain under their owner's control.

## 0.12.0 — 2026-10-19

- Show a correctly sorted first range before expensive exact counts. Native searches opt into `phase=preview`; provisional replies expose no invented match count, and full CLI/MCP/default API replies retain exact coverage. Complete the count after 80 ms of idle input while navigation and preview stay available. Preserve indexed ordering for small result sets too.
- Retain selective trigram plans above 10,000 matches when they cover a small fraction of the index. Choose covering sort scans by selectivity, and serialize live accelerator writes between reader jobs to avoid blocking the service on its own SQLite read lock.
- Cancel obsolete native searches through the private socket and stop their actual SQLite reader process. Remove the foreground wait for an older request. Carry session/generation IDs through API revision 5, reject late generations and cancel an app's own obsolete prefetch without interrupting other clients.
- Keep one reusable reader, one queued request, bounded caches and a 12-second deadline. Reap a canceled reader before starting its replacement; retain completed HTTP and native result caches. Keep live writes outside the disposable reader and stop its associated local sound-model children with it.
- Wake native socket reads immediately on task cancellation with descriptor-safe shutdown. Use the search service for all native queries, including startup, instead of spawning uncancellable fallback searches. Add real SQLite interruption, client isolation, typing-burst, disconnect and crash-recovery tests.

## 0.11.2 — 2026-10-19

- Reuse bounded SQLite TEMP tables in RAM for sparse exclusions, broad-term complements and directory membership. Cache at most two million integer IDs per open index, cap each set at one million, protect sets used by the current query and invalidate them on snapshot/property changes. Queries keep the existing on-disk schema and never traverse folders.
- Count broad terms through the smaller unmatched directory branch and subtract intersecting exclusions. Count known size/date properties with their existing indexes. Avoid expanding common trigram terms into millions of temporary candidates; retain selective trigram lookups and exact substring checks.
- Keep live property reads on a separate read-only connection with a 1 MiB page cache, so maintenance in other scopes cannot evict the active query's RAM tables. Retain least-recently-used search connections; actual changes still invalidate their scope.
- Add broad-search correctness coverage across eight sort orders, sparse properties, cache eviction and source replacement, plus a source-bound socket benchmark against the previous executable.

## 0.11.1 — 2026-10-19

- Synchronize native search-field and result-table focus. Arrow navigation hands input to the results; Space previews there and remains a literal space in search/filter fields. Closing preview restores result focus. An unavailable row queues one preview/open action bound to its row and query generation.
- First arrow enters the highlighted row; further arrows move selection. Escape or Left returns to search without clearing it. Right or Tab opens quick actions, and Tab/Escape closes them. Command-F/L reliably selects the query; Command-C copies search text while editing and paths from the results.
- Typing from results starts new search text while preserving active filters. Disable smart quote/dash substitutions in query input. Add optional keyboard hints in Appearance. Empty lists never capture result navigation.

## 0.11.0 — 2026-10-19

- Replace the 300–900-row native window with an AppKit table whose scrollbar addresses the entire match count. Remove earlier/more buttons. Reuse visible cells and fetch neighboring ranges automatically through the existing private socket.
- Keep up to 32 ranges and four recent initial views in a RAM LRU with a shared configurable 16/32/64 MiB accounting budget; resize the cache immediately when its budget shrinks. Bound resized visible-file icons to 512 entries and 2 MiB. Preserve the displayed list while searching. Save a bounded startup view once and on changed exits; never rescan directories for a query.
- Cache query counts and small exclusion sets in the search process. Keep broad hidden-folder filtering on covering sort indexes, and read deep result ranges from the nearer end of the ordering. Preserve globally sorted pages, unknown metadata, favorites and snapshot invalidation.
- Address keyboard selection globally, including Home/End and preview navigation. Prioritize the current viewport over prefetch after scrollbar jumps; discard canceled query replies.

## 0.10.0 — 2026-10-18

- Share native favorites with `fe favorites list|add|remove`. Combine `favorites:true` or `is:favorite` with global name/type/size/date filters, media and sound search. Preserve existing pins and invalidate socket results when favorites change.
- Default the native view to hiding macOS system and common generated folders, keeping the saved index intact. Add explicit `view:all`, `view:working` and `omit:system;generated;hidden` controls; CLI searches keep all paths by default.
- Coalesce visible updates at a configurable interval, five seconds by default. Quiet refreshes retain rows, selection and timing, and leave loading buttons enabled. Avoid republishing unchanged lists/status values. Count a broad working view by subtracting excluded indexed rows from the saved total.
- Load 600 rows initially, configurable to 300 or 900, while retaining the 900-row window. Add preview autoplay and visibility options; preserve settings when optional fields are added.

## 0.9.0 — 2026-10-18

- Add separate collapsible inline filter and sort bars. Click Name, Path, Size or Modified to sort directly and reverse on a second click. Combine global filters, choose presets or enter values, and clear each active filter independently without popup windows.
- Add reverse name/path ordering, filename-only fragments, quoted folder paths, multiple extensions, exact sizes and inclusive size ranges. Apply these before pagination, including media search. Explicit sound sort orders now apply; default sound queries retain acoustic ranking.
- Open a native Quick Look preview with Space after selecting a result, or Command-Y. Keep spaces available while typing queries and filters. Reuse the preview while navigating; stop preview resources when it closes. Avoid spawning qlmanage.
- Keep the information icon present and give the menu-bar item a persistent identity and a distinct template symbol. Keep Dock visibility independent from window/popup mode; expose the setting under Appearance.
- Remove the top pagination strip; retain keyboard page navigation and load earlier/more results inside the list. Use stable path identities while changing pages. Close help and actions with Escape or a click outside.

## 0.8.0 — 2026-10-18

- Search complete indexed name/path matches through embedded SQLite trigram indexes, with exact counts, stable pages and global name/path sorting. Apply known size/date filters before page limits; report unknown properties explicitly.
- Combine overlapping saved snapshots into an All indexed files view, reusing audio metadata and local sound vectors without another filesystem traversal. Use the combined profile as the CLI/API/MCP default when available.
- Add global sort/type column controls, first/previous/next/last navigation and Home/End across the entire result set. Keep at most 900 result rows in the native view; clicks only mark rows. Preserve loaded rows during live refresh and complete requested page changes across snapshot revisions.
- Prepare recoverable search caches with checkpoints, reuse existing media properties and update affected rows from the live journal. Keep unchanged queries and idle journals free of repeated writes. Missing saved scopes require explicit indexing.
- Fix lost live-event batches when a parent disappears during ignore checks, non-audio property invalidation, stale writer counters and SQLite FTS trigger counts. Bind counts, pages and snapshot IDs to one read transaction.
- Update existing file properties without deleting/reinserting their unchanged filename/FTS rows. Narrow small path-sort result sets before ordering. Show unknown indexed sort properties as unknown in the native table and provide standard Select All/Paste editing commands.
- Keep Raycast on the compiled CLI path, with browsing for empty/single-character queries and separate cancellation for index work. Preserve certificate-bound app/helper signing across updates.

## 0.7.0 — 2026-10-18

- Use opaque light/dark result surfaces, a contrasting selection and compact columns. Configure theme, density, text size, icons, stripes, metadata columns and preview in persistent settings.
- Add saved query/scope bookmarks (⌘⇧D), typing-delay controls and optional history, habit ranking and result grouping. Keep audio tools under their own settings tab.
- Sign the app and bundled CLI/media/event helpers with a pinned existing certificate. Updates keep their designated requirements across changed builds; reject unavailable identities and implicit certificate rotation. Install through staged moves with rollback, without resetting macOS access.
- Document the theoretical gaps against Everything 1.4 stable and 1.5 beta, including complete result sets, global sorting and macOS indexing limits.

## 0.6.0 — 2026-10-18

- Apply persistent macOS file-journal changes as a bounded SQLite overlay. Creating, renaming and deleting paths does not rebuild the base index; stopped services replay from their durable cursor. Journal gaps remain explicit.
- Refresh properties and configured local sound vectors for changed media. Retry unknown audio by canonical file and reader version; reuse unchanged failures and exclude AppleDouble sidecars.
- Move index coverage, audio actions and diagnostics into search options (⌘,). Keep the result view quiet and refresh visible results only when their index changes, preserving selection.
- Remove age-triggered full scans from all search callers. Explicit rebuild remains available for reconciliation. Add live-update, idle-write, restart, media and Codex acceptance checks.

## 2026-10-18: 0.5.0

- Parenthesized German/English audio intent with visible deterministic filter translation; optional local CLAP q8 audio/text retrieval with pinned weights, integrity checks and offline inference.
- Explicit bounded sound analysis, fingerprint/model cache, negative cache, transactional checkpoints, coverage, acoustic scores, pagination and changed-match rejection. App setup/analysis controls; no query-time audio decoding.
- Empty-query snapshot browsing with bounded in-memory page checkpoints, single-character search and visible root/count/freshness. Preserve acoustic ordering in the native window. Socket protocol revision 3.

## 2026-10-18: 0.4.0

- Shared duration/channel/sample-rate/dimension predicates and deterministic German short-sound queries across CLI, native app, API, MCP and Raycast.
- Explicit media enrichment with SQLite snapshots, size/mtime reuse, bounded batches, checkpoints, a native audio reader and ffprobe fallback. Queries report unknown coverage.
- Private authenticated Unix socket, bounded two-second result cache, two-request admission and idle exit. App/API/MCP searches avoid age-based full rescans.
- Persistent resizable window mode, keyboard-only selection scrolling, click-only marking, separate history shortcuts and search focus. Bounded in-memory interaction diagnostics.
- Fixed intermediate candidate caps hiding later matches; added media/socket/navigation regressions and controlled transport/extraction benchmarks.

## 2026-10-18: 0.3.0

- Named project/folder indexes, multiple roots, ad-hoc `--path` searches and persistent per-index settings. CLI and native/Raycast scope pickers share the catalog.
- Include/exclude/ignore/refresh controls, structured JSON and NUL output, foreground folder watching, Bash/Zsh/Fish completion.
- Token-protected loopback HTTP API and stdio MCP tools for file search, index listing and refresh. No host configuration or background service is added automatically.
- Fixed stale CLI/native indexes and text previews. Failed scans retain the prior index; process locks, time/output limits and child cleanup bound recovery.
- Fixed byte-based sharding truncating paths. Shards now preserve complete lines and UTF-8 names without an external `split` process.
- Native folder picker, saved scope persistence, visible search/index errors and local install with rollback copies.
- Fixed reopening a hidden panel; added a menu bar entry, checked hotkey registration and handler cleanup. Hotkey toggling checks application activation as well as window visibility.
- Added isolated CLI/index/API/MCP/watch regressions and project indexing documentation.

## 2026-10-16 (f)

- Query language (engine-level: works in the app, the Raycast extension and the `fe` CLI):
  `ext:md;pdf` / `*.md` extension filters, `in:downloads` / bare `invoice in downloads` location scoping,
  `type:doc|image|video|audio|zip|code|app` macros, `!noise` exclusion, `a|b` alternation,
  `"exact phrase"` literal, `sort:name|new|old|big|small`, `size:>10m`, `dm:today|week|<n>d`.
- Query history: `↑` on the first result row cycles through past queries, `↓` walks back; persisted in `history.json` (last 30).
- `⇧Tab` in path mode jumps to the parent directory.
- Dead-end rescue: `↵` on an empty result list opens a web search instead of doing nothing.
- Shortcut hints render as Raycast-style keycaps (one cap per key, combos side-by-side); action panel and help card can no longer overlap.
- Fixed: early `-m` exits left orphaned `rg` processes blocked on full pipes; all pipeline children are killed when fzf finishes.
- `install.sh` now also installs a LaunchAgent so the app (and ⌥Space) starts at login.

## 2026-10-16 (c)

- Native macOS app `app/Find Everything.app`: SwiftUI/NSPanel floating panel, global `⌥Space` hotkey, shared `fe` engine + shared index. Build via `app/bundle-app.sh`, install via `install.sh`.
- Onboarding: missing tools (`fe`/`fd`/`rg`/`fzf`) are downloaded from GitHub releases into `~/Library/Application Support/FindEverything/bin`: no Homebrew or admin rights.
- Full keyboard control: `⌘K` action panel with type-to-filter and `→`/`←` submenus (Open With…, Switch Scope), `⌘↵` folder, `⌥↵` reveal, `⌘D`/`⌘I` details, `⌘Y` Quick Look, `⌘T` Terminal, `⌘⌫` Trash, `⌘1`–`⌘6` + `⌘⌥←`/`→` scopes, `⌃N`/`⌃P`/`PgUp`/`PgDn`/`Home`/`End` navigation, `⌘W` hide, `⌘Q` quit, `⎋` back (clears query first).
- Mouse parity: hover selects, double-click opens, right-click context menu mirrors the action list, `⋯` footer button opens ⌘K panel.
- User habits: "Recently Opened" when the query field is empty, opened items rank higher; stored in `~/Library/Application Support/FindEverything/opens.json`.
- Detail pane shows text previews for code/text files and image previews; toast confirmations for copy/trash.
- Keys are captured via a local event monitor: arrows and Enter now work while the search field has focus (the text field's editor previously swallowed them). Fixed `⌘K` never firing (wrong keycode 37→40) and swapped `⌘5`/`⌘6` scope keys.
- `FE_REMOTE=1` enables a `/tmp/fe-cmd` test channel for deterministic UI automation; `FE_KEEP_VISIBLE=1` keeps the panel up for screenshots.
- `fe` no longer crashes with EPIPE when piped into `head`.

## 2026-10-16 (d)

- Pins (`⌘P`): pinned files show a pin badge, lead the recents list and rank above other results; stored in `pins.json`.
- Path passthrough: typing or pasting an existing absolute/`~/` path resolves it directly: Enter opens without touching the index.
- Footer shows measured search latency (`80 results · 60ms`).
- More file actions: Duplicate (`<name> copy`), Compress to zip, Copy file contents (`⌘⌥⇧C`), Share via NSSharingServicePicker, Finder Get Info on `⌘I`.
- Result rows are draggable file references into Finder or other apps.

## 2026-10-16 (e)

- **Fixed real-keyboard arrows**: physical keyboards mark ↑↓/nav keys with `.function`; masking modifiers to just ⌘⌥⌃⇧ makes navigation fire on real hardware (synthetic tests had masked the bug).
- Grouped results like Raycast: sections "Pinned" → "Recently Used" → "Applications" → "Files & Folders", with in-list headers.
- Hotkey reference moved out of the footer: `?` button or `⌘/` opens a shortcuts card; `Keyboard Shortcuts` is also an entry in the ⌘K panel. Footer stays clean (status + latency + `?`/`⋯` buttons).

## 2026-10-16 (b)

- Standalone CLI `fe` for macOS and Linux: same engine as the Raycast extension, shared index at `~/.cache/hypersearch`. Commands: interactive picker (`fe`), `fe search`, `fe index`, `fe status`, `fe open`, `fe preview`.
- Engine extracted to `src/engine.ts`; the Raycast command is now a thin UI on top of it.
- Fixed `rg` dir-search printing `shard:/path` filename prefixes (`--no-filename`).
- Fixed bare-name binaries (`open`, `xdg-open`, PATH-resolved `rg`) resolving as missing.
- Bun-compiled binaries for darwin-arm64, darwin-x64, linux-x64, linux-arm64.

## 2026-10-16

- Speed: index split into 8 shards, `rg` scans them in parallel: typical query ~30ms (was ~150ms via Node stream). Worst-case queries (e.g. "e") capped at ~30ms instead of ~3s via per-shard `-m` limits.
- `rg` now reads index files directly (mmap/page cache) instead of a Node.js pipe.
- Shards auto-heal: missing dir is re-split from the flat index in ~150ms, no rescan needed.
- Page cache warmed at startup so the first keystroke is not a cold disk read.
- Default index refresh interval 15 → 60 min (less background churn).

## 2026-10-17

- Initial: HyperSearch Raycast extension: persistent `fd` index per scope (`~/.cache/hypersearch/index-<scope>.txt`), `fzf --filter` fuzzy ranking, real Finder file icons, lazy stat for size/mtime, stale-while-revalidate index refresh (`Cmd+R` forces rebuild). No Spotlight dependency.
