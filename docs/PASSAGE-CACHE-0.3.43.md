# Bounded meaning-search reuse

The 0.3.42 passage refinement improves late-document retrieval but can repeat the same passage inference when a client changes result pages or returns to a related query. Version 0.3.43 stores those vectors in the existing model worker. The index, model and ranking formula are unchanged.

Each cached key is a SHA-256 digest of model identity, input kind and exact input text. Values use float32 payloads with owned copies. Query and passage caches are separate; query prefixes cannot collide with passage prefixes. The passage LRU permits at most 512 entries and 2 MiB of accounted payload, including key bytes and fixed entry overhead. Query payloads are bounded to 128 entries / 1 MiB. JavaScript allocator and process memory are measured separately from those payload limits.

Before reuse, the worker checks physical identities of its configuration, Python interpreter, worker/tokenizer code and model files. A changed identity restarts the worker and clears both caches. Missing or invalid runtime files fail before a cached vector can be served. Worker closure also clears the values. A runtime change during a search returns a retry instruction instead of mixing vectors from two runtime versions. Failed requests are never cached. Current file filters and stale-document checks still run before and after ranking; vector reuse cannot add a changed document to results.

No persistent cache or document text is stored by this feature. There is no additional model, download, provider call or background service. Set `FE_PASSAGE_CACHE=off` when starting a diagnostic process to disable passage reuse. Query reuse remains enabled.

## Paired measurements

The existing 497-document prepared corpus and the 40 previously used German/English questions were replayed with ten results per page, offsets 0 and 10. The source tree at `c2efef6` is the baseline. Each arm used a fresh process and the same model, source metadata, prepared vectors and questions. All 80 signatures matched, covering paths, ordering, cosine scores, snippets, properties, coverage, next offset and snapshot identity. This is a known-set regression replay, not a new blind quality claim.

| Measurement | 0.3.42 | 0.3.43 |
|---|---:|---:|
| First-page median | 446.11 ms | 400.39 ms |
| Next-page median | 382.03 ms | 65.49 ms |
| Passage inference calls | 774 | 354 |
| Sum of backend process peaks | 190.17 MiB | 187.84 MiB |

Hyperfine used the first eight frozen questions, two pages each, with one warmup and three measured fresh processes per version. Each command included process and model startup: 7.705 ± 1.661 s versus 3.910 ± 0.067 s. CPU time was 9.053 versus 5.131 s. The complete measurements are in the [summary](benchmarks/2026-11-13/v0.3.43-summary.json).

The memory difference is small and does not establish a general RAM reduction. These timings exclude native rendering and HTTP scheduling. The API response cache does not store meaning-search results; source checks still run for each request. Benefits depend on passage reuse; unseen queries, different passages and new processes still do inference. Cache eviction changes work performed, not the result predicate.

Reproduce with a preserved baseline source tree and the private, unchanged evaluation fixture:

```sh
bun scripts/bench-passage-cache.ts compare BASELINE_SOURCE FIXTURE_DIRECTORY OUTPUT_DIRECTORY
```

The fixture must contain the existing content/meaning index and frozen corpus/question manifests. Raw questions and document paths stay in private artifacts. Tests also exercise LRU eviction, payload ownership, invalid vectors, runtime changes, worker restart and uncached failures.

## Full-index maintenance remains separate

At inspection, the saved global path file was about 10 GB and its prepared lookup about 28 GB, while only 13–14 GiB of disk space was free. A complete replacement and rollback copy need more headroom. Existing scanner and journal warnings remain reported. The passage cache neither repairs those gaps nor changes which filesystem paths were indexed.
