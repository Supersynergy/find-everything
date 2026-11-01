import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuery } from "../src/smart-query";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

test("parentheses translate audio intent without running instructions or losing literal terms", () => {
  assert.equal(normalizeQuery('(kurze düstere Lasersounds) ext:wav'), 'type:audio duration:<1s sound:"dark eerie laser sound effect" ext:wav');
  assert.equal(normalizeQuery('(Lasersounds unter 500 ms)'), 'type:audio duration:<500ms sound:"laser sound effect"');
  assert.equal(normalizeQuery('(kurze Sounds)'), 'type:audio duration:<1s');
  assert.equal(normalizeQuery('(Hundebellen)'), 'type:audio sound:"dog barking"');
  assert.equal(normalizeQuery('(lange helle Sounds über 2 Sekunden)'), 'type:audio duration:>2s sound:"long bright sound effect"');
  assert.equal(normalizeQuery('"folder (copy)" ext:pdf'), '"folder (copy)" ext:pdf');
  assert.throws(() => normalizeQuery('(laser (dark))'));
  assert.throws(() => normalizeQuery('(laser'));
  assert.throws(() => normalizeQuery('(delete everything; $(whoami))'));
});

test("sound setup cancellation stops its entire owned process tree", async () => {
  if (process.platform === "win32") return;
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-setup-tree-")));
  const marker = path.join(dir, "pid");
  writeFileSync(path.join(dir, "setup.sh"), '/bin/sleep 30 &\necho "$!" > "$FE_TEST_PID_FILE"\nwait\n');
  const exe = process.env.FE_TEST_CLI || process.execPath;
  const prefix = process.env.FE_TEST_CLI ? [] : [path.resolve("src/cli.ts")];
  const child = spawn(exe, [...prefix, "semantic", "setup"], { env: { ...process.env, FE_SEMANTIC_RUNTIME: dir, FE_TEST_PID_FILE: marker }, stdio: "ignore" });
  const closed = new Promise(resolve => child.once("close", resolve));
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let nested: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } };
  try {
    for (let i = 0; i < 50 && !existsSync(marker); i++) await sleep(20);
    nested = Number(readFileSync(marker, "utf8")); assert(nested > 1);
    child.kill("SIGTERM"); await closed;
    for (let i = 0; i < 25 && alive(nested); i++) await sleep(20);
    assert.equal(alive(nested), false, "Setup left its child alive");
  } finally { child.kill("SIGKILL"); if (nested && alive(nested)) process.kill(nested, "SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("empty query browses snapshot pages and single characters search without rebuilding", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-browse-")));
  const root = path.join(dir, "files"); mkdirSync(root);
  const env = { ...process.env, FE_CONFIG_DIR: path.join(dir, "config"), FE_DATA_DIR: path.join(dir, "cache") };
  const exe = process.env.FE_TEST_CLI || process.execPath;
  const prefix = process.env.FE_TEST_CLI ? [] : [path.resolve("src/cli.ts")];
  const run = (...args: string[]) => JSON.parse(execFileSync(exe, [...prefix, ...args, "--json"], { env, encoding: "utf8", timeout: 10000 }));
  try {
    for (const name of ['ä.wav', 'b.pdf', 'c.txt', 'd.wav']) writeFileSync(path.join(root, name), "data");
    run("index", root, "--name", "demo");
    const index = path.join(dir, "cache", "index-demo.txt"); const before = statSync(index).mtimeMs;
    const p1 = run("search", "", "--index", "demo", "--snapshot", "-n", "2");
    assert.equal(p1.paths.length, 2); assert.equal(p1.nextOffset, 2);
    const p2 = run("search", "", "--index", "demo", "--snapshot", "-n", "2", "--offset", String(p1.nextOffset));
    assert.equal(p1.snapshotId, p2.snapshotId);
    assert.equal(new Set([...p1.paths, ...p2.paths]).size, 4);
    assert.equal(run("search", "ä", "--index", "demo", "--snapshot").paths.length, 1);
    assert.equal(statSync(index).mtimeMs, before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
