# Search modes and recovery in 0.3.41

Use **Filters → Literal text** to quote the whole search box. The Case picker and Whole words toggle add explicit options that are retained by existing saved searches. Whole words use Unicode letter/number/combining-mark/underscore boundaries. Directory and type constraints keep their structural meaning.

```sh
fe search --literal --query 'report (final)! | a*b' --index everything --json
fe search 'Ärger case:no' --index everything --json
fe search 'report word:yes case:no' --index everything --json
fe explain 'literal:"a|b" case:no view:all' --index everything
```

The literal form is JSON-quoted: `literal:"say\"hi\""`, `literal:"back\\slash"`, `literal:"line\nbreak"`. Return paths stay unchanged, including decomposed accents. JSON or `--null` output preserves newline filenames. A filename cannot contain NUL or a slash within a path component. Unicode case matching follows Unicode lowercase conversion, not accent removal or language-specific transliteration (`ß` is not `ss`). No arbitrary user regex runs on the query path.

The same predicates apply before pagination in prepared SQLite search and saved-path streaming. Existing trigram and directory candidate selection stay active. Whole-word evaluation runs on candidates; very broad word queries can cost more than substring queries. Case and word options are part of count-cache identity, and the prefix shortcut is disabled when it would violate those options.

## Large result lists

The macOS table keeps at most 10,000 local rows and moves that window as you scroll. Search counts, global row numbers and backend paging still cover the full result set. First/Last, jumps of 10,000 results, and Go to result reach arbitrary global positions without allocating one AppKit row per hit. Selection, context menus and drag paths translate back to global coordinates. An off-screen AppKit test verifies the last row and pointer selection at 68,903,790 results.

## Recovery

Compaction validates all three source/stage/backup combinations before publication. New checkpoints record physical file identities for the saved paths, lookup and metadata. Legacy checkpoints additionally require valid path stamps, lookup metadata and row counts. A changed target, missing component, malformed checkpoint or inconsistent lookup fails explicitly and preserves the files for inspection. An interrupted rename resumes only from a valid combination. The old files remain under the compaction directory. Existing history-gap warnings are retained; this release does not run a new full-disk scan.

## Research used

- [Everything's official search documentation](https://www.voidtools.com/support/everything/searching/): explicit matching controls, word matching, filters and bookmarks. Applied literal handling plus case/word controls to the existing UI and saved-search mechanism.
- [FSearch's source README](https://github.com/cboxdoerfer/fsearch/blob/master/README.md): independent Unix implementation of filters, advanced syntax and indexed sorting. Those existing capabilities were retained; no foreign implementation was copied.
- Local `ghmax --repos --fast --no-ingest --format json -n 5 'FSearch file search'` returned five repositories, including cboxdoerfer/fsearch. A second broader query returned zero results; it is not evidence that such projects do not exist. Raw discovery results are retained with the private acceptance artifacts. Repository popularity was not treated as performance evidence.
- ghmax's explicit plan/explain approach informed `fe explain`: show interpretation and scope before attributing a missing result to the index. The command describes the query and index metadata; it does not diagnose a specific file or execute a search.

No Windows NTFS journal assumptions were transferred to macOS. Tests and Hyperfine measurements use controlled local fixtures; they do not establish that Find Everything outperforms every competing app.

## Measurements

The final build's six-process repeated-count workload took 432 ms versus 382 ms for 0.3.40 in three Hyperfine runs; CPU time was 364 ms versus 369 ms. This is not evidence of a general CLI speedup. An earlier development build showed the opposite wall-time ordering on the same shared host. The final results, spread and three-query special-mode workload are retained in the [measurement artifact](benchmarks/2026-11-13/v0.3.41-summary.json). Native memory observations are recorded separately from CLI timings.

After installation, the 0.3.41 native process used 101–108 MiB RSS in four observations over 45 seconds. An earlier 0.3.40 session had exceeded 22 GiB. These are observations from different app sessions, not a controlled memory benchmark. The installed search service still reports the 68,903,790-path snapshot and five existing coverage warnings.
