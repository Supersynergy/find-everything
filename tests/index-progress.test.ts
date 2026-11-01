import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { ActiveIndexClock, type IndexProgress } from "../src/index-progress";

const cli = path.resolve("src/cli.ts");
const executable = process.env.FE_TEST_CLI || process.execPath;
const prefix = process.env.FE_TEST_CLI ? [] : [cli];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!condition() && Date.now() < deadline) await delay(20);
  assert.ok(condition(), message);
}

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "fe-index-progress-")));
  const root = path.join(dir, "files"), counter = path.join(dir, "counter"), helper = path.join(dir, "fd");
  fs.mkdirSync(root);
  fs.writeFileSync(helper, `#!${process.execPath}\nimport fs from 'node:fs';\nconst root=process.env.FE_TEST_ROOT;for(let i=0;i<Number(process.env.FE_TEST_COUNT||180);i++){fs.writeFileSync(process.env.FE_TEST_COUNTER,String(i));process.stdout.write(root+'/'+(process.env.FE_TEST_LABEL||'new')+'-'+i+'.txt\\0');await new Promise(r=>setTimeout(r,20));}\n`, { mode: 0o700 });
  const env = { ...process.env, FE_DATA_DIR: path.join(dir, "cache"), FE_CONFIG_DIR: path.join(dir, "config"), FE_FD: helper, FE_TEST_ROOT: root, FE_TEST_COUNTER: counter };
  return { dir, root, counter, env, run: (...args: string[]) => execFileSync(executable, [...prefix, ...args], { env: { ...env, FE_TEST_COUNT: "3", FE_TEST_LABEL: "old" }, encoding: "utf8", timeout: 10000 }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function launch(env: NodeJS.ProcessEnv, args: string[]) {
  const child = spawn(executable, [...prefix, ...args, "--progress-json"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const events: IndexProgress[] = []; let buffer = "", errors = "";
  child.stdout!.on("data", data => {
    buffer += data.toString(); let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) events.push(JSON.parse(line)); }
  });
  child.stderr!.on("data", data => { errors = (errors + data.toString()).slice(-4096); });
  const done = new Promise<number | null>(resolve => child.once("close", resolve));
  return { child, events, done, errors: () => errors };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGTERM"); await done;
}

test("index timeout counts running time, never a long user pause", () => {
  const clock = new ActiveIndexClock(0);
  assert.equal(clock.elapsed(500), 500);
  clock.setPaused(true, 1000);
  assert.equal(clock.elapsed(1200000), 1000);
  clock.setPaused(false, 1200100);
  assert.equal(clock.elapsed(1200200), 1100);
});

test("progress job pauses the real scanner group, resumes, and finishes with exact totals", { timeout: 20000 }, async () => {
  const f = fixture(); let job: ReturnType<typeof launch> | undefined;
  try {
    job = launch(f.env, ["index", f.root, "--name", "progress"]);
    await until(() => job!.events.some(e => e.phase === "scan" && e.files > 0), "Scanner must report actual files before pause: " + job.errors());
    job.child.kill("SIGUSR2");
    await until(() => job!.events.some(e => e.paused), "Pause must be acknowledged");
    const count = fs.readFileSync(f.counter, "utf8");
    await delay(250);
    assert.equal(fs.readFileSync(f.counter, "utf8"), count, "Pause must stop producer CPU/IO, not merely the animation");
    job.child.kill("SIGUSR2");
    await until(() => fs.readFileSync(f.counter, "utf8") !== count, "Resume must restart the same owned scanner");
    assert.equal(await job.done, 0, job.errors());
    const final = job.events.at(-1)!;
    assert.equal(final.phase, "complete"); assert.equal(final.files, 180); assert.equal(final.paused, false);
    assert.equal(final.bytesRead, final.totalBytes);
    assert.ok(job.events.some(e => e.phase === "prepare" && e.totalBytes! > 0));
    assert.ok(job.events.filter(e => e.phase === "scan").every(e => e.totalBytes === undefined), "Unknown scan total must not invent a percentage");
  } finally { if (job) await stop(job.child); f.cleanup(); }
});

test("cancelling a paused rebuild releases workers and keeps the old snapshot and profiles", { timeout: 20000 }, async () => {
  const f = fixture(); let job: ReturnType<typeof launch> | undefined;
  try {
    f.run("index", f.root, "--name", "saved");
    const before = new Map(fs.readdirSync(f.env.FE_DATA_DIR).filter(name => !name.endsWith(".lock")).map(name => [name, fs.readFileSync(path.join(f.env.FE_DATA_DIR, name))]));
    const profiles = fs.readdirSync(f.env.FE_CONFIG_DIR).map(name => [name, fs.readFileSync(path.join(f.env.FE_CONFIG_DIR, name))] as const);
    job = launch(f.env, ["index", "--index", "saved"]);
    await until(() => job!.events.some(e => e.phase === "scan" && e.files > 0), "Rebuild must start");
    job.child.kill("SIGUSR2"); await until(() => job!.events.some(e => e.paused), "Rebuild must pause");
    job.child.kill("SIGTERM"); assert.notEqual(await job.done, 0);
    const stoppedAt = fs.readFileSync(f.counter, "utf8"); await delay(150);
    assert.equal(fs.readFileSync(f.counter, "utf8"), stoppedAt, "No owned scanner may outlive cancelled supervisor");
    for (const [name, content] of before) assert.deepEqual(fs.readFileSync(path.join(f.env.FE_DATA_DIR, name)), content, "Old snapshot/cache changed: " + name);
    for (const [name, content] of profiles) assert.deepEqual(fs.readFileSync(path.join(f.env.FE_CONFIG_DIR, name)), content, "Saved profile changed");
    assert.ok(fs.readdirSync(f.env.FE_DATA_DIR).every(name => !name.endsWith(".tmp") && !name.endsWith(".lock")), "Cancelled scan must clean staging files and locks");
  } finally { if (job) await stop(job.child); f.cleanup(); }
});

test("supervisor crash while paused cannot orphan a stopped scanner or its lock", { timeout: 20000 }, async () => {
  const f=fixture();let job:ReturnType<typeof launch>|undefined;
  try {
    f.run('index',f.root,'--name','saved');
    job=launch(f.env,['index','--index','saved']);
    await until(()=>job!.events.some(event=>event.phase==='scan'&&event.files>0),'Scan must start');
    job.child.kill('SIGUSR2');await until(()=>job!.events.some(event=>event.paused),'Pause must acknowledge');
    job.child.kill('SIGKILL');
    await until(()=>fs.readdirSync(f.env.FE_DATA_DIR).every(name=>!name.endsWith('.lock')&&!name.endsWith('.tmp')),'Guardian must wake and clean paused worker after supervisor death');
    const at=fs.readFileSync(f.counter,'utf8');await delay(150);assert.equal(fs.readFileSync(f.counter,'utf8'),at);
    await job.done;
  } finally {if(job)await stop(job.child);f.cleanup();}
});

test("native parent lifetime pipe EOF cancels a paused worker without waiting for timeout", { timeout: 20000 }, async () => {
  const f=fixture();let job:ReturnType<typeof launch>|undefined;
  try {
    job=launch(f.env,['index',f.root,'--name','parent-lifetime','--parent-bound']);
    await until(()=>job!.events.some(e=>e.phase==='scan'&&e.files>0),'Bound scan must start');
    job.child.kill('SIGUSR2');await until(()=>job!.events.some(e=>e.paused),'Bound scan must pause');
    job.child.stdin!.end();
    assert.notEqual(await job.done,0,'EOF from a dead native parent must cancel even while paused');
    assert.ok(fs.readdirSync(f.env.FE_DATA_DIR).every(name=>!name.endsWith('.lock')&&!name.endsWith('.tmp')));
    const count=fs.readFileSync(f.counter,'utf8');await delay(150);assert.equal(fs.readFileSync(f.counter,'utf8'),count);
  } finally {if(job)await stop(job.child);f.cleanup();}
});

test("built-in system scanner works without optional Homebrew tools and preserves exclusions", { timeout: 20000 }, async () => {
  const f=fixture();
  try {
    fs.mkdirSync(path.join(f.root,'node_modules'));fs.writeFileSync(path.join(f.root,'node_modules','exclude.txt'),'x');
    fs.mkdirSync(path.join(f.root,'notes'));fs.writeFileSync(path.join(f.root,'notes','included.txt'),'x');
    fs.writeFileSync(path.join(f.root,'.hidden.txt'),'x');
    const env={...f.env,FE_FD:'fd',PATH:'/usr/bin:/bin'};
    const job=launch(env,['index',f.root,'--name','native-walker','--no-hidden']);
    try {
      assert.equal(await job.done,0,job.errors());
      const paths=fs.readdirSync(f.env.FE_DATA_DIR).filter(name=>name.endsWith('.txt')).flatMap(name=>fs.readFileSync(path.join(f.env.FE_DATA_DIR,name),'utf8').split('\n'));
      assert.ok(paths.some(p=>p.endsWith('/notes/included.txt')),'System walker must find normal files');
      assert.ok(paths.every(p=>!p.includes('node_modules')&&!p.includes('.hidden.txt')),'System walker must prune configured exclusions');
    } finally {await stop(job.child);}
  } finally {f.cleanup();}
});
