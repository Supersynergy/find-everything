# Find Everything 0.3.46 · Apple Silicon preview

The watcher consolidates pending filesystem events in SQLite while searches continue. Consolidation preserves newer events and directory-removal revisions. Run `fe journal --index everything` to see pending and consolidated row counts, the current watermark, and any outstanding coverage warning. The default threshold is 750,000 pending paths. The watcher moves up to 2,048 rows per transaction and resumes from a saved revision after a restart, including for indexes without a prepared lookup. To request an earlier merge, run `fe journal merge --index everything`.

Recent-change reads now use a scope and revision index. A seven-run Hyperfine benchmark fetched the latest 256 of 320,000 paths in 9.8 ms on average, including process startup. The previous layout took 31.3 ms. The additional index increased the fixture database size from 56.0 to 63.6 MiB. [Benchmark results](../benchmarks/2026-11-14/v0.3.46-summary.json).

When a bulk repair leaves the filename lookup behind, the first-page filename preview can return provisional results while the remaining revisions are applied. The result identifies pending counts and pagination.

Explicit flat-snapshot exports now checkpoint after roughly 16 MiB and at the end of each work slice. A 150,000-path export wrote four checkpoints, down from 40, with identical output bytes.

This Apple Silicon preview requires macOS 15 or later. It is locally signed and not notarized.
