"""Read JSON query indices from stdin and return exact top-10 SIFT neighbors."""
import json
import sys

import h5py
import numpy as np

with h5py.File(sys.argv[1]) as dataset:
    vectors = dataset["train"][:]
    queries = dataset["test"][:]

for line in sys.stdin:
    query = queries[int(json.loads(line))]
    distances = np.empty(len(vectors), dtype=np.float32)
    for start in range(0, len(vectors), 65536):
        diff = vectors[start:start + 65536] - query
        distances[start:start + len(diff)] = np.einsum("ij,ij->i", diff, diff)
    threshold = np.partition(distances, 9)[9]
    ids = np.flatnonzero(distances <= threshold)
    order = np.argsort(distances[ids], kind="stable")[:10]
    print(json.dumps({"data": ids[order].tolist()}), flush=True)
