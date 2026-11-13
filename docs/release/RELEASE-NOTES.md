# Find Everything 0.3.40 · Apple Silicon preview

Resume a merge of saved paths and journal changes with `fe compact --index NAME`, or use **Settings → Indexes → Merge saved changes (resume)**. The merge preserves changes after its snapshot watermark, CR/LF filenames and previous files. Interrupted publication is recovered before the index is read. Real history gaps remain visible: use the explicit rebuild/reconciliation action to scan the configured roots again. Disk limits and the 2-GiB reserve remain enforced.

Large indexes retain exact count results across reader and app restarts. The private cache is bounded to 128 entries per scope and is used for scopes with at least 100,000 rows. Snapshot and query changes invalidate entries; first-time queries still compute their exact counts. Filename ordering, filters, provisional previews and current coverage warnings are preserved. See the [maintenance guide and measurements](../MAINTENANCE-0.3.40.md).

**Index with local OCR** adds scanned PDFs and images to the existing explicit document-content pipeline. The CLI equivalent is `fe content index --index NAME --ocr --ocr-pages 32`. Recognized text includes page/method provenance, remains local, and is checked against the source file before and after extraction and during search. The default limit is 32 pages per document; oversized or unsupported documents remain reported. OCR can misread text and does not run while searching. Existing Instantfind settings, models and prepared vectors remain supported.

## Install and compatibility

Download the app archive, manifest and checksums from this release. Verify with `shasum -a 256 -c SHA256SUMS.txt` before opening. Local source installation uses `bash install.sh --local` and retains a rollback copy. Existing path indexes need no rebuild to use the count cache or OCR feature. After a compaction changes snapshot identity, document/meaning caches may need an explicit refresh; unchanged extracted text and vectors can be reused.

The archive is an **Apple Silicon, macOS 15+ preview, locally signed and not notarized**. Gatekeeper may refuse it. Intel, older macOS and manual VoiceOver acceptance remain unverified. Performance measurements use controlled fixtures and do not establish universal search latency or filesystem completeness. Permissions, explicit exclusions, resource limits, unsupported documents and recorded history gaps still apply. Model weights and Python environments for optional meaning/audio search are supplied separately.
