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
