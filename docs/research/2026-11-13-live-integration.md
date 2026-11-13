# Live indexing and API responsiveness

The measured integration separates the API event loop, the existing live journal/metadata pipeline, and the disposable search reader. It adds one owned live process and reuses the existing process-group guardian. No new dependency, database format or model is introduced.

The live process writes the journal and updates media metadata. Before a path search, its reader applies pending journal changes to the prepared SQLite lookup. Only that requested scope is synchronized. The API remains available while either child does synchronous work. Cached responses bind to the returned logical revision and physical file fingerprint, including the opened inode; independent query dependencies must remain unchanged. Existing shared-search cancellation still applies. An interrupted writer is recovered through a writable SQLite connection before read-only lookup resumes.

Each response recomputes current warnings. A snapshot behind the journal is pending and incomplete. Filesystem journal gaps, explicit exclusions and missing metadata remain visible. No limit or hidden-file setting was loosened to obtain the benchmark result.

## Acceptance and measurements

See [the benchmark report](../BENCHMARKS-2026-11-13.md#live-processing-and-api-responsiveness) and [machine-readable results](../benchmarks/2026-11-13/live-summary.json). Three deletion replays per variant preserve exact remaining paths and journal-gap warnings. Tests cover parent death, worker/helper cleanup, rollback recovery, cache invalidation after external edits/replacement, and the pending-state envelope.

The tradeoff is an additional process and synchronization on the first search after updates. The replay observed about 72 MiB more summed RSS after processing, and approximately 100 ms per first updated-scope search versus 3 ms after the previous background synchronization. This integration improves responsiveness during live batches; it does not make every search faster.

## Further integration order

1. **Journal recovery and compaction.** The installed large index still reports history gaps and an overlay budget problem. Build a resumable merge from the saved path snapshot plus a journal watermark into a staged replacement. Keep the old snapshot until count, exact membership, Unicode paths and post-watermark replay pass. Interrupted work must resume without clearing gap evidence. Compaction alone cannot restore missing journal history; affected roots need explicit reconciliation.
2. **Broad-query planning.** Measure query execution, exact counting, synchronization and serialization separately at 100k, 1m and large-index scales. Preserve usable provisional pages while exact totals run. Trial selective short-gram postings or smaller candidate sets only for workloads that miss their latency budget; retain the exhaustive matcher as the correctness oracle. Account for added disk, build time and RAM before adopting another index.
3. **Document search.** Extend the existing explicit content pipeline with bounded extraction/OCR, content hashes and extraction provenance. Keep filename lookup independent of document extraction. Measure recall against known text and image-only documents, including extraction failures and changed files.
4. **Meaning search.** The separately completed Instantfind branch is merged into this release, preserving the already installed optional `meaning:` mode, compact tokenizer, sequential embedding batches and model reuse after successful use. Its [42-file, 48-query DE/EN evaluation and limits](../INSTANTFIND.md#vergleich-mit-echten-projektdateien) remain separate from the filename replay. Expand that selected document/project catalog with held-out queries. Keep exact paths and identifiers on the deterministic route; no embedding of all 69 million paths or per-query indexing.

For a Spotlight/Raycast comparison, use the same known-file corpus and queries, including hidden files, generated folders, external volumes, stale/deleted paths and composed/decomposed Unicode. Record recall, ordering, completed p50/p95, timeouts, first-use latency, freshness and memory separately. No competitor application was benchmarked in this slice.
