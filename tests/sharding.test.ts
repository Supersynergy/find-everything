import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { shardIndex, indexByteBudget, createIndexNormalizer, INDEX_DISK_LIMIT_BYTES, INDEX_FREE_RESERVE_BYTES } from "../src/engine";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

test("buffered shards preserve every complete Unicode path across chunk boundaries", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "fe-shards-"));
  try {
    const lines = Array.from({ length: 12_000 }, (_, i) => `/some/project with spaces/überblick-${i}-${"x".repeat(i % 80)}.ts`);
    const file = path.join(dir, "index.txt"), shards = path.join(dir, "shards");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    await shardIndex(file, shards);
    const actual = fs.readdirSync(shards).flatMap(name => fs.readFileSync(path.join(shards, name), "utf8").split("\n").filter(Boolean));
    assert.equal(actual.length, lines.length);
    assert.deepEqual(actual.sort(), lines.sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("large streamed indexes retain a finite disk cap and free-space reserve", () => {
  assert.equal(INDEX_DISK_LIMIT_BYTES, 32 * 1024 ** 3);
  assert.equal(indexByteBudget(80 * 1024 ** 3), INDEX_DISK_LIMIT_BYTES);
  assert.equal(indexByteBudget(20 * 1024 ** 3),18 * 1024 ** 3);
  assert.equal(indexByteBudget(2 * 1024 ** 3 + INDEX_FREE_RESERVE_BYTES), 2 * 1024 ** 3);
  for (const free of [NaN, Infinity, -1, INDEX_FREE_RESERVE_BYTES]) {
    assert.throws(() => indexByteBudget(free), /free disk space/i);
  }
});

test("production normalizer accepts a stream counter crossing the old 1-GiB cutoff", async () => {
  // Seed already-processed byte accounting, not a 1-GiB allocation or real scan.
  const stats = { count: 1000, bytes: 1024 ** 3 - 8, skipped: 0 };
  let output = "";
  const normalizer = createIndexNormalizer(indexByteBudget(20 * 1024 ** 3), stats);
  await pipeline(Readable.from(["/Demo/über", "blick/design.pdf\0", "/Demo/notes.txt\0"]), normalizer,
    new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }));
  assert.equal(output, "/Demo/überblick/design.pdf\n/Demo/notes.txt\n");
  assert.equal(stats.count, 1002);
  assert.ok(stats.bytes > 1024 ** 3);
  assert.equal(stats.skipped, 0);
});

test("normalizer still fails closed at its remaining disk budget", async () => {
  const stats = { count: 0, bytes: 0, skipped: 0 };
  let output = "";
  await assert.rejects(pipeline(Readable.from(["/Demo/this-path-exceeds-the-budget.txt\0"]),
    createIndexNormalizer(16, stats),
    new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } })), /safe disk limit/i);
  assert.equal(output, "");
  assert.throws(() => createIndexNormalizer(Infinity, stats), /budget/i);
  assert.throws(() => createIndexNormalizer(INDEX_DISK_LIMIT_BYTES + 1, stats), /budget/i);
});

test("normalizer preserves path-length and newline rejection guards", async () => {
  const stats = { count: 0, bytes: 0, skipped: 0 };
  let output = "";
  await pipeline(Readable.from(["/Demo/a\nb.txt\0/Demo/valid.txt\0"]), createIndexNormalizer(1024, stats),
    new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }));
  assert.equal(output, "/Demo/valid.txt\n");
  assert.equal(stats.skipped, 1);
  await assert.rejects(pipeline(Readable.from(["x".repeat(1024 * 1024 + 1)]),
    createIndexNormalizer(INDEX_DISK_LIMIT_BYTES, { count: 0, bytes: 0, skipped: 0 }),
    new Writable({ write(_chunk, _encoding, done) { done(); } })), /Path exceeds index limit/);
});
