import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, realpathSync } from "node:fs";
import { tmpdir,homedir } from "node:os";
import path from "node:path";
import { execFileSync,spawn } from "node:child_process";
import {once} from 'node:events';

import { wave } from "./fixtures";
import {Database} from 'bun:sqlite';
import {MODEL_ID} from '../src/semantic-worker';
import {compareSearchProperties} from '../src/engine';
import {socketRequest} from '../src/socket';

test("media predicates are complete before limiting, reusable and explicit about coverage", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-smart-")));
  const root = path.join(dir, "sounds"); mkdirSync(root);
  const env = { ...process.env, FE_CONFIG_DIR: path.join(dir, "config"), FE_DATA_DIR: path.join(dir, "cache") };
  const exe = process.env.FE_TEST_CLI || process.execPath;
  const prefix = process.env.FE_TEST_CLI ? [] : [path.resolve("src/cli.ts")];
  const run = (...args: string[]) => JSON.parse(execFileSync(exe, [...prefix, ...args, "--json"], { env, encoding: "utf8", timeout: 30000 }));
  try {
    for (let i = 0; i < 25; i++) writeFileSync(path.join(root, `long-${i}.wav`), wave(1.5));
    writeFileSync(path.join(root, "boundary.wav"), wave(1));
    writeFileSync(path.join(root, "short ü.wav"), wave(0.5));
    writeFileSync(path.join(root, "broken.wav"), "broken");
    run("index", root, "--name", "sounds", "--preset", "folder");
    const missing = run("search", "audio: duration:<1s", "--index", "sounds");
    assert.equal(missing.complete, false);
    assert(missing.warnings.length > 0);
    const first = run("enrich", "--index", "sounds", "--max-files", "100");
    assert.equal(first.probed, 28); assert.equal(first.failed, 1);
    const result = run("search", "audio: duration:<1s", "--index", "sounds", "-n", "1");
    assert.deepEqual(result.paths, [path.join(root, "short ü.wav")]);
    assert.equal(result.complete, false); // corrupt audio remains unknown
    assert.equal(result.media[0].duration, 0.5);
    assert.deepEqual(run('search','name:"short ü" duration:<1s sort:name-desc size:1..100000','--index','sounds','-n','1').paths,result.paths);
    assert.deepEqual(run("search", "alle meine sounds die unter 1 sekunde gehen", "--index", "sounds").paths, result.paths);
    const db = path.join(dir, "cache", "media-sounds.sqlite");
    const before = statSync(db).mtimeMs;
    const second = run("enrich", "--index", "sounds", "--max-files", "100");
    assert.equal(second.probed, 0); assert.equal(second.reused, 28);
    assert.equal(statSync(db).mtimeMs, before);
    for (let i = 0; i < 3; i++) run("search", "type:audio duration:<1s", "--index", "sounds");
    assert.equal(statSync(db).mtimeMs, before);
    writeFileSync(path.join(root, "boundary.wav"), wave(0.25, 16000, 2));
    const changed = run("enrich", "--index", "sounds", "--max-files", "100");
    assert.equal(changed.probed, 1);
    assert.deepEqual(run("search", "audio: duration:<1s channels:2 samplerate:>=16k", "--index", "sounds").paths, [path.join(root, "boundary.wav")]);
    const page1 = run("search", "audio: duration:<1s", "--index", "sounds", "-n", "1");
    assert.equal(page1.nextOffset, 1);
    const page2 = run("search", "audio: duration:<1s", "--index", "sounds", "-n", "1", "--offset", "1");
    assert.equal(page2.nextOffset, null); assert.equal(page1.snapshotId, page2.snapshotId);
    assert.notEqual(page1.paths[0], page2.paths[0]);
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "media-page-test", version: "1" }, capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_files", arguments: { query: "audio: duration:<1s", index: "sounds", limit: 1, offset: 1 } } },
    ];
    const reply = execFileSync(exe, [...prefix, "mcp"], { env, encoding: "utf8", input: requests.map(r => JSON.stringify(r)).join("\n") + "\n", timeout: 10000 });
    const tool = JSON.parse(reply.trim().split("\n").pop()!).result;
    assert.deepEqual(JSON.parse(tool.content[0].text).paths, page2.paths);
    assert.equal(run("search", "audio: duration:<1s", "--index", "sounds", "--offset", "100").paths.length, 0);
    assert.throws(() => run("search", "audio: duration:<1s", "--index", "sounds", "--offset", "1.2"));
    assert.throws(() => run("search", "duration:banana", "--index", "sounds"));
    assert.throws(() => run("search", "channels:-1", "--index", "sounds"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function rankedSounds(){
  // Smart views intentionally exclude /private/var; use an ordinary user folder.
  const dir=realpathSync(mkdtempSync(path.join(homedir(),'fe-relevance-'))),root=path.join(dir,'root');mkdirSync(root);mkdirSync(path.join(root,'laser'));
  const env={...process.env,FE_CONFIG_DIR:path.join(dir,'config'),FE_DATA_DIR:path.join(dir,'cache'),FE_LEARNING_FILE:path.join(dir,'learning.json')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  const files=['laser.wav','laser-a.wav','laser-z.wav','laser/other.wav'].map(p=>path.join(root,p));
  [.8,.1,.6,.05].forEach((duration,i)=>writeFileSync(files[i],wave(duration)));
  run('index',root,'--name','sounds');run('enrich','--index','sounds','--max-files','10');
  return {dir,env,files,run,exe,prefix,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('media relevance uses text tiers before pagination and size; learned preferences preserve text relevance',async()=>{
  const f=rankedSounds(),socket=path.join(f.dir,'s.sock');
  // Exercise the persistent app backend without repeatedly paying CLI startup;
  // retain an explicit CLI parity check and all paging/learning assertions.
  const server=spawn(f.exe,[...f.prefix,'serve','--socket',socket],{env:f.env,stdio:['ignore','ignore','pipe']});
  const search=(q:string,limit=100,offset=0)=>socketRequest(socket,'/v1/search?'+new URLSearchParams({q,index:'sounds',limit:String(limit),offset:String(offset)}));
  try{
    await once(server.stderr,'data');
    const q='laser duration:<1s view:smart sort:relevance';
    const initial=await search(q);assert.equal(initial.media.length,f.files.length);assert.deepEqual(initial.paths,f.files);
    assert.deepEqual(f.run('search',q,'--index','sounds').paths,initial.paths);
    assert.deepEqual((await search(q.replace(' sort:relevance',''))).paths,f.files);
    assert.deepEqual((await search(q.replace('sort:relevance','sort:small'))).paths,[f.files[3],f.files[1],f.files[2],f.files[0]]);
    for(let i=0;i<4;i++){const page=await search(q,1,i);assert.deepEqual(page.paths,[f.files[i]]);assert.equal(page.snapshotId,initial.snapshotId);}
    f.run('learn','open',f.files[2],'--query','laser duration:<1s','--index','sounds');
    const learned=await search(q);assert.deepEqual(learned.paths,[f.files[0],f.files[2],f.files[1],f.files[3]]);assert.notEqual(learned.snapshotId,initial.snapshotId);
    assert.deepEqual((await search(q+' learn:off')).paths,f.files);
    writeFileSync(f.env.FE_LEARNING_FILE,'invalid');assert((await search(q)).warnings.some((w:string)=>w.includes('Local learning unavailable')));
    assert.throws(()=>compareSearchProperties({path:'a',size:2},{path:'b',size:1},'relevance'),/property sort/);
  }finally{if(server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}f.cleanup();}
});

test('semantic relevance preserves acoustic similarity rather than ascending file size',()=>{
  const f=rankedSounds();try{
    const db=new Database(path.join(f.env.FE_DATA_DIR,'sound-sounds.sqlite'));
    db.exec('CREATE TABLE vectors(path TEXT PRIMARY KEY,size INTEGER,mtime REAL,model TEXT,vector BLOB,error TEXT)');
    try{f.files.forEach((p,i)=>{const s=statSync(p),v=new Float32Array(512),score=[.95,.7,.5,.1][i];v[0]=score;v[1]=Math.sqrt(1-score*score);db.query('INSERT INTO vectors VALUES(?,?,?,?,?,NULL)').run(p,s.size,s.mtimeMs,MODEL_ID,Buffer.from(v.buffer));});}finally{db.close();}
    // Deterministic text-embedding fixture exercises the production cached-
    // vector search/paging path, not model quality; no model setup/download.
    const program=`import {SemanticWorker} from './src/semantic-worker';import {parseQuery} from './src/engine';import {searchSounds} from './src/semantic';SemanticWorker.prototype.embed=async()=>Array.from({length:512},(_,i)=>i===0?1:0);const out=[];for(const sort of ['', 'relevance','small']){out.push(await searchSounds('sounds',parseQuery('sound:"laser sound" duration:<1s view:smart'+(sort?' sort:'+sort:'')),10,0));}console.log(JSON.stringify(out));`;
    const [natural,relevance,small]=JSON.parse(execFileSync(process.execPath,['--eval',program],{env:f.env,encoding:'utf8',timeout:10000}));
    assert.deepEqual(natural.paths,f.files);assert.deepEqual(relevance.paths,natural.paths);assert.deepEqual(relevance.scores,natural.scores);
    assert(relevance.scores[0].similarity>relevance.scores[3].similarity);assert.deepEqual(small.paths,[f.files[3],f.files[1],f.files[2],f.files[0]]);
  }finally{f.cleanup();}
});

test("selective filters run before candidate caps can hide late matches", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fe-cap-")));
  const root = path.join(dir, "root"); mkdirSync(root);
  const file = path.join(root, "common-final.wav"); writeFileSync(file, wave(.1));
  const env = { ...process.env, FE_DATA_DIR: path.join(dir, "cache"), FE_CONFIG_DIR: path.join(dir, "config") };
  const exe = process.env.FE_TEST_CLI || process.execPath;
  const prefix = process.env.FE_TEST_CLI ? [] : [path.resolve("src/cli.ts")];
  const run = (...args: string[]) => execFileSync(exe, [...prefix, ...args], { env, encoding: "utf8", timeout: 10000 });
  try {
    run("index", root, "--name", "demo");
    const paths = Array.from({ length: 48000 }, (_, i) => path.join(root, `common-${i}.txt`)); paths.push(file);
    writeFileSync(path.join(dir, "cache", "index-demo.txt"), paths.join("\n") + "\n");
    rmSync(path.join(dir, "cache", "index-demo.d"), { recursive: true, force:true });
    assert.deepEqual(JSON.parse(run("search", "common ext:wav", "--index", "demo", "--json")).paths, [file]);
    const unicodePaths = Array.from({ length: 1000 }, (_, i) => path.join(root, `${"界ü".repeat(70)}-${i}.wav`));
    writeFileSync(path.join(dir, "cache", "index-demo.txt"), unicodePaths.join("\n") + "\n");
    rmSync(path.join(dir, "cache", "index-demo.d"), { recursive: true, force:true });
    assert.deepEqual(JSON.parse(run("search", "ext:wav", "--index", "demo", "-n", "1000", "--json")).paths.sort(), unicodePaths.sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
