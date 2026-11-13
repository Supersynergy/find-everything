# Find Everything 0.3.42 · Apple Silicon preview

This release integrates the completed Instantfind passage-refinement work with the special-character and native-table improvements from 0.3.41. Up to twelve selected late passages improve document recall, with additional query latency. See [the real-document measurements](../INSTANTFIND.md).

Use Filters → Literal text or `fe search --literal --query 'a|b'` to search punctuation as text. For example, `literal:"report (final)!"` keeps the exclamation mark and parentheses. Quotes and backslashes work too. Escaped CR/LF filenames keep their meaning, and returned paths retain decomposed accents. NUL is rejected because a filename cannot contain it.

The filter bar offers Case and Whole words. `case:yes` forces case matching; `case:no` ignores case; `case:smart` recognizes Unicode uppercase in plain terms. Add `word:yes` to match at word boundaries. Unicode letters and combining marks count as word characters, as do numbers and `_`. Saved searches retain these options. No index rebuild is needed.

AppKit now manages a moving window of at most 10,000 rows. Scrolling continues into adjacent ranges. First/Last and Go to result reach any global row; there are also buttons to jump 10,000 results. This bounds table bookkeeping after a live 69-million-result session grew to tens of GiB.

`fe explain QUERY --index NAME` shows matching rules and active visibility filters together with saved-index warnings. It reads metadata without scanning folders. Interrupted compaction checks every component before renaming anything: changed targets or missing stages stop publication and preserve the files. Invalid checkpoint offsets and unknown compact subcommands now fail explicitly.

See [search modes and research](../SEARCH-0.3.42.md) for details, including limits on Unicode matching. The [benchmark evidence](../benchmarks/2026-11-13/v0.3.42-summary.json) records the measured workload. Existing compaction and count caching remain available; local OCR and Instantfind are retained.

This is an Apple Silicon preview for macOS 15+, locally signed and not notarized. Permissions still apply. Configured exclusions and journal gaps can limit coverage, and some document formats remain unsupported. Fault-injection tests cover process termination and changed or missing publication files. They do not prove recovery from every hardware failure. Intel and manual VoiceOver acceptance remain unverified.
