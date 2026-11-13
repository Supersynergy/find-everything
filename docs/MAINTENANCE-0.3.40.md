# Find Everything 0.3.40

## Saved changes and lost history

`fe compact --index NAME --rows 1000000 --seconds 30` exports a pinned prepared lookup in bounded batches. Repeating the command resumes its checkpoint. The previous snapshot stays available until publication. Changes after the pinned journal watermark remain in the overlay; CR/LF filenames are retained there because the flat path format cannot represent them. A durable intent completes interrupted publication before the new snapshot is used. Previous path, lookup and metadata files remain in `index-NAME.txt.compacting/previous.*` for recovery.

Compaction never fills gaps in event history. `fe reconcile --index NAME` explicitly traverses the configured roots again, preserving the previous snapshot if scanning fails. The native **Rebuild current index** action provides progress/cancellation; **Rebuild with all accessible files** includes hidden/generated paths subject to permissions and explicit exclusions. Inaccessible files remain reported. No automatic broad scan is started by an ordinary search.

Compaction changes the saved snapshot identity. Existing document/meaning caches may request explicit refresh afterwards; unchanged document text and vectors can be reused during that refresh.

Compaction reserves 2 GiB and conservatively requires room for the remaining path export. APFS clones reduce duplication of the prepared lookup; a filesystem without clone support also needs space for a full lookup copy. A lack of space returns an error while retaining resumable data. Run `fe compact status --index NAME` to inspect the saved checkpoint. New compactions retain completed prior generations as `.compacting.backup-*`; remove an old generation only after checking the current snapshot and its backup.

## Exact counts across restarts

The filename/path matcher remains exhaustive. For scopes with at least 100,000 rows, up to 128 exact count results per scope are persisted in `counts-NAME.sqlite`, with a 512-page SQLite budget and private file permissions; its persistent rollback journal is limited to 1 MiB after commits. Keys hash the query/filter and physical/logical snapshot identity; cached entries contain only counts. Changed names, properties, files, identities or query dependencies invalidate the key. Corrupt or unavailable caches fall back to counting. This helps repeated broad/short queries after reader retirement or app restart; the first unseen query still pays for its exact count. Provisional previews retain their existing separate behavior and are never cached as exact counts. Internal count-cache metadata writes do not trigger a journal feedback loop; creation, deletion and rename events still expose those filenames.

## Local OCR

```sh
fe content index --index NAME --ocr --ocr-pages 32 --max-files 100 --seconds 60
fe search 'content:"Polarstern"' --index NAME --json
```

The native action is **Settings → Indexes → Index with local OCR**. It uses Apple's on-device Vision recognizer on scanned PDFs and supported PNG/JPEG/TIFF/HEIC/BMP/WebP images. PDF pages combine embedded and recognized text. No model download, cloud upload or new Python dependency is required. Existing Instantfind can use the resulting cached text after explicitly updating its meaning index.

Each result includes extraction method, page numbers and recognition confidence where available. OCR can misread text. Inputs are limited to 32 MiB, recognized text to 2 MiB and images to 25 million pixels. The default OCR page limit is 32 per file; CLI accepts 1–100. Documents exceeding the page budget are rejected rather than represented by a silently truncated excerpt. Source identity is checked before and after extraction and again during search. Hidden, unsupported, encrypted, changed or unreadable sources remain excluded or unknown as reported. Cached text is private but not encrypted.

Regression fixtures cover scanned image/PDF recall, page provenance, page-budget rejection and stale sources; journal tests cover three interrupted publication stages and concurrent post-watermark changes. Performance results are recorded separately from these correctness checks.

## Measurements

The final compiled binaries were compared on one million synthetic saved paths. Each Hyperfine command starts six fresh CLI processes, alternating two short queries. One warmup and three measured commands per version were used. Result counts and ordered path hashes must match. Whole-command wall time was **1.004 ± 0.046 s** for 0.3.9 and **0.591 ± 0.034 s** for 0.3.40; CPU time was **0.829 ± 0.003 s** and **0.451 ± 0.005 s**. These are repeated-query/cache measurements with process startup included, not first-use or native UI latency. OS caches and concurrent host activity were uncontrolled.

The new compactor exported the same million paths in five separate CLI invocations, checkpointing every 250,000 rows. Total measured time was **2.79 s**, including startup and publication. The exported path file had exactly the same SHA-256 as the input. This fixture had no lost history; separate regressions verify preserved gap warnings, concurrent later events and CR/LF filenames.

Local OCR indexed **two raster documents with three pages** in **1.523 s**; the previous text-only path indexed neither document. This tests those generated scans, not general OCR accuracy. The release also passes 32 TypeScript test files and the native navigation/model/content/indexing/presentation checks. Earlier experimental timing runs and failures are retained in the local evidence archive. The persistent cache is restricted to scopes with at least 100,000 rows to avoid unnecessary writes on small indexes.

See [machine-readable measurements](benchmarks/2026-11-13/v0.3.40-summary.json). Reproduce the count comparison with `bun scripts/bench-maintenance.ts compare /path/to/fe-0.3.9 /path/to/fe-0.3.40 /fresh/evidence-directory`. No full-disk reconciliation, full-index OCR, Spotlight/Raycast comparison or timed native interaction was performed for this release.

Technical references: SQLite's [trigram documentation](https://www.sqlite.org/fts5.html#the_trigram_tokenizer) explains the limitation for terms shorter than three Unicode characters. OCR uses Apple's [Vision text-recognition API](https://developer.apple.com/documentation/vision/recognizing-text-in-images).
