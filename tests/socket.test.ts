import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, utimesSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { Database } from "bun:sqlite";
import { socketRequest } from "../src/socket";
import { wave } from "./fixtures";

// 20 s: the cache, eviction and lock-retry cases below wait on purpose.
test("private socket shares search semantics, bounded cache, invalidation and clean restart", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fe-sock-"));
  const root = path.join(dir, "root"); mkdirSync(root);
  const socket = path.join(dir, "search.sock");
  const env = { ...process.env, FE_DATA_DIR: path.join(dir, "cache"), FE_CONFIG_DIR: path.join(dir, "config"),FE_FAVORITES_FILE:path.join(dir,'pins.json') };
  const exe = process.env.FE_TEST_CLI || process.execPath;
  const prefix = process.env.FE_TEST_CLI ? [] : [path.resolve("src/cli.ts")];
  const run = (...args: string[]) => execFileSync(exe, [...prefix, ...args], { env, encoding: "utf8", timeout: 10000 });
  let child: ReturnType<typeof spawn>;
  const start = async (idleSeconds = 300) => {
    child = spawn(exe, [...prefix, "serve", "--socket", socket, "--idle-seconds", String(idleSeconds)], { env, stdio: ["ignore", "ignore", "pipe"] });
    for (let i = 0; i < 100 && !existsSync(socket + ".json"); i++) { if (child.exitCode !== null) throw new Error("Socket server exited"); await delay(10); }
    assert(existsSync(socket + ".json"));
  };
  const stop = async () => { if (child && child.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; } };
  // `pgrep -P` is the portable parent selector here; BSD ps has no -P option.
  const hasReader = (pid: number) => { try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().length > 0; } catch { return false; } };
  try {
    writeFileSync(path.join(root, "alpha.md"), "a"); run("index", root, "--name", "demo");
    await start();
    // The reader is started with the service, before any query arrives.
    for (let i = 0; i < 150 && !hasReader(child.pid!); i++) await delay(20);
    assert(hasReader(child.pid!), "the service warms its search reader before the first query");
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    assert.equal(statSync(socket + ".json").mode & 0o777, 0o600);
    const route = "/v1/search?q=ext:md&index=demo&limit=100";
    const first = await socketRequest(socket, route);
    const second = await socketRequest(socket, route);
    assert.equal(first.cacheHit, false); assert.equal(second.cacheHit, true);
    await delay(2500);
    assert.equal((await socketRequest(socket, route)).cacheHit, true); // unchanged sources stay cached past the old 2 s window
    assert.deepEqual(second.paths, JSON.parse(run("search", "ext:md", "--index", "demo", "--json")).paths);
    const favoriteRoute='/v1/search?q=favorites:true%20ext:md&index=demo';
    const naturalFavoriteRoute='/v1/search?'+new URLSearchParams({q:'(favorisierte Dateien)',index:'demo'});
    assert.deepEqual((await socketRequest(socket,favoriteRoute)).paths,[]);
    assert.deepEqual((await socketRequest(socket,naturalFavoriteRoute)).paths,[]);
    run('favorites','add',first.paths[0]);
    assert.deepEqual((await socketRequest(socket,favoriteRoute)).paths,first.paths);
    assert.deepEqual((await socketRequest(socket,naturalFavoriteRoute)).paths,first.paths);
    assert.deepEqual((await socketRequest(socket,favoriteRoute.replace('favorites:','FAVORITES:'))).paths,first.paths);
    run('favorites','remove',first.paths[0]);
    assert.deepEqual((await socketRequest(socket,favoriteRoute)).paths,[]);
    assert.deepEqual((await socketRequest(socket,naturalFavoriteRoute)).paths,[]);
    assert.deepEqual((await socketRequest(socket,favoriteRoute.replace('favorites:','FAVORITES:'))).paths,[]);
    writeFileSync(path.join(root, "a.wav"), wave(.25)); writeFileSync(path.join(root, "b.wav"), wave(.5));
    run("index", "--index", "demo"); run("enrich", "--index", "demo");
    const mediaRoute = "/v1/search?q=audio:%20duration:%3C1s&index=demo&limit=1";
    const page1 = await socketRequest(socket, mediaRoute);
    const page2 = await socketRequest(socket, mediaRoute + "&offset=1");
    assert.equal(page1.nextOffset, 1); assert.equal(page2.nextOffset, null);
    assert.notEqual(page1.paths[0], page2.paths[0]); assert.equal(page1.snapshotId, page2.snapshotId);
    // A writer holding the accelerator must cost a retry, not a full index scan.
    const accel = new Database(path.join(dir, "cache", "search-demo.sqlite"));
    accel.exec("BEGIN IMMEDIATE");
    const duringLock = socketRequest(socket, route);
    await delay(400);
    accel.exec("COMMIT"); accel.close();
    const locked = await duringLock;
    assert.equal(locked.engine, "sqlite-trigram");
    assert(!locked.warnings.some((w: string) => w.startsWith("Fast lookup is unavailable")), locked.warnings.join(" | "));
    const rejected = spawnSync(exe, [...prefix, "serve", "--socket", socket], { env, timeout: 1000 });
    assert.equal(rejected.status, 1); // ownership lock, existing server still works
    writeFileSync(path.join(root, "beta.md"), "b"); run("index", "--index", "demo");
    const refreshed = await socketRequest(socket, route);
    assert.equal(refreshed.cacheHit, false); assert.equal(refreshed.paths.length, 2);
    const indexFile = path.join(dir, "cache", "index-demo.txt");
    const old = new Date(Date.now() - 7200000); utimesSync(indexFile, old, old);
    const before = statSync(indexFile).mtimeMs;
    assert.equal((await socketRequest(socket, route)).stale, true);
    assert.equal(statSync(indexFile).mtimeMs, before); // queries do not trigger full rescans
    // 256 entries are the cache bound: the oldest unused key is dropped, the newest stays.
    for (let i = 0; i < 260; i++) await socketRequest(socket, `/v1/search?q=probe${i}%20ext:md&index=demo&limit=5`);
    assert.equal((await socketRequest(socket, route)).cacheHit, false);
    assert.equal((await socketRequest(socket, "/v1/search?q=probe259%20ext:md&index=demo&limit=5")).cacheHit, true);
    await assert.rejects(socketRequest(socket, "/v1/search?q=duration:bad&index=demo"));
    await stop(); assert(!existsSync(socket)); assert(!existsSync(socket + ".json"));
    await start(1); assert.equal((await socketRequest(socket, route)).paths.length, 2);
    await once(child, "exit", { signal: AbortSignal.timeout(3000) });
    assert(!existsSync(socket)); assert(!existsSync(socket + ".json"));
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("app-owned socket service exits after its parent is terminated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fe-owner-"));
  const socket = path.join(dir, "search.sock");
  const exe = process.env.FE_TEST_CLI || process.execPath;
  const prefix = process.env.FE_TEST_CLI ? [] : [path.resolve("src/cli.ts")];
  const env = { ...process.env, FE_TEST_SERVER_CMD: JSON.stringify([exe, ...prefix, "serve", "--socket", socket, "--parent"]) };
  const program = "const {spawn}=require('child_process');const [exe,...args]=JSON.parse(process.env.FE_TEST_SERVER_CMD);spawn(exe,args,{stdio:'ignore'});setInterval(()=>{},1000);";
  const owner = spawn(process.execPath, ["-e", program], { env, stdio: "ignore" });
  let servicePid: number;
  try {
    for (let i = 0; i < 100 && !existsSync(socket + ".json"); i++) await delay(10);
    const info = JSON.parse(readFileSync(socket + ".json", "utf8")); servicePid = info.pid;
    assert.equal(info.ownerPid, owner.pid); assert.equal(info.apiRevision, 7);
    const done = once(owner, "exit"); owner.kill("SIGTERM"); await done;
    for (let i = 0; i < 120 && existsSync(socket); i++) await delay(25);
    assert(!existsSync(socket)); assert(!existsSync(socket + ".json"));
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { const done = once(owner, "exit"); owner.kill("SIGTERM"); await done; }
    if (servicePid && existsSync(socket)) { try { process.kill(servicePid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
    rmSync(dir, { recursive: true, force: true });
  }
});
