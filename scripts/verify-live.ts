import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, statSync, renameSync, copyFileSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { request } from 'node:http';
const [cli, out] = process.argv.slice(2);
if (!path.isAbsolute(cli || '') || !out) throw new Error('Usage: verify-live.ts /absolute/fe evidence-dir');
mkdirSync(out,{recursive:true});
const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-live-'))), root=path.join(dir,'project'); mkdirSync(root);
const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config'),FE_EVENTS_HELPER:path.resolve(out,'fe-events'),FE_FAVORITES_FILE:path.join(dir,'pins.json')};
const run=(...args:string[])=>JSON.parse(execFileSync(cli,[...args,'--json'],{env,encoding:'utf8',timeout:60000,maxBuffer:4e6}));
const fingerprint=(p:string)=>({mtime:statSync(p).mtimeMs,sha:createHash('sha256').update(readFileSync(p)).digest('hex')});
let service:ReturnType<typeof spawn>, log='';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean|Promise<boolean>,label:string,ms=15000){const start=performance.now();while(!await fn()){if(performance.now()-start>ms)throw new Error(label+' timed out: '+log.slice(-3000));await sleep(80);}return performance.now()-start;}
const timings:any[]=[];
let socketPath=path.join(dir,'run/search.sock'), token='';
async function get(route:string) {return new Promise<any>((resolve,reject)=>{const req=request({socketPath,path:route,headers:{Host:'localhost',Authorization:'Bearer '+token},timeout:12000},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>{try{assert.equal(res.statusCode,200,route+': '+body);resolve(JSON.parse(body));}catch(e){reject(e)}})});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Socket timeout')));req.end();});}
const search=(q:string,offset=0,limit=300)=>get('/v1/search?'+new URLSearchParams({q,index:'demo',offset:String(offset),limit:String(limit)}));
async function start(){log='';service=spawn(cli,['serve','--socket',socketPath,'--idle-seconds','1','--live'],{env,stdio:['ignore','ignore','pipe']});service.stderr.on('data',d=>log+=d);await until(()=>existsSync(socketPath+'.json')&&log.includes('watching'),'service ready');token=JSON.parse(readFileSync(socketPath+'.json','utf8')).token;await sleep(600);}
async function stop(){if(service?.exitCode===null){service.kill('SIGTERM');await until(()=>service.exitCode!==null,'service stop');}}
try{
  writeFileSync(path.join(root,'notes.txt'),'original');
  mkdirSync(path.join(root,'old-folder'));writeFileSync(path.join(root,'old-folder/inside.txt'),'nested');
  writeFileSync(path.join(root,'.ignore'),'ignored.txt\n');
  const audio=path.join(root,'a.wav');
  execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=400:duration=0.2','-threads','1',audio],{timeout:5000});
  const opus=path.join(root,'b.opus');execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-i',audio,'-threads','1',opus],{timeout:5000});
  symlinkSync(opus,path.join(root,'alias.opus'));
  writeFileSync(path.join(root,'empty.mp3'),'');const apple=Buffer.alloc(32);apple.writeUInt32BE(0x00051607);writeFileSync(path.join(root,'._meta.wav'),apple);
  run('index',root,'--name','demo');run('enrich','--index','demo');
  const mediaFile=path.join(dir,'cache/media-demo.sqlite');let db=new Database(mediaFile);db.query("UPDATE files SET status='failed',duration=NULL WHERE path LIKE '%.opus'").run();db.close();
  const repaired=run('repair-media','--index','demo','--seconds','20','--max-files','100');
  assert.equal(repaired.recovered,2);assert.equal(repaired.excluded,1);assert.equal(repaired.failed,1);assert.equal(repaired.unique,3);
  const mediaBefore=fingerprint(mediaFile), repeated=run('repair-media','--index','demo');assert.equal(repeated.inspected,0);assert.deepEqual(fingerprint(mediaFile),mediaBefore);
  const semantic=run('semantic','index','--index','demo','--query','audio: duration:<1s','--max-files','10','--seconds','30');assert.equal(semantic.analyzed,2);
  const sortedSounds=run('search','sound:"tone" duration:<1s size:1..1g sort:name-desc','--index','demo');
  assert.equal(sortedSounds.semantic,true);assert.deepEqual(sortedSounds.paths.map(p=>path.basename(p)),['b.opus','a.wav'],'semantic size ranges and explicit sort apply before paging');
  run('favorites','add',opus);
  const favoriteSound=run('search','sound:"tone" favorites:true duration:<1s sort:name-desc','--index','demo');
  assert.deepEqual(favoriteSound.paths,[opus],'favorites combine with cached semantic sound search');
  const baseFile=path.join(dir,'cache/index-demo.txt'), baseBefore=fingerprint(baseFile);
  // Log fd arguments so an accidental root traversal fails independently of timestamps.
  const fdLog=path.join(dir,'fd.jsonl'), fdWrapper=path.join(dir,'fd-wrapper');
  writeFileSync(fdWrapper,`#!${process.execPath}\nimport{appendFileSync}from'node:fs';import{spawnSync}from'node:child_process';appendFileSync(${JSON.stringify(fdLog)},JSON.stringify(process.argv.slice(2))+'\\n');const r=spawnSync('/opt/homebrew/bin/fd',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o700});
  (env as any).FE_FD=fdWrapper;
  await start();
  assert.equal((await get('/v1/updates?index=demo')).problem,null,'real journal must be usable');
  writeFileSync(path.join(root,'live-added.txt'),'new');
  timings.push({phase:'create-to-socket',ms:await until(async()=> (await search('live-added')).paths.includes(path.join(root,'live-added.txt')),'created file')});
  writeFileSync(path.join(root,'live-added.txt'),'changed'.repeat(1000));
  timings.push({phase:'content-change-to-size-cache',ms:await until(async()=> (await search('live-added size:>1000')).paths.includes(path.join(root,'live-added.txt')),'changed non-media file properties')});
  writeFileSync(path.join(root,'ignored.txt'),'ignore');mkdirSync(path.join(root,'node_modules'));writeFileSync(path.join(root,'node_modules/noise.txt'),'excluded');
  renameSync(path.join(root,'old-folder'),path.join(root,'new-folder'));rmSync(path.join(root,'notes.txt'));
  await until(async()=>{const r=await search('inside');return r.paths.length===1&&r.paths[0].includes('new-folder')},'rename subtree');
  assert.equal((await search('notes')).paths.length,0);
  assert.equal((await search('ignored')).paths.length,0);assert.equal((await search('noise')).paths.length,0);
  const pages:string[]=[];let offset=0,snapshot='';
  do{const r=await search('',offset,2);if(snapshot)assert.equal(r.snapshotId,snapshot);snapshot=r.snapshotId;pages.push(...r.paths);offset=r.nextOffset;}while(offset!==null);
  if(!pages.includes(path.join(root,'live-added.txt'))){const cache=new Database(path.join(dir,'cache/search-demo.sqlite'),{readonly:true});try{console.error(JSON.stringify({pages:pages.map(p=>path.basename(p)),storedCount:cache.query("SELECT value FROM meta WHERE key='indexedRows'").get(),actualCount:cache.query('SELECT count(*) AS n FROM files').get(),browse:await search('')}));}finally{cache.close();}}
  assert.equal(new Set(pages).size,pages.length);assert(pages.includes(path.join(root,'live-added.txt')));assert(!pages.some(p=>p.endsWith('/notes.txt')||p.includes('old-folder')));
  // Refresh known media by exact changed path, including a new short file.
  execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=400:duration=1.2','-threads','1',audio],{timeout:5000});
  copyFileSync(opus,path.join(root,'new.opus'));
  timings.push({phase:'audio-change-to-filter',ms:await until(async()=>{const r=await search('audio: duration:<1s');return !r.paths.includes(audio)&&r.paths.includes(path.join(root,'new.opus'))},'audio properties')});
  await until(async()=> (await get('/v1/updates?index=demo')).pending===0,'drain jobs');
  db=new Database(path.join(dir,'cache/sound-demo.sqlite'),{readonly:true});
  assert(db.query("SELECT vector FROM vectors WHERE path=? AND vector IS NOT NULL").get(path.join(root,'new.opus')),'new matching audio must receive a local embedding');db.close();
  await sleep(1200);assert.equal(service.exitCode,null,'live service must not exit on idle');
  const liveFile=path.join(dir,'cache/live.sqlite'), idleBefore=fingerprint(liveFile);await sleep(1200);assert.deepEqual(fingerprint(liveFile),idleBefore,'idle must not write');
  assert.deepEqual(fingerprint(baseFile),baseBefore,'events must not rewrite the base snapshot');
  await stop();
  writeFileSync(path.join(root,'offline-added.txt'),'while stopped');rmSync(path.join(root,'live-added.txt'));await sleep(1200);
  await start();
  timings.push({phase:'restart-journal-replay',ms:await until(async()=> (await search('offline-added')).paths.length===1&&(await search('live-added')).paths.length===0,'durable replay')});
  assert.deepEqual(fingerprint(baseFile),baseBefore);
  await stop();
  const calls=readFileSync(fdLog,'utf8').trim().split('\n').map(JSON.parse);
  assert(calls.length>0);assert(calls.every(args=>args.includes('--max-depth')||args.at(-1)!==root),'no recursive fd on the indexed root');
  // Continuous events must not postpone the first commit indefinitely.
  const stormPath=path.join(root,'storm-only.txt');writeFileSync(stormPath,'event stream starvation regression');
  const stormHelper=path.join(dir,'storm-helper');
  writeFileSync(stormHelper,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;const{roots}=JSON.parse(s);let id=1000;for(const r of roots)console.log(JSON.stringify({root:r.path,ready:true}));setInterval(()=>{for(const r of roots)console.log(JSON.stringify({root:r.path,uuid:'storm',cursor:String(++id),events:[{path:${JSON.stringify(stormPath)},flags:256}]}));},40);\n`,{mode:0o700});
  env.FE_EVENTS_HELPER=stormHelper;await start();
  timings.push({phase:'continuous-events-first-feedback',ms:await until(async()=> (await search('storm-only')).paths.length===1,'continuous events',900)});
  const stable=fingerprint(liveFile);await sleep(800);assert.deepEqual(fingerprint(liveFile),stable,'duplicate path events must not rewrite identical deltas');
  await stop();
  // Inject a documented FSEvents gap through the real consumer, never a rescan.
  const gapHelper=path.join(dir,'gap-helper');
  writeFileSync(gapHelper,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;const{roots}=JSON.parse(s);for(const r of roots){console.log(JSON.stringify({root:r.path,ready:true}));console.log(JSON.stringify({root:r.path,events:[{path:r.path,flags:1}],cursor:'999',uuid:'test'}));}setInterval(()=>{},1000);\n`,{mode:0o700});
  env.FE_EVENTS_HELPER=gapHelper;await start();
  const gap=await get('/v1/updates?index=demo');assert.match(gap.problem,/journal gap/);assert.equal((await search('')).complete,false);assert.deepEqual(fingerprint(baseFile),baseBefore);
  writeFileSync(path.join(out,'live-oracle.json'),JSON.stringify({passed:true,timings,repaired,repeated,baseUnchanged:true,idleUnchanged:true,fdCalls:calls,gap:gap.problem,cli:fingerprint(cli)},null,2));
  console.log(JSON.stringify({passed:true,timings,fdCalls:calls.length,baseUnchanged:true,idleUnchanged:true}));
}finally{await stop();rmSync(dir,{recursive:true,force:true});}
