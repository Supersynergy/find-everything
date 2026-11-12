# Search benchmarks · 2026-11-12

200,000 synthetic saved paths; baseline commit `44db4a4`, candidate 0.3.1. Hyperfine 2.0.0, 10 measured runs and 2 warmups per binary and query. Wall time includes CLI startup. Exact result paths, counts, order and pagination agree before timing.

| Case | Baseline ms ± SD | Candidate ms ± SD | Baseline / candidate |
| --- | ---: | ---: | ---: |
| filename | 27.82 ± 0.54 | 27.68 ± 0.70 | 1.01× |
| folder | 28.99 ± 1.77 | 27.47 ± 0.41 | 1.06× |
| folder-wide | 58.16 ± 0.63 | 32.85 ± 2.77 | 1.77× |
| broad | 35.05 ± 2.31 | 33.43 ± 0.40 | 1.05× |
| deep-page | 36.70 ± 1.05 | 37.03 ± 0.56 | 0.99× |
| exclusion | 58.31 ± 1.04 | 60.79 ± 3.06 | 0.96× |

The broad folder restriction improved from 58.16 to 32.85 ms (1.77×). Other cases changed by a few milliseconds in this run; this is not evidence that every query became faster. Deep pagination and the exclusion case were slightly slower. No results are dropped to obtain these numbers.

## Reproduce

Compile the baseline from the stated commit in an isolated checkout. Compile the candidate from the release source, then run:

```sh
bun build --compile src/cli.ts --outfile /tmp/fe-candidate
bun scripts/bench-hyperfine.ts /path/to/fe-baseline /tmp/fe-candidate /tmp/fe-benchmark
```

The script creates its own empty root and saved synthetic snapshots. No personal disk is scanned. Before timing starts, exact matching, count and order signatures are checked, and all individual timing samples are saved so a reader can inspect the spread. Unchanged binary/fixture pairs reuse existing green cases. Use a fresh output directory for an explicitly requested new measurement.

## Scope and evidence

- [Machine-readable measurements and binary/source SHA-256 identities](benchmarks/2026-11-12/hyperfine.json).
- Synthetic filenames include generated folders and 1,000 department prefixes. The deep page starts at offset 150,000.
- OS disk cache is uncontrolled. Baseline and candidate run in separate Hyperfine groups. Other host workloads can affect timings.
- These are CLI saved-index measurements, not native keystroke latency, scan duration, a production-disk inventory or a comparison against another product.
- `tests/search-completeness.test.ts` separately covers inclusive scan persistence, Unicode normalization, quoted pipes, folder boundaries, application directories, scanner omissions, legacy accelerators and emoji subtree deletion. The live recovery fixture covers two scopes sharing a watcher.
- The JavaScript dependency audit is empty after updating existing dependencies. The bundled runtime and optional model runtimes require their own advisory coverage.
