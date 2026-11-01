import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { wave } from "../tests/fixtures";

const [cli, out] = process.argv.slice(2);
if (!cli || !out) throw new Error("Usage: bun scripts/codex-smoke.ts /absolute/fe output-directory");
mkdirSync(out, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-agent-")));
const root = path.join(dir, "audio"); mkdirSync(root);
const env = { ...process.env, FE_DATA_DIR: path.join(dir, "cache"), FE_CONFIG_DIR: path.join(dir, "config") };
delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
const run = (...args: string[]) => execFileSync(cli, args, { env, encoding: "utf8", timeout: 30000 });
try {
  writeFileSync(path.join(root, "short-mono.wav"), wave(.5));
  writeFileSync(path.join(root, "short-stereo.wav"), wave(.25, 16000, 2));
  writeFileSync(path.join(root, "boundary.wav"), wave(1));
  writeFileSync(path.join(root, "long.wav"), wave(1.5));
  run("index", root, "--name", "sounds"); run("index", root, "--name", "raw");
  run("enrich", "--index", "sounds", "--kind", "audio");
  const schema = { type: "object", additionalProperties: false, properties: { tasks: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "integer" }, query: { type: "string" }, names: { type: "array", items: { type: "string" } }, complete: { type: "boolean" }, interpretation: { type: "string" } }, required: ["id", "query", "names", "complete", "interpretation"] } } }, required: ["tasks"] };
  const schemaFile = path.resolve(out, "schema.json"), finalFile = path.resolve(out, "answer.json");
  writeFileSync(schemaFile, JSON.stringify(schema));
  const prompt = `Read-only product acceptance test for Find Everything. This is a bounded test under parent Superiss contract sis-7d1847d82f000; setup and ownership are already handled. Do not change files, refresh indexes, enrich, install, create trackers or launch subagents. Use at most 6 shell commands and return only the required JSON. Use the installed CLI ${cli}. FE_DATA_DIR and FE_CONFIG_DIR already select synthetic fixtures. First inspect "${cli} query-help --json" and help only if needed. Then actually execute these three tasks using search --snapshot --json and interpret coverage:
1. Im Index sounds: Finde alle meine Sounds, die unter einer Sekunde gehen.
2. Im Index sounds: Finde kurze Stereo-Sounds unter einer Sekunde mit mindestens 16 kHz.
3. Im Index raw: Suche Sounds unter einer Sekunde. Can you conclude there are no matching files? Report the real complete field and explain the coverage.
For each id return your executed query, returned basenames, complete and a short interpretation. Do not guess durations or file results. No web or network data calls.`;
  writeFileSync(path.resolve(out, "prompt.txt"), prompt);
  const plan = { provider: "ChatGPT OAuth (codex login status verified)", model: "gpt-6.1-sol", effort: "xhigh", tasks: 3, spend: "Included quota only; API-key env removed", cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"), oracle: { 1: ["short-mono.wav", "short-stereo.wav"], 2: ["short-stereo.wav"], 3: [] } };
  writeFileSync(path.resolve(out, "plan.json"), JSON.stringify(plan, null, 2));
  const started = performance.now();
  const child = spawn("run-guard", ["--timeout", "120", "--max-rss-gb", "2", "--threads", "2", "--", "codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", dir,
    "-c", 'model="gpt-6.1-sol"', "-c", 'model_reasoning_effort="xhigh"', "--json", "--output-schema", schemaFile, "--output-last-message", finalFile, "-"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const output: string[] = [], errors: string[] = [];
  child.stdout.on("data", d => output.push(d.toString())); child.stderr.on("data", d => errors.push(d.toString()));
  child.stdin.end(prompt);
  const code = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  writeFileSync(path.resolve(out, "events.jsonl"), output.join("")); writeFileSync(path.resolve(out, "stderr.log"), errors.join(""));
  if (code !== 0) throw new Error(`Codex smoke exited ${code}; inspect ${out}/stderr.log`);
  const answer = JSON.parse(readFileSync(finalFile, "utf8"));
  assert.equal(answer.tasks.length, 3);
  for (const id of [1, 2, 3]) {
    const task = answer.tasks.find(t => t.id === id); assert(task);
    assert.deepEqual([...task.names].sort(), plan.oracle[id]); assert.equal(task.complete, id !== 3);
  }
  writeFileSync(path.resolve(out, "receipt.json"), JSON.stringify({ passed: 3, elapsedMs: performance.now() - started, plan, answer }, null, 2));
  console.log(`Codex: 3/3 task oracles passed; ${Math.round(performance.now() - started)}ms`);
} finally { rmSync(dir, { recursive: true, force: true }); }
