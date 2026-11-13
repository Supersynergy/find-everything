# Directory predicate benchmark — 2026-11-13

Hyperfine compared the old substring predicate with the indexed binary range used for live subtree deletion. Both selected the same 1,000 descendants among 250,000 synthetic directory paths, including an emoji folder. This measures directory selection through the SQLite CLI, including process startup. It does not measure an entire deletion transaction or filesystem scan.

| Predicate | Mean | Standard deviation |
| --- | ---: | ---: |
| `substr(path,1,length(prefix))=prefix` | 53.7 ms | 26.1 ms |
| `path>=prefix AND path<upper` | 10.1 ms | 2.4 ms |

The mean ratio was **5.3×**. The old predicate had substantial timing variation; five warm runs are evidence for this bounded operation, not a general app-speed claim. Each command had one warmup. Hardware: Apple Silicon macOS, local SQLite CLI and Hyperfine. No personal paths or contents were included.

Reproduce in a temporary directory:

```sh
sqlite3 fixture.sqlite "CREATE TABLE directories(id INTEGER PRIMARY KEY,path TEXT UNIQUE); WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<250000) INSERT INTO directories(path) SELECT CASE WHEN i<=1000 THEN '/fixture/📁-archive/' ELSE '/fixture/elsewhere/' END||printf('%06d',i)||'/' FROM n;"
hyperfine --warmup 1 --runs 5 \
  "sqlite3 fixture.sqlite \"SELECT count(*) FROM directories WHERE substr(path,1,length('/fixture/📁-archive/'))='/fixture/📁-archive/';\"" \
  "sqlite3 fixture.sqlite \"SELECT count(*) FROM directories WHERE path>='/fixture/📁-archive/' AND path<'/fixture/📁-archive0';\""
```

The upper bound replaces the final `/` with `0`, its next ASCII code point. This covers every descendant while excluding prefix siblings. Regression tests also check non-BMP names, exact siblings, more than 100,000 pending changes, and CR/LF live events.

## Relevance page offsets

A live process sample found SQLite substring work consuming an entire CPU core while the native app was idle. Its first results page was fast, but automatically loading the next page counted an entire content-type bucket. Repeating that count after live updates blocked the shared reader.

The replacement counts at most offset + 1 matching rows to decide whether an offset fits in the bucket. If the probe exhausts the bucket, its count is exact and may be cached. Hitting the limit is a lower bound and is never cached as an exact size. The overall match count and ordering are unchanged.

An isolated read-only worker used the same native query and 1,000-row page size on the current full index. It performed no synchronization and bypassed the app's request queue:

| Query | Installed 0.3.5 | Candidate |
| --- | ---: | ---: |
| Empty relevance view, first page | 49 ms | 90 ms |
| Empty relevance view, offset 1,000 | Aborted at 10,005 ms | 67 ms |
| Name order, offset 1,000 | 57 ms | 37 ms |
| Scoped filename, relevance order | 368 ms | 93 ms |

These are single observations including worker launch. Live indexing continued: the captured total changed from 68,459,459 to 68,459,795 paths. They are not frozen-corpus distributions or direct UI timings, and the timed-out baseline gives no completed page for comparison. An independent fixture checks exact pages against a reference ordering across every content-type boundary and revisits after bounded probes.

Hyperfine also measured only the affected count on a stable synthetic SQLite table with 500,000 rows, one quarter ending in `.txt` and the rest in `.json`. Both commands used the unchanged expression returned by `relevanceOrder(parseQuery('view:smart omit:none'))`, a covering `file_names(nameKey,id)` index, fresh Bun processes, one warmup and three runs:

| Counter | Mean | Standard deviation |
| --- | ---: | ---: |
| Entire priority-zero bucket | 358.0 ms | 1.3 ms |
| Probe limited to 1,001 matches | 22.0 ms | 0.5 ms |

The counter-only mean ratio was 16.3×, including process startup. The full count returns 125,000; the bounded probe returns 1,001, which is sufficient to decide that offset 1,000 lies inside the bucket. This does not substitute a partial count for the displayed total.

To reproduce the workload, create `files(id INTEGER PRIMARY KEY,nameKey TEXT)` and generate rows 1–500,000 with a seven-digit numeric basename, assigning `.txt` when `id % 4 = 0` and `.json` otherwise. Compare `SELECT count(*) FROM files f INDEXED BY file_names WHERE <relevance-expression>=0` with `SELECT count(*) FROM (SELECT 1 FROM files f INDEXED BY file_names WHERE <relevance-expression>=0 LIMIT 1001)` using Hyperfine `--warmup 1 --runs 3`. No personal paths or file contents are required.

## Short relevance previews

The native window was searching for `ne`. Isolated 1,000-row reads against the same live full index exposed another bottleneck: both its preview and complete response exceeded a 10-second deadline in 0.3.6. The prefix-range candidate returned 1,000 provisional rows in 965 ms. Its complete global count still exceeded that deadline. These single observations include process launch and do not promise a subsecond exact count.

The shortcut applies to a single lowercase ASCII term with no additional filters or omissions. Filename exact/stem and prefix tiers precede all non-prefix tiers, including the maximum learned boost. It uses the existing name index and ranking expression. If a complete requested page cannot be satisfied from that range, the complete query follows its normal path. Uppercase, alternative and filtered queries keep their existing behavior. Reference regressions check ordering, total counts, later pages and inclusion of non-prefix and folder-only matches.


## Search caches and metadata updates

Version 0.3.8 keeps name candidate sets and exact name counts across property-only changes, while reloading displayed properties and recalculating size/date-dependent counts. Result-cache keys use parsed query structure, backend dependencies and scope-local journal revisions. Entries are bound after synchronization to the snapshot actually read. Identical in-flight requests share a reader job; cancellation and generations remain separate for each client. Preview and exact requests remain separate. Serialized keys and bodies have a combined 16-MiB/256-entry budget, with at most 1 MiB per entry; this is not a bound on total JavaScript heap usage.

Hyperfine compared the installed 0.3.7 CLI with the 0.3.8 candidate on the same frozen list of **500,000 synthetic paths**. The query was `ne sort:name`, requesting 300 rows with an exact total of 500,000. Each command starts a private service, warms the query once, then performs eight update/search pairs. Every response must match the reference paths, count, engine and next offset. One Hyperfine warmup and three measured runs were used for each binary and workload.

| Eight requests plus service startup and cold warmup | 0.3.7 mean ± SD | 0.3.8 mean ± SD |
| --- | ---: | ---: |
| Update an unrelated journal scope before each request | 196.3 ± 14.6 ms | 127.6 ± 5.5 ms |
| Update cached properties before each request | 456.7 ± 73.4 ms | 249.3 ± 35.0 ms |

The command-level mean ratios were **1.54×** and **1.83×**. Individual warm API requests, pooled from the 24 measured update/search pairs per case, were:

| Warm API workload | 0.3.7 median / p95 | 0.3.8 median / p95 |
| --- | ---: | ---: |
| Unrelated scope writes | 3.31 / 5.28 ms | 1.26 / 2.02 ms |
| Property-only writes | 31.44 / 48.67 ms | 5.49 / 7.70 ms |

Unrelated-scope result-cache hits changed from 0/24 to 24/24. Property updates deliberately missed the response cache in both versions so that returned properties stayed current; the candidate reused expensive name work inside its reader. Regression instrumentation also verifies that name aggregate SQL is skipped after hydration/property events, property-dependent aggregates run again, and actual additions/deletions invalidate name counts.

An earlier run before the additional media cleanup fix showed smaller/noisier command-level gains: 177.5 → 176.5 ms for unrelated scopes and 424.8 → 378.1 ms for properties. Those local raw results were retained. Differences between groups include process startup, page-cache state and concurrent host activity; the stronger final run is not a universal speed factor.

During installed acceptance, the existing service was spending prolonged time in SQLite and had the live and media databases open. The media subtree predicate used a full covering-index scan for each removed directory. Replacing `substr(path,1,?)=?` with `path>=? AND path<?` uses an indexed range with the same slash-prefix boundary already tested above. A new live regression removes descendants below an emoji directory while preserving prefix siblings. The observed query-plan improvement and correctness test do not establish a measured whole-app speedup for this change.

The final signed installed CLI passed an additional private API trace with all eight requests served from the result cache, and the actual native-owned service reported version 0.3.8. A native window observation is a smoke check, not a timed interaction/keyboard acceptance. Existing journal gap/overlay warnings remain visible; this update does not reconcile them or prove current filesystem completeness.

Reproduce the cache comparison with:

```sh
bun scripts/bench-cache.ts /path/to/fe-0.3.7 /path/to/fe-0.3.8 /path/to/evidence
```

See [the machine-readable summary](benchmarks/2026-11-13/cache-summary.json) for binary/fixture hashes and command-level results. Earlier JSON outputs are preserved when the fixture is reused. Limits: OS caches are uncontrolled; service launch and cold query are included in Hyperfine, but not in the warm API table. The corpus contains stored synthetic filenames, with no query-time directory traversal. These measurements are not a 68-million-row cold-query or native-UI benchmark. No bigram index, bitmap library or alternative backend is introduced.
