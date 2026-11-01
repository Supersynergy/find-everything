// Keystroke latency benchmark for the socket service.
//
//   bun scripts/bench-latency.ts typing <cli>
//   bun scripts/bench-latency.ts ab <cliA> <cliB> [pairs]
//
// `typing` types every prefix of ten words against the configured default index
// (first page, preview phase) and prints one JSON line with the first keystroke,
// mean, p50, p95, max and the total of all keystrokes.
// `ab` primes the OS page cache for both binaries, then runs them alternately so a
// position effect cannot pass for a speedup, and prints both sample lists.
// The `ab` mode is what `hyperfine --runs 2 'bun scripts/bench-latency.ts ab ...'`
// wraps; `typing` is what `hyperfine` compares build against build.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { defaultIndex } from "../src/catalog";

const WORDS = ["master", "config", "hyper", "changelog", "index", "search", "report", "design", "find", "cache"];

type Sample = { firstMs: number; keys: number; meanMs: number; p50Ms: number; p95Ms: number; maxMs: number; totalMs: number };

const die = (text: string): never => { throw new Error(text); };

async function typing(cli: string): Promise<Sample> {
  const dir = mkdtempSync(path.join(tmpdir(), "fe-latency-"));
  const socket = path.join(dir, "search.sock");
  const service = spawn(cli, ["serve", "--socket", socket], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  service.stderr!.on("data", d => { log += d; });
  const timed = (q: string) => new Promise<number>((resolve, reject) => {
    const start = performance.now();
    const token = readFileSync(socket + ".json", "utf8").match(/"token"\s*:\s*"([^"]+)"/)![1];
    const req = http.get({ socketPath: socket, path: "/v1/search?" + new URLSearchParams({ q, index: defaultIndex(), limit: "300", phase: "preview" }), headers: { Host: "localhost", Authorization: "Bearer " + token }, timeout: 15000 }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", d => { body += d; });
      res.on("end", () => { if (res.statusCode !== 200) return reject(new Error(res.statusCode + " " + body.slice(0, 200))); JSON.parse(body); resolve(performance.now() - start); });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Search exceeded 15 s")));
  });
  try {
    for (let i = 0; i < 300 && !log.includes("\n"); i++) { if (service.exitCode !== null) throw new Error(log); await new Promise(r => setTimeout(r, 10)); }
    const queries: string[] = [];
    for (const word of WORDS) for (let i = 1; i <= word.length; i++) queries.push(word.slice(0, i) + " sort:name");
    // Only the first query can pay the reader start, every later key differs from
    // every earlier one, so the run measures keystrokes and not cache hits.
    const samples: number[] = [];
    for (const query of queries) samples.push(await timed(query));
    const first = samples.shift()!;
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { firstMs: +first.toFixed(1), keys: samples.length, meanMs: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2), p50Ms: +at(0.5).toFixed(2), p95Ms: +at(0.95).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(2), totalMs: +samples.reduce((a, b) => a + b, 0).toFixed(1) };
  } finally {
    const done = once(service, "exit");
    service.kill("SIGTERM");
    await done;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function ab(cliA: string, cliB: string, pairs: number) {
  const bins: [string, string][] = [["a", cliA], ["b", cliB]];
  for (const [, cli] of bins) await typing(cli); // discard: prime the page cache
  const rows: Record<string, number[]> = { a: [], b: [] }, firsts: Record<string, number[]> = { a: [], b: [] };
  for (let i = 0; i < pairs; i++) for (const [name, cli] of i % 2 ? [...bins].reverse() : bins) {
    const sample = await typing(cli);
    rows[name].push(sample.totalMs); firsts[name].push(sample.firstMs);
  }
  const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
  const delta = (values: number[], before: number[]) => +(((median(values) - median(before)) / median(before)) * 100).toFixed(1);
  return { pairs, aTotalMs: rows.a, bTotalMs: rows.b, aFirstMs: firsts.a, bFirstMs: firsts.b, totalDeltaPercent: delta(rows.b, rows.a), firstDeltaPercent: delta(firsts.b, firsts.a) };
}

const [mode, a, b, rounds] = process.argv.slice(2);
if (mode === "typing" && a) console.log(JSON.stringify(await typing(a)));
else if (mode === "ab" && a && b) console.log(JSON.stringify(await ab(a, b, Number(rounds || 3))));
else die("Usage: bench-latency.ts typing <cli> | ab <cliA> <cliB> [pairs]");
