import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { wave } from "../tests/fixtures";

const [cli, helper, output] = process.argv.slice(2);
if (!cli || !helper || !output) throw new Error("Usage: bun scripts/bench-media.ts /absolute/fe /absolute/helper output.json");
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-media-bench-")));
const root = path.join(dir, "audio"); mkdirSync(root);
for (let i = 0; i < 40; i++) writeFileSync(path.join(root, `sound-${i}.wav`), wave(i % 2 ? 1 : .5));
const samples: any[] = [];
try {
  for (let round = 0; round < 4; round++) {
    for (const variant of round % 2 ? ["native", "ffprobe"] : ["ffprobe", "native"]) {
      const env = { ...process.env, FE_DATA_DIR: path.join(dir, variant + round), FE_CONFIG_DIR: path.join(dir, "config" + variant + round), FE_MEDIA_PROBE: variant === "native" ? helper : "off" };
      const run = (...args: string[]) => JSON.parse(execFileSync(cli, [...args, "--json"], { env, encoding: "utf8", timeout: 30000 }));
      run("index", root, "--name", "sounds");
      const start = performance.now(); const cold = run("enrich", "--index", "sounds");
      const coldMs = performance.now() - start;
      assert.equal(cold.probed, 40); assert.equal(cold.failed, 0);
      const result = run("search", "audio: duration:<1s", "--index", "sounds");
      assert.equal(result.paths.length, 20); assert.equal(result.complete, true);
      assert(result.media.every(r => r.duration === .5 && r.sampleRate === 8000 && r.channels === 1));
      const db = cold.database; const before = statSync(db).mtimeMs;
      const warmStart = performance.now(); const warm = run("enrich", "--index", "sounds");
      const warmMs = performance.now() - warmStart;
      assert.equal(warm.probed, 0); assert.equal(warm.reused, 40); assert.equal(statSync(db).mtimeMs, before);
      samples.push({ round, variant, coldMs, warmMs, native: cold.native, fallback: cold.fallback, unchangedDb: true });
    }
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const summary = Object.fromEntries(["native", "ffprobe"].map(v => [v, { coldMedianMs: median(samples.filter(s => s.variant === v).map(s => s.coldMs)), warmMedianMs: median(samples.filter(s => s.variant === v).map(s => s.warmMs)) }]));
  writeFileSync(output, JSON.stringify({ contract: "Same 40 generated WAVs, exact duration/rate/channels and <1s selection; 4 alternating pairs; metadata cache cold, OS cache uncontrolled. Physical SSD writes unmeasured.", samples, summary }, null, 2));
  console.log(JSON.stringify(summary));
} catch (e) { writeFileSync(output, JSON.stringify({ samples, failure: String(e) }, null, 2)); throw e; }
finally { rmSync(dir, { recursive: true, force: true }); }
