import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { socketRequest } from "../src/socket";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const [cli, output, mode = "all"] = process.argv.slice(2);
if (!cli || !output || !["all", "cli"].includes(mode)) throw new Error("Usage: bun scripts/bench-search.ts /absolute/fe output.json [cli|all]");
const dir = mkdtempSync(path.join(tmpdir(), "fe-bench-"));
const root = path.join(dir, "files"); mkdirSync(root);
const env = { ...process.env, FE_DATA_DIR: path.join(dir, "cache"), FE_CONFIG_DIR: path.join(dir, "config") };
const queries = ["ext:md", "note ext:ts", "überblick"];
const files: string[] = [];
for (let i = 0; i < 120; i++) {
  const name = `${i % 3 === 0 ? "überblick" : "note"}-${String(i).padStart(3, "0")}.${i % 2 ? "ts" : "md"}`;
  const file = path.join(root, name); writeFileSync(file, "fixture\n"); files.push(file);
}
const sourceHash = createHash("sha256").update(readFileSync(cli)).digest("hex");
const oracle = (query: string) => files.filter(p => query === "ext:md" ? p.endsWith(".md") : query.startsWith("note") ? p.includes("/note-") && p.endsWith(".ts") : p.includes("überblick")).map(p => path.basename(p)).sort();
const plan = { executable: cli, sourceHash, queries, rounds: 24, order: "alternating forward/reverse", fixtureHash: createHash("sha256").update(JSON.stringify(files.map(p => path.basename(p)))).digest("hex"), oracle: queries.map(q => oracle(q)) };
writeFileSync(output + ".plan.json", JSON.stringify(plan, null, 2));
const children: ReturnType<typeof spawn>[] = [];
const samples: any[] = [];
const services: any = {};
try {
  await exec(cli, ["index", root, "--name", "bench", "--preset", "folder"], { env, timeout: 10000 });
  const indexFile = path.join(dir, "cache", "index-bench.txt");
  const before = statSync(indexFile);
  if (mode === "all") {
    for (const variant of ["socket", "http"]) {
      const socket = path.join(dir, "search.sock");
      const child = spawn(cli, ["serve", ...(variant === "socket" ? ["--socket", socket] : ["--port", "0"])], { env, stdio: ["ignore", "ignore", "pipe"] }); children.push(child);
      let log = ""; child.stderr!.on("data", d => { log += d; });
      for (let i = 0; i < 100 && !log.includes("\n"); i++) { if (child.exitCode !== null) throw new Error(log); await delay(10); }
      const info = JSON.parse(log.trim().split("\n")[0]);
      services[variant] = { ...info, pid: child.pid };
    }
  }
  const call = async (variant: string, query: string) => {
    if (variant === "cli") return JSON.parse((await exec(cli, ["search", query, "--index", "bench", "-n", "1000", "--json"], { env, timeout: 10000 })).stdout);
    const route = "/v1/search?" + new URLSearchParams({ q: query, index: "bench", limit: "1000" });
    if (variant === "socket") return socketRequest(services.socket.socket, route);
    const response = await fetch(services.http.url + route, { headers: { Authorization: `Bearer ${services.http.token}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const variants = mode === "cli" ? ["cli"] : ["cli", "socket", "http"];
  for (let round = 0; round < 24; round++) {
    for (const variant of round % 2 ? [...variants].reverse() : variants) {
      const query = queries[round % queries.length]; const t0 = performance.now();
      const result = await call(variant, query);
      const elapsedMs = performance.now() - t0;
      assert.deepEqual(result.paths.map(p => path.basename(p)).sort(), oracle(query));
      samples.push({ round, variant, query, elapsedMs, engineMs: result.elapsedMs, cacheHit: result.cacheHit ?? false });
    }
  }
  const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  const summary = Object.fromEntries(variants.map(v => {
    const rows = samples.filter(s => s.variant === v);
    const warm = rows.filter(s => s.round >= 3).map(s => s.elapsedMs);
    return [v, { n: warm.length, firstThreeMs: rows.slice(0, 3).map(s => s.elapsedMs), medianMs: quantile(warm, .5), p95Ms: quantile(warm, .95), p99Ms: quantile(warm, .99), engineMedianMs: quantile(rows.map(s => s.engineMs), .5), cacheHits: rows.filter(s => s.cacheHit).length }];
  }));
  const after = statSync(indexFile);
  assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.size, before.size);
  const rssKiB = Object.fromEntries(Object.entries(services).map(([v, info]: any) => [v, Number(execFileSync("/bin/ps", ["-o", "rss=", "-p", String(info.pid)], { encoding: "utf8" }).trim())]));
  const report = { plan, summary, samples, resource: { serviceRssKiB: rssKiB, pathIndexChanged: false, physicalWriteBytes: "unmeasured", swapAtEnd: execFileSync("/usr/sbin/sysctl", ["vm.swapusage"], { encoding: "utf8" }).trim() } };
  writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(summary));
} catch (e) { writeFileSync(output, JSON.stringify({ plan, samples, failure: String(e) }, null, 2)); throw e; }
finally {
  for (const child of children) { if (child.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; } }
  rmSync(dir, { recursive: true, force: true });
}
