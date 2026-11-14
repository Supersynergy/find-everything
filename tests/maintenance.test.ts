import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {socketRequest} from '../src/socket';
import {initDirectoryRetries} from '../src/targeted-rescan';
import {Database} from 'bun:sqlite';
function fixture(){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-maint-'))),root=path.join(dir,'files'),data=path.join(dir,'data');fs.mkdirSync(root);fs.mkdirSync(data);
  const env={...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(dir,'config')};
  const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[path.resolve('src/cli.ts'),...args,'--json'],{env,encoding:'utf8',timeout:60000}));
  const evaluate=(code:string)=>JSON.parse(execFileSync(process.execPath,['--eval',code],{env,encoding:'utf8',timeout:20000}));
  return {dir,root,data,env,run,evaluate};
}
test('resumable compaction preserves new events, gaps, CR/LF paths and the previous snapshot',()=>{
  const f=fixture();try{
    const a=path.join(f.root,'alpha.txt'),b=path.join(f.root,'beta.txt'),n=path.join(f.root,'line\nbreak.txt'),late=path.join(f.root,'late.txt');
    fs.writeFileSync(a,'a');fs.writeFileSync(b,'b');f.run('index',f.root,'--name','demo');f.run('prepare','--index','demo');fs.writeFileSync(n,'n');
    const stat=fs.statSync(path.join(f.data,'index-demo.txt')),db=new Database(path.join(f.data,'live.sqlite'),{create:true});
    db.exec('CREATE TABLE scopes(name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER,problem TEXT,pid INTEGER,lastChange TEXT);CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path));CREATE TABLE jobs(scope TEXT,path TEXT,failures INTEGER,retryAt REAL,PRIMARY KEY(scope,path));');
    initDirectoryRetries(db);
    const originalStamp=stat.mtimeMs+':'+stat.size;
    db.query("INSERT INTO directory_retries(scope,path,stamp,source,provider) VALUES('demo',?,?,'event','')").run(f.root+'/pending',originalStamp);
    db.query("INSERT INTO directory_retry_seeds VALUES ('demo',?,'scan')").run(originalStamp);
    db.query('INSERT INTO scopes VALUES(?,?,1,?, ?,NULL)').run('demo',`${stat.mtimeMs}:${stat.size}`,'fixture history gap',process.pid);db.query('INSERT INTO changes VALUES(?,?,1,0,1)').run('demo',n);db.close();
    assert(f.run('search','view:all','--index','demo').paths.includes(n));
    const partial=f.run('compact','--index','demo','--rows','1');assert.equal(partial.resumable,true);
    fs.unlinkSync(b);fs.writeFileSync(late,'late');const live=new Database(path.join(f.data,'live.sqlite'));
    live.query('INSERT INTO changes VALUES(?,?,0,0,2)').run('demo',b);live.query('INSERT INTO changes VALUES(?,?,1,0,2)').run('demo',late);live.exec('UPDATE scopes SET revision=2');live.close();
    const result=f.run('compact','--index','demo');assert.equal(result.resumable,false);assert.equal(result.live.problem,'fixture history gap');
    const migrated=new Database(path.join(f.data,'live.sqlite'),{readonly:true});
    const stamp=migrated.query("SELECT stamp FROM scopes WHERE name='demo'").get().stamp;
    assert.notEqual(stamp,originalStamp);
    assert.deepEqual(migrated.query("SELECT stamp,generation FROM directory_retries WHERE scope='demo'").get(),{stamp,generation:2});
    assert.equal(migrated.query("SELECT stamp FROM directory_retry_seeds WHERE scope='demo'").get().stamp,stamp);
    migrated.close();
    const found=f.run('search','view:all','--index','demo');assert.deepEqual(found.paths.slice().sort(),[a,n,late].sort());assert.equal(found.complete,false);
    assert(fs.existsSync(path.join(f.data,'index-demo.txt.compacting/previous.paths')));
    fs.unlinkSync(n);const later=new Database(path.join(f.data,'live.sqlite'));later.query('INSERT OR REPLACE INTO changes VALUES(?,?,0,0,3)').run('demo',n);later.exec('UPDATE scopes SET revision=3');later.close();
    assert(!f.run('search','view:all','--index','demo').paths.includes(n));f.run('compact','--index','demo');
    assert(!f.run('search','view:all','--index','demo').paths.includes(n),'a second compaction must not resurrect an earlier special path');
    fs.unlinkSync(path.join(f.data,'search-demo.sqlite'));f.run('prepare','--index','demo');
    assert.deepEqual(f.run('search','view:all','--index','demo').paths.slice().sort(),[a,late].sort());
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
},20000);
for(const targetName of ['paths.txt','lookup.sqlite','metadata.json'])test('publication recovery after renaming '+targetName,()=>{
  const f=fixture();try{
    const file=path.join(f.root,'keep.txt');fs.writeFileSync(file,'keep');f.run('index',f.root,'--name','demo');f.run('prepare','--index','demo');
    const target=path.join(f.data,'index-demo.txt');
    const code=`import fs from 'node:fs';const original=fs.renameSync;fs.renameSync=function(a,b){const result=original(a,b);if(String(a).endsWith('/'+${JSON.stringify(targetName)}))process.kill(process.pid,'SIGKILL');return result;};const {compactIndex}=await import(${JSON.stringify(path.resolve('src/compaction.ts'))});await compactIndex('demo');`;
    const child=spawnSync(process.execPath,['--eval',code],{env:f.env,encoding:'utf8',timeout:20000});assert.equal(child.signal,'SIGKILL');
    const result=f.run('search','view:all','--index','demo');assert.deepEqual(result.paths,[file]);
    assert.equal(fs.existsSync(target+'.compacting/publish.json'),false);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('reconciliation rebuilds current files while a failed scanner preserves the prior snapshot',()=>{
  const f=fixture();try{
    const old=path.join(f.root,'old.txt'),fresh=path.join(f.root,'fresh.txt');fs.writeFileSync(old,'old');f.run('index',f.root,'--name','demo');
    fs.unlinkSync(old);fs.writeFileSync(fresh,'fresh');f.run('reconcile','--index','demo');
    assert(fs.readFileSync(path.join(f.data,'index-demo.txt'),'utf8').includes(fresh));
    const before=fs.readFileSync(path.join(f.data,'index-demo.txt')),scanner=path.join(f.dir,'failed-fd');fs.writeFileSync(scanner,'#!/bin/sh\nexit 2\n',{mode:0o700});
    const result=spawnSync(process.execPath,[path.resolve('src/cli.ts'),'reconcile','--index','demo'],{env:{...f.env,FE_FD:scanner},encoding:'utf8'});
    assert.notEqual(result.status,0);assert(fs.readFileSync(path.join(f.data,'index-demo.txt')).equals(before));
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('exact short-query counts survive reader restart and invalidate after an external edit',()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.root,'ne-first.txt'),'x');f.run('index',f.root,'--name','demo');
    fs.writeFileSync(path.join(f.data,'index-demo.txt'),Array.from({length:100000},(_,i)=>path.join(f.root,`ne-${i}.txt`)).join('\n')+'\n');f.run('prepare','--index','demo');
    const code=`import {initDirectoryRetries} from '../src/targeted-rescan';
import {Database} from 'bun:sqlite';let counts=0;const query=Database.prototype.query;Database.prototype.query=function(sql){if(/count\\(\\*\\).*FROM files f/i.test(sql))counts++;return query.call(this,sql);};const {searchFiles}=await import(${JSON.stringify(path.resolve('src/services.ts'))});const result=await searchFiles('ne sort:name','demo',10,{},false,true);console.log(JSON.stringify({counts,matched:result.coverage.matched,paths:result.paths}));`;
    const first=f.evaluate(code),second=f.evaluate(code);assert.equal(first.matched,100000);assert(first.counts>0);assert.equal(second.counts,0);assert.deepEqual(second.paths,first.paths);
    const db=new Database(path.join(f.data,'search-demo.sqlite'));db.exec("UPDATE files SET name='other.txt',nameKey='other.txt' WHERE id=1");db.close();
    const changed=f.evaluate(code);assert(changed.counts>0);assert.equal(changed.matched,99999);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
},60000);
test('durable count cache stays bounded and rejects invalid numeric counts',()=>{
  const f=fixture();try{
    const result=f.evaluate(`const c=await import(${JSON.stringify(path.resolve('src/count-cache.ts'))});for(let i=0;i<180;i++)c.writeExactCounts('demo',String(i),{total:i,known:i,matched:i});c.writeExactCounts('demo','invalid',{total:1,known:2,matched:1});const {Database}=await import('bun:sqlite');const db=new Database(c.countCachePath('demo'),{readonly:true});console.log(JSON.stringify({n:db.query('SELECT count(*) AS n FROM counts').get().n,invalid:c.readExactCounts('demo','invalid')??null}));db.close();`);
    assert.equal(result.n,128);assert.equal(result.invalid,null);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('count cache filenames remain visible without a metadata feedback loop',async()=>{
  const f=fixture();let service:ReturnType<typeof spawn>|undefined;
  try{
    f.run('index',f.dir,'--name','demo','--exhaustive');f.run('prepare','--index','demo');
    const file=path.join(f.data,'counts-demo.sqlite'),marker=path.join(f.dir,'done'),helper=path.join(f.dir,'events');
    fs.writeFileSync(helper,`#!${process.execPath}\nimport fs from 'node:fs';import{Database}from'bun:sqlite';let s='';for await(const c of process.stdin)s+=c;const root=JSON.parse(s).roots[0].path;const file=${JSON.stringify(file)};new Database(file,{create:true}).close();console.log(JSON.stringify({root,ready:true}));console.log(JSON.stringify({root,uuid:'fixture',cursor:'1',events:[{path:file,flags:256}]}));setTimeout(()=>{fs.utimesSync(file,new Date(),new Date());console.log(JSON.stringify({root,uuid:'fixture',cursor:'2',events:[{path:file,flags:4096}]}));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'done'),700);},800);setInterval(()=>{},1000);\n`,{mode:0o700});
    const socket=path.join(f.dir,'service.sock');service=spawn(process.execPath,[path.resolve('src/cli.ts'),'serve','--socket',socket,'--live','--live-index','demo'],{env:{...f.env,FE_EVENTS_HELPER:helper},stdio:['ignore','ignore','pipe']});
    const deadline=Date.now()+6000;while(!fs.existsSync(marker)||!fs.existsSync(socket+'.json')){if(Date.now()>deadline)throw new Error('Fixture events not committed');await new Promise(r=>setTimeout(r,30));}
    const live=new Database(path.join(f.data,'live.sqlite'),{readonly:true});try{assert.equal(live.query("SELECT revision FROM scopes WHERE name='demo'").get().revision,1);}finally{live.close();}
    const result=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:'name:counts-demo.sqlite view:all',index:'demo'}));assert(result.paths.includes(file));
  }finally{if(service?.exitCode===null&&service.signalCode===null){const exited=once(service,'exit');service.kill('SIGTERM');await exited;}fs.rmSync(f.dir,{recursive:true,force:true});}
},10000);

test('recovery refuses an externally changed target or missing stage before renaming anything',()=>{
  for(const damage of ['target','stage']){
    const f=fixture();try{
      const file=path.join(f.root,'keep.txt');fs.writeFileSync(file,'keep');f.run('index',f.root,'--name','demo');f.run('prepare','--index','demo');
      const target=path.join(f.data,'index-demo.txt'),stage=target+'.compacting';
      const code=`import fs from 'node:fs';const original=fs.renameSync;fs.renameSync=function(a,b){const result=original(a,b);if(String(b).endsWith('/publish.json'))process.kill(process.pid,'SIGKILL');return result;};const {compactIndex}=await import(${JSON.stringify(path.resolve('src/compaction.ts'))});await compactIndex('demo');`;
      assert.equal(spawnSync(process.execPath,['--eval',code],{env:f.env,timeout:20000}).signal,'SIGKILL');
      if(damage==='target')fs.appendFileSync(target,'/external-file\n');else fs.unlinkSync(path.join(stage,'metadata.json'));
      const before=fs.readFileSync(target),lookup=fs.readFileSync(path.join(f.data,'search-demo.sqlite'));
      const recovery=spawnSync(process.execPath,[path.resolve('src/cli.ts'),'compact','--index','demo'],{env:f.env,encoding:'utf8',timeout:20000});
      assert.notEqual(recovery.status,0);assert.match(recovery.stderr,/changed|Missing/);
      assert(fs.readFileSync(target).equals(before));assert(fs.readFileSync(path.join(f.data,'search-demo.sqlite')).equals(lookup));assert(!fs.existsSync(path.join(stage,'previous.paths')));
    }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
  }
},30000);

test('corrupt checkpoints and unknown compact commands cannot resize or replace the saved index',()=>{
  const f=fixture();try{
    fs.writeFileSync(path.join(f.root,'keep.txt'),'x');f.run('index',f.root,'--name','demo');f.run('prepare','--index','demo');f.run('compact','--index','demo','--rows','1');
    const target=path.join(f.data,'index-demo.txt'),stage=target+'.compacting',state=JSON.parse(fs.readFileSync(path.join(stage,'state.json'),'utf8'));
    const original=fs.readFileSync(target),size=fs.statSync(path.join(stage,'paths.txt')).size;
    state.bytes=Number.MAX_SAFE_INTEGER;fs.writeFileSync(path.join(stage,'state.json'),JSON.stringify(state));
    for(const args of [['compact','--index','demo'],['compact','typo','--index','demo']]){const r=spawnSync(process.execPath,[path.resolve('src/cli.ts'),...args],{env:f.env,encoding:'utf8',timeout:20000});assert.notEqual(r.status,0);}
    assert.equal(fs.statSync(path.join(stage,'paths.txt')).size,size);assert(fs.readFileSync(target).equals(original));
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
