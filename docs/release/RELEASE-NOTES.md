# Find Everything 0.3.6 · Apple Silicon preview

Automatic loading of page two no longer counts every file in a relevance tier. A bounded offset probe preserves ordering and exact overall counts, caching only proven exact bucket sizes. No index rebuild or changed display filters are required. See the [latency measurements](../BENCHMARKS-2026-11-13.md#relevance-page-offsets) for the full-index observation and isolated Hyperfine result.

Live subtree updates now handle temporary directories disappearing or becoming files between inspection and traversal. Successful coalesced directory scans replace their previous descendants, removing stale files. Genuine scan errors remain visible; traversal and path budgets remain bounded. Deterministic regressions cover all three cases.

Repeated notifications for the same path no longer exhaust the live-event queue. Coalesce flags and scope targets before enforcing its 20,000-distinct-path bound, including unscoped notifications that apply to every saved scope. A regression exercises 65,536 repeated events across two scopes.

Apply large journals with up to one million changed paths. Indexed directory ranges avoid a full directory-table scan for every subtree deletion. Live updates preserve CR/LF filenames; the flat scan format still reports these as skipped until recovered through a live event. Each saved scope receives its own processing budget. See the [predicate benchmark](../BENCHMARKS-2026-11-13.md) for the isolated performance comparison and its limits.

Version 0.3.2 increased the finite path budget to 32 GiB and the search-preparation budget to 48 GiB, each constrained by available space and a 2-GiB reserve. Preparation remains resumable and failed scans preserve the previous snapshot.

Find files that a normal scan excludes, and search accented filenames consistently.

- `--exhaustive` includes hidden files, ignore-file matches, generated folders, `Library`, `.local` and mounted volumes within the selected roots. Explicit exclusions, permissions, scan time and disk limits remain. Settings persist across rebuilding and incremental updates.
- Native Settings offers an inclusive rebuild and a show-all action. New preferences display all indexed paths; saved preferences are preserved. Adding a folder includes generated files unless project source only is selected.
- Composed and decomposed accented names match in filename, path and folder filters. Paths keep their exact spelling. Existing accelerators stay usable; explicit preparation upgrades their derived Unicode keys without another folder traversal.
- `in:/path/Invoices` no longer includes `Invoices-old`. Prepared folder restrictions use the directory index.
- Scanner errors and skipped newline-containing paths are reported as incomplete coverage. Live deletion beneath emoji folders removes descendants correctly. Application folders match before and after lookup preparation. Missing watcher PIDs no longer produce an invalid process signal.
- Update the Raycast API and dependency lockfiles. The release includes a synthetic Hyperfine script and regression fixtures. See the [benchmark report](../BENCHMARKS-2026-11-12.md) for results and limits.

## Update and include missing files

Download the app archive, manifest and checksums from the release page. Verify them with `shasum -a 256 -c SHA256SUMS.txt` before opening the app. A local source installation can be updated with `bash install.sh --local`; it retains a rollback copy.

For an existing index:

```sh
fe index --index work --exhaustive
fe prepare --index work
fe search 'receipt view:all' --index work --json
```

Use your existing index name in place of `work`. Existing snapshots acquire newly included paths after the explicit rebuild. In the app, choose Settings → Indexes → Rebuild with all accessible files, then Settings → Search → Show all indexed files.

## Preview limits

The archive is an **Apple Silicon, macOS 15+ preview, locally signed and not notarized**. Gatekeeper may refuse it; signing and checksums do not replace Apple notarization. Intel, older macOS and manual VoiceOver/interactive acceptance are unverified. Production screenshots remain synthetic offscreen renderings. Benchmarks use isolated saved paths and do not measure an entire disk.

Permissions, explicit exclusions, resource limits, scan-skipped CR/LF paths and stale snapshots still bound coverage. All-index scans omit virtual filesystems and the duplicate `/System/Volumes/Data` tree; directory symlinks are not followed. No personal disk scan or document-body indexing is performed by the release checks. Optional sound models and search tools are not bundled. The previous previews remain available.
