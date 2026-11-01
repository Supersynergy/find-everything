import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, readFileSync, utimesSync, renameSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellCommand } from "../src/shell";
import { Database } from "bun:sqlite";

const cli = path.resolve("src/cli.ts");
const executable = process.env.FE_TEST_CLI || process.execPath;
const prefix = process.env.FE_TEST_CLI ? [] : [cli];

test("preview prints text and reports missing files as errors", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fe-preview-"));
  try {
    const file = path.join(dir, "notes.txt");
    writeFileSync(file, "Find Everything preview regression\n");
    const out = execFileSync(executable, [...prefix, "preview", file], { encoding: "utf8" });
    assert.match(out, /Find Everything preview regression/);
    const missing = spawnSync(executable, [...prefix, "preview", path.join(dir, "missing")]);
    assert.equal(missing.status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--live-index keeps only the named indexes in the journal watch", { timeout: 30_000 }, async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-live-index-")));
  const alpha = path.join(dir, "alpha"), beta = path.join(dir, "beta");
  mkdirSync(alpha); mkdirSync(beta);
  writeFileSync(path.join(alpha, "a.txt"), "alpha\n");
  writeFileSync(path.join(beta, "b.txt"), "beta\n");
  const helper = path.join(dir, "events");
  writeFileSync(helper, `#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;for(const r of JSON.parse(s).roots)console.log(JSON.stringify({root:r.path,ready:true}));setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const env = { ...process.env, FE_DATA_DIR: path.join(dir, "cache"), FE_CONFIG_DIR: path.join(dir, "config"), FE_EVENTS_HELPER: helper };
  const run = (...args: string[]) => execFileSync(executable, [...prefix, ...args], { env, encoding: "utf8", timeout: 20_000 });
  run("index", alpha, "--name", "alpha");
  run("index", beta, "--name", "beta");
  const liveScopes = () => {
    try {
      const db = new Database(path.join(env.FE_DATA_DIR, "live.sqlite"), { readonly: true });
      try { return (db.query("SELECT name FROM scopes").all() as { name: string }[]).map(r => r.name); }
      finally { db.close(); }
    } catch { return []; }
  };
  const socket = path.join(dir, "service.sock");
  let service: ReturnType<typeof spawn> | undefined, log = "";
  try {
    service = spawn(executable, [...prefix, "serve", "--socket", socket, "--live", "--live-index", "alpha"], { env, stdio: ["ignore", "ignore", "pipe"] });
    service.stderr!.on("data", d => log += d);
    const deadline = Date.now() + 20_000; let names: string[] = [];
    while (Date.now() < deadline) { names = liveScopes(); if (names.includes("alpha")) break; await new Promise(r => setTimeout(r, 80)); }
    assert.deepEqual(names, ["alpha"], "only the requested index may own a live scope: " + log.slice(-800));
  } finally {
    if (service && service.exitCode === null) { const stopped = new Promise<void>(r => service!.once("exit", () => r())); service.kill("SIGTERM"); await stopped; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown --live-index name is reported instead of stopping the service", { timeout: 30_000 }, async () => {
  const f = fixture();
  const helper = path.join(f.dir, "events");
  writeFileSync(helper, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const env = { ...f.env, FE_EVENTS_HELPER: helper };
  const socket = path.join(f.dir, "fe.sock");
  let service: ReturnType<typeof spawn> | undefined, log = "";
  try {
    service = spawn(executable, [...prefix, "serve", "--socket", socket, "--live", "--live-index", "does-not-exist"], { env, stdio: ["ignore", "ignore", "pipe"] });
    service.stderr!.on("data", d => log += d);
    const deadline = Date.now() + 15_000; let up = false;
    while (Date.now() < deadline) { if (service.exitCode === null && existsSync(socket + ".json")) { up = true; break; } await new Promise(r => setTimeout(r, 60)); }
    assert(up, "a stale --live-index name must not stop the service: " + log.slice(-800));
    assert.match(log, /--live-index ignored \(not indexed\): does-not-exist/);
  } finally {
    if (service && service.exitCode === null) { const stopped = new Promise<void>(r => service!.once("exit", () => r())); service.kill("SIGTERM"); await stopped; }
    f.cleanup();
  }
});

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-test-")));
  const root = path.join(dir, "project with spaces");
  mkdirSync(root);
  writeFileSync(path.join(root, "notes.txt"), "project notes\n");
  writeFileSync(path.join(root, "überblick.md"), "unicode\n");
  writeFileSync(path.join(root, ".config.txt"), "hidden\n");
  writeFileSync(path.join(root, ".ignore"), "ignored.txt\n");
  writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
  mkdirSync(path.join(root, "node_modules"));
  writeFileSync(path.join(root, "node_modules", "noise.txt"), "noise\n");
  const env = { ...process.env, FE_DATA_DIR: path.join(dir, "cache"), FE_CONFIG_DIR: path.join(dir, "config"), FE_EVENTS_HELPER: process.env.FE_EVENTS_HELPER || path.resolve("app/Find Everything.app/Contents/Helpers/fe-events") };
  const run = (...args: string[]) => execFileSync(executable, [...prefix, ...args], { env, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
  const json = (...args: string[]) => JSON.parse(run(...args, "--json"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, root, env, run, json, cleanup };
}

test("project indexes preserve roots and options, isolate ad-hoc folders and refresh stale data", () => {
  const f = fixture();
  try {
    const built = f.json("index", f.root, "--name", "demo", "--preset", "project");
    assert.equal(built.stale, false);
    const paths = f.json("search", "ext:txt", "--index", "demo").paths;
    assert(paths.includes(path.join(f.root, "notes.txt")));
    assert(paths.includes(path.join(f.root, ".config.txt")));
    assert(!paths.some(p => p.includes("ignored.txt") || p.includes("node_modules")));
    const unicode = f.json("search", "überblick", "--index", "demo").paths;
    assert.deepEqual(unicode, [path.join(f.root, "überblick.md")]);
    writeFileSync(path.join(f.root, "line\nbreak.txt"), "unsupported path\n");
    const skipped = f.json("index", "--index", "demo");
    assert.equal(skipped.skipped, 1);

    const before = f.run("search", "notes", "--index", "demo", "--null");
    assert.equal(before, path.join(f.root, "notes.txt") + "\0");
    const file = path.join(f.dir, "cache", "index-demo.txt");
    writeFileSync(path.join(f.root, "new-file.txt"), "new\n");
    rmSync(path.join(f.root, "notes.txt"));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    const unchanged = f.json("search", "ext:txt", "--index", "demo");
    assert(!unchanged.paths.includes(path.join(f.root, "new-file.txt")), "age alone must never trigger a full rescan");
    const refreshed = f.json("search", "ext:txt", "--index", "demo", "--fresh").paths;
    assert(refreshed.includes(path.join(f.root, "new-file.txt")));
    assert(!refreshed.includes(path.join(f.root, "notes.txt")));
    assert.equal(f.json("indexes").find(p => p.name === "demo").stale, false);

    f.run("index", f.root, "--name", "demo", "--replace", "--no-hidden", "--include-ignored", "--exclude", "new-file.txt");
    const changed = f.json("search", "ext:txt", "--index", "demo").paths;
    assert(changed.includes(path.join(f.root, "ignored.txt")));
    assert(!changed.some(p => p.includes(".config.txt") || p.includes("new-file.txt")));
    assert.equal(f.json("search", "ignored", "--path", f.root).paths.length, 0);
    assert(f.json("search", "ignored", "--path", f.root, "--include-ignored").paths.length > 0);
    assert(f.json("search", "ignored", "--path", f.root, "--preset", "folder").paths.length > 0);
    assert.equal(f.json("search", "ignored", "--path", f.root, "--preset", "folder", "--respect-ignore").paths.length, 0);

    const snapshot = readFileSync(file, "utf8");
    renameSync(f.root, f.root + "-gone");
    assert.throws(() => f.run("index", "--index", "demo"));
    assert.equal(readFileSync(file, "utf8"), snapshot);
    f.run("indexes", "remove", "demo");
    assert(!f.json("indexes").some(p => p.name === "demo"));
    assert.throws(() => f.run("search", "ext:txt", "--index", "demo"));
  } finally { f.cleanup(); }
});

test("validation rejects traversal, invalid options and duplicate profiles; empty folder clears old hits", () => {
  const f = fixture();
  try {
    f.run("index", f.root, "--name", "demo");
    for (const args of [["search", "notes", "--index", "../../escape"], ["search", "notes", "--limit", "-1"], ["search", "--bogus"], ["index", f.root, "--name", "demo"], ["index", f.root, "--name", "home"], ["search", "notes", "--path", f.root, "--index", "demo"]]) assert.throws(() => f.run(...args));
    assert.throws(() => f.run("index", path.join(f.root, "missing"), "--name", "bad"));
    assert.throws(() => f.run("search", "term ".repeat(17), "--index", "demo"));
    assert(!f.json("indexes").some(p => p.name === "bad"));
    rmSync(f.root, { recursive: true }); mkdirSync(f.root);
    f.run("index", "--index", "demo");
    assert.deepEqual(f.json("search", "ext:txt", "--index", "demo").paths, []);
    for (const shell of ["bash", "zsh"]) {
      const script = f.run("completions", shell);
      assert.equal(spawnSync(shell, ["-n"], { input: script }).status, 0);
    }
    assert.match(f.run("completions", "fish"), /complete -c fe/);
  } finally { f.cleanup(); }
});

test("MCP performs initialize, list, search and error handling over stdio", () => {
  const f = fixture();
  try {
    f.run("index", f.root, "--name", "demo");
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" }, capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_files", arguments: { query: "notes", index: "demo" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_files", arguments: { query: "notes", index: "../../escape" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_files", arguments: { query: "notes", paths: ["/"] } } },
    ];
    const out = execFileSync(executable, [...prefix, "mcp"], { env: f.env, input: messages.map(m => JSON.stringify(m)).join("\n") + "\n", encoding: "utf8", timeout: 10_000 });
    const replies = out.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(replies.length, 5);
    assert.equal(replies[0].result.protocolVersion, "2025-11-25");
    assert(replies[1].result.tools.some(t => t.name === "query_help"));
    assert.deepEqual(JSON.parse(replies[2].result.content[0].text).paths, [path.join(f.root, "notes.txt")]);
    assert.equal(replies[3].result.isError, true);
    assert.equal(replies[4].error.code, -32602);
  } finally { f.cleanup(); }
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for child"); await new Promise(r => setTimeout(r, 25)); }
}

test("local API requires a token, rejects browser/rebinding access and searches configured folders", async () => {
  const f = fixture();
  let child: ReturnType<typeof spawn>;
  try {
    f.run("index", f.root, "--name", "demo");
    child = spawn(executable, [...prefix, "serve", "--port", "0"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stderr.on("data", d => log += d);
    await until(() => log.includes("\n"));
    const { url, token } = JSON.parse(log.trim().split("\n")[0]);
    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(url + "/health")).status, 401);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(url + "/health", { headers: { ...headers, Origin: "https://example.com" } })).status, 403);
    assert.equal((await fetch(url + "/health", { headers: { ...headers, Host: "evil.example" } })).status, 403);
    const found = await (await fetch(url + "/v1/search?q=notes&index=demo", { headers })).json();
    assert.deepEqual(found.paths, [path.join(f.root, "notes.txt")]);
    assert.equal((await fetch(url + "/v1/search?q=notes&index=../../escape", { headers })).status, 400);
    assert.equal((await fetch(url + "/v1/indexes/demo/refresh", { method: "POST", headers })).status, 200);
  } finally { if (child) { child.kill("SIGTERM"); await until(() => child.exitCode !== null); } f.cleanup(); }
});

test("watch refreshes an edited folder and exits on termination", async () => {
  const f = fixture();
  let child: ReturnType<typeof spawn>;
  try {
    f.run("index", f.root, "--name", "demo");
    child = spawn(executable, [...prefix, "watch", "--index", "demo", "--interval", "0.2"], { env: f.env, stdio: ["ignore", "ignore", "pipe"] });
    let log = ""; child.stderr.on("data", d => log += d);
    await until(() => log.includes("watching"));
    const base = path.join(f.dir, "cache", "index-demo.txt");
    const before = { text: readFileSync(base, "utf8"), mtime: statSync(base).mtimeMs };
    writeFileSync(path.join(f.root, "watch-added.txt"), "watch\n");
    await until(() => f.json("search", "watch-added", "--index", "demo").paths.length > 0);
    assert(f.json("search", "watch-added", "--index", "demo").paths.length > 0);
    assert.equal(readFileSync(base, "utf8"), before.text, "a file event must not rebuild the base index");
    assert.equal(statSync(base).mtimeMs, before.mtime);
  } finally { if (child) { child.kill("SIGTERM"); await until(() => child.exitCode !== null); } f.cleanup(); }
});

test("shell arguments remain literal and index locks recover only after their owner exits", () => {
  const f = fixture();
  try {
    const marker = path.join(f.dir, "should-not-exist");
    const literal = `a'$(touch ${marker})\nwith spaces`;
    const command = shellCommand([process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", literal]);
    const out = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), [literal]);
    assert.equal(existsSync(marker), false);

    f.run("index", f.root, "--name", "demo");
    const lock = path.join(f.dir, "cache", "index-demo.txt.lock");
    writeFileSync(lock, String(process.pid));
    assert.throws(() => f.run("index", "--index", "demo"));
    writeFileSync(lock, "99999999");
    f.run("index", "--index", "demo");
    assert.equal(existsSync(lock), false);
  } finally { f.cleanup(); }
});
