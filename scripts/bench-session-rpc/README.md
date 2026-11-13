# Benchmark local search transports

How much time does a Cap’n Web MessagePort bridge add to a persistent search process? Run the same eight lookups in four configurations. Choose `pipe` or `rpc`, then `serial` or `pipeline`. Both adapters write to the same line-based search process. Pipelining submits the whole batch before awaiting replies. The search process still answers in order.

Use Node.js with worker threads, Bun for dependency installation, and the CLI from the search-session branch. From this directory:

```sh
bun install --frozen-lockfile --ignore-scripts
node compare.mjs pipe pipeline '["name:Safari","name:Finder"]' fe search-session --index applications --limit 3
```

To exercise exact vector search, provide a local SIFT HDF5 file with the standard train and test arrays. The Python environment needs h5py and NumPy. The worker loads the complete training set into memory.

```sh
node compare.mjs rpc serial '[16,17,18,19,20,21,22,23]' python3 sift.py /path/to/sift.hdf5
```

Each invocation warms the session with the first query. Its JSON output contains the elapsed milliseconds for the subsequent batch and the ordered replies. An outer Hyperfine run measures the entire process, including startup. Use the inner timing for warm latency. Rotate the order of the four configurations to distribute host-load drift.

### Measurements on Apple Silicon

Warm batch time in milliseconds, median of four runs per cell, each cell occupying each execution position once.

| Eight queries | Pipe serial | Pipe pipelined | Cap’n Web serial | Cap’n Web pipelined |
|---|---:|---:|---:|---:|
| Exact SIFT search, 1M × 128 | 468.4 | 493.1 | 483.4 | 455.3 |
| Saved applications index, two queries repeated four times | 16.2 | 15.6 | 17.7 | 15.0 |

All transports returned the same ordered results. The SIFT queries recovered all ten reference neighbors each. The file queries matched separate CLI invocations. The RPC path adds a worker thread and a MessagePort to the pipe path. Four rounds on one host leave the few-percent differences uncertain. These measurements support keeping the bridge optional.
