import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,ChildProcess} from 'node:child_process';
import {mkdtempSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {Database} from 'bun:sqlite';
import {SearchProcess,SearchWork} from '../src/search-process';

const program=`
 import {Database} from 'bun:sqlite';import {createInterface} from 'node:readline';
 const db=new Database(':memory:');
 for await(const line of createInterface({input:process.stdin})){
  const r=JSON.parse(line);
  if(r.query==='slow'){process.stderr.write('computing\\n');db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n').get();}
  if(r.query==='crash')process.exit(1);
  console.log(JSON.stringify({id:r.id,data:{paths:[r.query]}}));
 }
`;
const work=(query:string,client='native-test',generation=1,priority='foreground'):SearchWork=>({query,client,generation,priority,index:'demo',limit:1,offset:0});
function fixture(){
 const children:ChildProcess[]=[];let computing:()=>void=()=>{};
 const reader=new SearchProcess(()=>{
  const child=spawn(process.execPath,['--eval',program],{detached:true,stdio:['pipe','pipe','pipe']});children.push(child);
  child.stderr!.on('data',d=>{if(d.toString().includes('computing'))computing()});return child;
 });
 return {reader,children,started:()=>new Promise<void>(resolve=>{computing=resolve})};
}
const gone=(pid:number)=>{try{process.kill(pid,0);return false}catch(e){if(e.code==='ESRCH')return true;throw e}};
async function waitFor(fn:()=>boolean,label:string,ms=3000){const deadline=Date.now()+ms;while(!fn()){if(Date.now()>deadline)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,20));}}

test('a newer generation interrupts real synchronous SQLite, reaps its reader and reuses the replacement',async()=>{
 const {reader,children,started}=fixture();
 try{
  const computing=started(),old=reader.search(work('slow'),new AbortController().signal).catch(e=>e);await computing;
  assert.equal(reader.canSync(),false,'Live writes must not contend with an active reader');
  const pid=children[0].pid!,start=performance.now();
  assert.deepEqual((await reader.search(work('latest','native-test',2),new AbortController().signal)).paths,['latest']);
  assert(performance.now()-start<500,'Latest input must not wait for the old SQL');
  assert.equal((await old).code,'SEARCH_CANCELED');assert(gone(pid),'Canceled reader must have exited');
  const replacement=reader.status().pid;
  await reader.search(work('warm','native-test',3),new AbortController().signal);
  assert.equal(reader.status().pid,replacement);assert.equal(reader.status().starts,2);
  assert.equal(reader.canSync(),true,'Completed reads release live synchronization');
  await assert.rejects(async()=>reader.search(work('stale','native-test',1),new AbortController().signal),e=>(e as any).code==='SEARCH_CANCELED');
  assert.equal(reader.status().starts,2);
 }finally{reader.close();}
});

test('a refused reader-group signal retires the reader instead of crashing the service',async()=>{
 const {reader,children}=fixture(),original=process.kill;
 try{
  assert.deepEqual((await reader.search(work('first'),new AbortController().signal)).paths,['first']);
  const pid=children[0].pid!;
  // Observed on macOS: process.kill(-pid) throws EPERM; a throw here crashed the whole service.
  process.kill=((target:number,signal?:string|number)=>{if(target<0)throw Object.assign(new Error('kill EPERM'),{code:'EPERM'});return original(target,signal as any)}) as typeof process.kill;
  assert.doesNotThrow(()=>(reader as unknown as {retire:()=>void}).retire(),'Retiring must never throw into a service callback');
  assert.equal(reader.status().pid,null);
  await waitFor(()=>gone(pid),'The reader itself must be killed when its group signal is refused');
  assert.deepEqual((await reader.search(work('second','native-test',2),new AbortController().signal)).paths,['second']);
  assert.equal(reader.status().starts,2);
 }finally{process.kill=original;reader.close();}
});

test('client isolation, bounded admission, disconnect cancellation and crash recovery',async()=>{
 const {reader,children,started}=fixture();
 try{
  const signal=new AbortController(),computing=started(),old=reader.search(work('slow','client-one'),signal.signal).catch(e=>e);await computing;
  const pid=children[0].pid!,queued=reader.search(work('queued','client-two'),new AbortController().signal).catch(e=>e);
  const latest=reader.search(work('latest','client-two',2),new AbortController().signal);
  assert.equal(reader.status().pid,pid,'Another client must not cancel the active search');
  await assert.rejects(async()=>reader.search(work('overflow','client-three'),new AbortController().signal),e=>(e as any).status===503);
  assert.equal((await queued).code,'SEARCH_CANCELED');
  signal.abort();assert.equal((await old).code,'SEARCH_CANCELED');assert.deepEqual((await latest).paths,['latest']);assert(gone(pid));
  await assert.rejects(reader.search(work('crash','client-two',3),new AbortController().signal),/worker stopped/);
  assert.deepEqual((await reader.search(work('recovered','client-two',4),new AbortController().signal)).paths,['recovered']);
 }finally{reader.close();}
});

test('foreground requests cancel their own prefetch and keep independent clients intact',async()=>{
 const {reader,children,started}=fixture();
 try{
  const computing=started(),prefetch=reader.search(work('slow','native-test',1,'prefetch'),new AbortController().signal).catch(e=>e);await computing;
  const pid=children[0].pid!;
  assert.deepEqual((await reader.search(work('visible','native-test',1),new AbortController().signal)).paths,['visible']);
  assert.equal((await prefetch).code,'SEARCH_CANCELED');assert(gone(pid));
 }finally{reader.close();}
});

test('a typing burst keeps only the newest pending input and starts one replacement reader',async()=>{
 const {reader,started}=fixture();
 try{
  const computing=started(),old=reader.search(work('slow'),new AbortController().signal).catch(e=>e);await computing;
  const edits=Array.from({length:30},(_,i)=>reader.search(work('edit-'+i,'native-test',i+2),new AbortController().signal).catch(e=>e));
  const replies=await Promise.all(edits);assert.equal((await old).code,'SEARCH_CANCELED');
  assert(replies.slice(0,-1).every(r=>r.code==='SEARCH_CANCELED'));assert.deepEqual(replies.at(-1).paths,['edit-29']);
  assert.equal(reader.status().starts,2);assert.equal(reader.status().active,0);assert.equal(reader.status().queued,0);
 }finally{reader.close();}
});

test('reader status tolerates a short live-journal writer lock without changing the snapshot',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fe-journal-lock-')),source=path.join(dir,'index-demo.txt');writeFileSync(source,'/fixture.wav\n');
 const stamp=`${statSync(source).mtimeMs}:${statSync(source).size}`,db=new Database(path.join(dir,'live.sqlite'));
 let reader:ChildProcess|undefined,release:ReturnType<typeof setTimeout>|undefined;
 try{
  db.exec('CREATE TABLE scopes(name TEXT,stamp TEXT,revision INTEGER,problem TEXT,pid INTEGER,lastChange TEXT);CREATE TABLE jobs(scope TEXT);CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER)');
  db.query('INSERT INTO scopes VALUES(?,?,1,NULL,?,NULL)').run('demo',stamp,process.pid);
  db.exec('BEGIN EXCLUSIVE');
  const code=`import assert from 'node:assert/strict';const {liveStatus,deltaFor}=await import(${JSON.stringify(path.resolve('src/delta.ts'))});console.log('attempt');assert.equal(liveStatus('demo').revision,1);assert.equal(deltaFor('demo').revision,1);console.log('passed');`;
  reader=spawn(process.execPath,['--eval',code],{env:{...process.env,FE_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let output='',error='';
  reader.stdout!.on('data',chunk=>{output+=chunk;if(output.includes('attempt')&&!release)release=setTimeout(()=>db.exec('COMMIT'),100)});reader.stderr!.on('data',d=>error+=d);
  const [exit]=await once(reader,'exit',{signal:AbortSignal.timeout(3000)});assert.equal(exit,0,error);assert(output.includes('passed'));
  assert.equal(`${statSync(source).mtimeMs}:${statSync(source).size}`,stamp);
 }finally{clearTimeout(release);if(reader?.exitCode===null){reader.kill('SIGKILL');await once(reader,'exit');}if(db.inTransaction)db.exec('ROLLBACK');db.close();rmSync(dir,{recursive:true,force:true});}
});
