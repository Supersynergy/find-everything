import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const [cli, out] = process.argv.slice(2);
if (!cli || !out) throw new Error("Usage: bun scripts/codex-smoke.ts /absolute/fe output-directory");
mkdirSync(out, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-agent-")));
const root = path.join(dir, "audio"); mkdirSync(root);
const env = { ...process.env, FE_DATA_DIR: path.join(dir, "cache"), FE_CONFIG_DIR: path.join(dir, "config") };
delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
let service;
const run = (...args: string[]) => execFileSync(cli, args, { env, encoding: "utf8", timeout: 30000 });
try {
  writeFileSync(path.join(root, "a.wav"), readFileSync(path.resolve(out, "../dog.wav")));
  writeFileSync(path.join(root, "b.wav"), readFileSync(path.resolve(out, "../cat.wav")));
  run("index", root, "--name", "sounds"); run("index", root, "--name", "raw");
  run("enrich", "--index", "sounds", "--kind", "audio");
  run("semantic", "index", "--index", "sounds", "--seconds", "30", "--max-files", "10");
  const socketPath = path.join(dir,"cache/run/search.sock");
  service = spawn(cli,["serve","--socket",socketPath,"--live"],{env,stdio:["ignore","ignore","pipe"]});
  let log="";service.stderr.on("data",d=>log+=d);
  const wait = async (test,ms=15000) => {const deadline=Date.now()+ms;while(!test()){if(Date.now()>deadline)throw new Error("Live fixture timeout: "+log);await new Promise(r=>setTimeout(r,80));}};
  await wait(()=>log.includes("watching"));
  execFileSync("/opt/homebrew/bin/ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=400:duration=0.25","-threads","1",path.join(root,"c.wav")],{timeout:5000});
  writeFileSync(path.join(root,"live-note.txt"),"created after the initial path snapshots");
  await wait(()=>JSON.parse(run("search","live-note","--index","sounds","--json")).paths.length===1);
  await new Promise(r=>setTimeout(r,1500));
  const shortOracle=["a.wav","b.wav","c.wav"].filter(name=>Number(execFileSync("/opt/homebrew/bin/ffprobe",["-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",path.join(root,name)],{encoding:"utf8",timeout:4000}))<1);
  const schema = { type: "object", additionalProperties: false, properties: { tasks: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "integer" }, query: { type: "string" }, names: { type: "array", items: { type: "string" } }, complete: { type: "boolean" }, interpretation: { type: "string" } }, required: ["id", "query", "names", "complete", "interpretation"] } } }, required: ["tasks"] };
  const schemaFile = path.resolve(out, "schema.json"), finalFile = path.resolve(out, "answer.json");
  writeFileSync(schemaFile, JSON.stringify(schema));
  const prompt = `Read-only product acceptance test for Find Everything under parent Superiss contract sis-813b5f055bb80. Ownership and fixtures are prepared. Do not change files, refresh indexes, enrich, install, create trackers or launch subagents. Use at most 9 shell commands and return only the required JSON. Use installed CLI ${cli}. FE_DATA_DIR and FE_CONFIG_DIR select isolated public-audio fixtures with opaque filenames. First inspect "${cli} query-help --json". Then execute these six tasks with search --snapshot --json; use parentheses for natural audio descriptions:
1. Index sounds: Finde Hundebellen. Return the top 1 result only (-n 1). Report whether semantic retrieval is exhaustive.
2. Index sounds: Finde eine Katze. Return the top 1 result only (-n 1).
3. Index raw: Suche kurze Lasersounds. Can you conclude there are no matching files? Report the real complete field and explain coverage. The raw index has no audio metadata or embeddings.
4. Index sounds: Zeige bei leerer Suchzeile alle indizierten Dateien (search '' -n 10). Return all their basenames and the real complete field.
5. Index sounds: Finde live-note. It was created after the initial index. Search without refreshing and return its basename and actual complete field.
6. Index sounds: Alle meine Sounds unter 1 Sekunde. Use the documented natural input or audio duration filter, return all results (-n 10), actual complete field and explain unknown metadata. No refresh, enrichment or analysis.
For each id return your executed query, returned basenames, complete and a short interpretation. Do not guess durations or file results. No web or network data calls.`;
  writeFileSync(path.resolve(out, "prompt.txt"), prompt);
  const plan = { provider: "ChatGPT OAuth (codex login status verified)", model: "gpt-6.1-sol", effort: "xhigh", tasks: 6, spend: "Included quota only; API-key env removed", cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"), oracle: { 1: ["a.wav"], 2: ["b.wav"], 3: [], 4: ["a.wav", "b.wav", "c.wav", "live-note.txt"], 5: ["live-note.txt"], 6: shortOracle } };
  writeFileSync(path.resolve(out, "plan.json"), JSON.stringify(plan, null, 2));
  const started = performance.now();
  const child = spawn("run-guard", ["--timeout", "120", "--max-rss-gb", "2", "--threads", "2", "--", "codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", dir,
    "-c", 'model="gpt-6.1-sol"', "-c", 'model_reasoning_effort="xhigh"', "-c", 'project_doc_max_bytes=0', "--json", "--output-schema", schemaFile, "--output-last-message", finalFile, "-"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const output: string[] = [], errors: string[] = [];
  child.stdout.on("data", d => output.push(d.toString())); child.stderr.on("data", d => errors.push(d.toString()));
  child.stdin.end(prompt);
  const code = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  writeFileSync(path.resolve(out, "events.jsonl"), output.join("")); writeFileSync(path.resolve(out, "stderr.log"), errors.join(""));
  if (code !== 0) throw new Error(`Codex smoke exited ${code}; inspect ${out}/stderr.log`);
  const answer = JSON.parse(readFileSync(finalFile, "utf8"));
  assert.equal(answer.tasks.length, 6);
  for (const id of [1, 2, 3, 4, 5, 6]) {
    const task = answer.tasks.find(t => t.id === id); assert(task);
    assert.deepEqual([...task.names].sort(), plan.oracle[id]); assert.equal(task.complete, id === 4 || id === 6);
  }
  writeFileSync(path.resolve(out, "receipt.json"), JSON.stringify({ passed: 6, elapsedMs: performance.now() - started, plan, answer }, null, 2));
  console.log(`Codex: 6/6 task oracles passed; ${Math.round(performance.now() - started)}ms`);
} finally { if(service?.exitCode===null){service.kill("SIGTERM");await new Promise(r=>service.once("close",r));} rmSync(dir, { recursive: true, force: true }); }
