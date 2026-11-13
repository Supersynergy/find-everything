# Find Everything 0.3.44 · Apple Silicon preview

`fe explain` now reads saved metadata without counting property rows across the entire index. On the installed 69-million-path snapshot, the previous command exceeded a 20-second diagnostic timeout. The metadata-only command returns the property count as `null` with `propertiesCountExact:false`. The installed command completed in 30 ms; three Hyperfine runs averaged 29.4 ms. [Measurements](../benchmarks/2026-11-13/v0.3.44-summary.json). Exact property counts remain available to existing status callers. Search matching and indexed paths are unchanged.

The previous release's bounded passage cache remains enabled. Existing scanner and journal gaps remain visible. At inspection the volume had only about 10 GiB free; the global path file occupies about 10 GB and its lookup about 28 GB. A full replacement needs more disk headroom. No original index files were removed.

This Apple Silicon preview requires macOS 15+. It is locally signed and not notarized. Intel and manual VoiceOver acceptance remain unverified.
