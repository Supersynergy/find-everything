# Find Everything 0.3.43 · Apple Silicon preview

Meaning search now reuses passage vectors in its resident model worker. Moving to another results page can reuse the same passages without running their inference again. Ranking and source-version checks still run on each search. Query vectors also belong to the current worker: changing model files, configuration or worker code discards cached values. Closing the worker clears them.

The passage cache holds at most 512 vectors and 2 MiB of accounted payload. Query vectors have a separate 128-entry / 1-MiB bound. Keys are hashes. No document text or new persistent cache is written. A new process still has a cold start, and new passages still require inference.

In a paired replay of 40 known questions over the same prepared document corpus, all 80 result pages retained identical paths, order, scores and snippets. Median next-page time fell from 382 to 65 ms; first-page time remained near 400 ms. Hyperfine measured 7.70 versus 3.91 seconds for eight two-page searches including process/model startup. These are worker-pipeline measurements, not native UI timings or another blind retrieval evaluation. See [method and limits](../PASSAGE-CACHE-0.3.43.md).

The existing large-index coverage warnings remain visible. This release does not rebuild the full filesystem index. Limited disk headroom requires separate maintenance planning. Local OCR and the existing filename controls remain supported.

Apple Silicon, macOS 15+. This preview is locally signed and not notarized. Intel and manual VoiceOver acceptance remain unverified.
