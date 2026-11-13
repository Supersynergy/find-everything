import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Database} from 'bun:sqlite';
import {shellCommand} from '../src/shell';

function fixture(){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-live-check-'))),root=path.join(dir,'files');
  fs.mkdirSync(root);fs.writeFileSync(path.join(root,'stable.txt'),'keep');
  const env={...process.env,FE_DATA_DIR:path.join(dir,'data'),FE_CONFIG_DIR:path.join(dir,'config')};
  const cli=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(cli,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:20000}));
  return {dir,root,env,run,cli,prefix};
}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}};
async function until(check:()=>boolean,ms=5000){const deadline=Date.now()+ms;while(!check()){if(Date.now()>deadline)throw new Error('Owned process/fixture deadline exceeded');await new Promise(r=>setTimeout(r,20));}}

test('API stays responsive during a four-scope replay and retains all deletions and gap warnings',()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-live-replay-')));
  try{
    const launcher=process.env.FE_TEST_CLI||path.join(dir,'fe');
    if(!process.env.FE_TEST_CLI)fs.writeFileSync(launcher,'#!/bin/sh\nexec '+shellCommand([process.execPath,path.resolve('src/cli.ts')])+' "$@"\n',{mode:0o700});
    execFileSync(process.execPath,['scripts/bench-live.ts','--replay',launcher,path.join(dir,'replay'),'6000'],{encoding:'utf8',timeout:60000});
    const result=JSON.parse(fs.readFileSync(path.join(dir,'replay/result.json'),'utf8'));
    assert.equal(result.passed,true);assert.equal(result.events,24000);
    assert.equal(result.summary.timeouts,0);assert.equal(result.summary.successes,12);
    assert(result.summary.maxCompletedMs<500);assert.equal(result.gapPreserved,true);
    assert(result.matches.every((r:{matched:number;returned:number})=>r.matched===1&&r.returned===1));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
},65000);

test('parent death reaps the live worker and its event helper through the owned guardian',async()=>{
  const f=fixture();let parent:ReturnType<typeof spawn>|undefined,worker=0;
  try{
    f.run('index',f.root,'--name','one');
    const helper=path.join(f.dir,'events'),helperPid=path.join(f.dir,'helper.pid'),ready=path.join(f.dir,'ready');
    fs.writeFileSync(helper,'#!'+process.execPath+'\nimport fs from "node:fs";let input="";for await(const c of process.stdin)input+=c;fs.writeFileSync('+JSON.stringify(helperPid)+',String(process.pid));for(const r of JSON.parse(input).roots)console.log(JSON.stringify({root:r.path,ready:true}));setInterval(()=>{},1000);\n',{mode:0o700});
    const program='const {startLiveProcess}=await import('+JSON.stringify(path.resolve('src/live-process.ts'))+');await startLiveProcess(["one"]);await Bun.write('+JSON.stringify(ready)+',"ready");setInterval(()=>{},1000);';
    parent=spawn(process.execPath,['--eval',program],{env:{...f.env,FE_EVENTS_HELPER:helper},stdio:['ignore','ignore','pipe']});
    await until(()=>fs.existsSync(ready)&&fs.existsSync(helperPid));
    const db=new Database(path.join(f.env.FE_DATA_DIR,'live.sqlite'),{readonly:true});
    try{worker=db.query("SELECT pid FROM scopes WHERE name='one'").get().pid;}finally{db.close();}
    const events=Number(fs.readFileSync(helperPid,'utf8'));assert(worker>1&&worker!==parent.pid);assert(alive(worker));assert(alive(events));
    const exited=once(parent,'exit');parent.kill('SIGKILL');await exited;
    await until(()=>!alive(worker)&&!alive(events),5000);
  }finally{
    if(parent?.exitCode===null&&parent.signalCode===null){const exited=once(parent,'exit');parent.kill('SIGKILL');await exited;}
    if(worker&&alive(worker)){try{process.kill(-worker,'SIGKILL');}catch{}}
    fs.rmSync(f.dir,{recursive:true,force:true});
  }
},12000);

test('a killed SQLite writer recovers before read-only snapshot lookup',async()=>{
  const f=fixture();let writer:ReturnType<typeof spawn>|undefined;
  try{
    f.run('index',f.root,'--name','one');
    const paths=Array.from({length:6000},(_,i)=>path.join(f.root,'old-'+i+'.txt'));paths.push(path.join(f.root,'stable.txt'));
    fs.writeFileSync(path.join(f.env.FE_DATA_DIR,'index-one.txt'),paths.join('\n')+'\n');f.run('prepare','--index','one');
    const database=path.join(f.env.FE_DATA_DIR,'search-one.sqlite');
    const program='import{Database}from"bun:sqlite";const d=new Database('+JSON.stringify(database)+');d.exec("PRAGMA cache_size=10;PRAGMA cache_spill=1;BEGIN IMMEDIATE;UPDATE files SET name=name||printf(\'%01024d\',id)");console.log("dirty");setInterval(()=>{},1000);';
    writer=spawn(process.execPath,['--eval',program],{stdio:['ignore','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{let out='';const timeout=setTimeout(()=>reject(new Error('Fixture writer did not start')),5000);writer!.stdout!.on('data',d=>{out+=d;if(out.includes('dirty')){clearTimeout(timeout);resolve();}});writer!.once('error',reject);});
    const exited=once(writer,'exit');writer.kill('SIGKILL');await exited;
    assert(fs.existsSync(database+'-journal'),'Fixture must leave a hot journal');
    assert(fs.readFileSync(database+'-journal').subarray(0,8).some(value=>value!==0),'Fixture must spill pages and write a valid journal header');
    const found=f.run('search','sort:name','--index','one','-n','1');
    assert.equal(found.engine,'sqlite-trigram');assert.equal(found.coverage.matched,6001);
    assert.deepEqual(found.paths,[paths[0]],'uncommitted filename changes must be rolled back');
    assert.equal(fs.existsSync(database+'-journal'),false);
    const db=new Database(database,{readonly:true});try{assert.equal(db.query('SELECT count(*) AS n FROM files').get().n,6001);}finally{db.close();}
  }finally{
    if(writer?.exitCode===null&&writer.signalCode===null){const exited=once(writer,'exit');writer.kill('SIGKILL');await exited;}
    fs.rmSync(f.dir,{recursive:true,force:true});
  }
},15000);

test('a snapshot behind the journal is marked pending instead of current',()=>{
  const f=fixture();
  try{
    f.run('index',f.root,'--name','one');
    const source=path.join(f.env.FE_DATA_DIR,'index-one.txt'),stat=fs.statSync(source),stamp=String(stat.mtimeMs)+':'+stat.size;
    const db=new Database(path.join(f.env.FE_DATA_DIR,'live.sqlite'),{create:true});
    db.exec('CREATE TABLE scopes(name TEXT,stamp TEXT,revision INTEGER,problem TEXT,pid INTEGER,lastChange TEXT);CREATE TABLE jobs(scope TEXT);');
    db.query('INSERT INTO scopes VALUES(?,?,1,NULL,?,NULL)').run('one',stamp,process.pid);db.close();
    const program='const {presentSearch}=await import('+JSON.stringify(path.resolve('src/services.ts'))+');const value=presentSearch({engine:"sqlite-trigram",snapshotId:'+JSON.stringify(stamp+':0:0:0')+',stale:false,complete:true,warnings:[]},"one");console.log(JSON.stringify(value));';
    const result=JSON.parse(execFileSync(process.execPath,['--eval',program],{env:f.env,encoding:'utf8',timeout:5000}));
    assert.equal(result.complete,false);assert.equal(result.stale,true);assert(result.warnings.some((w:string)=>w.includes('Live changes are pending')));
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
