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
