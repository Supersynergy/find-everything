import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {socketRequest} from '../src/socket';

test('a prepared lookup catches up with more than 100000 deltas and deletes only the selected Unicode subtree',{timeout:120000},()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-large-delta-'))),root=path.join(dir,'files'),cache=path.join(dir,'cache');fs.mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:cache,FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:90000,maxBuffer:4*1024**2}));
  try{
    run('index',root,'--name','demo');
    const folder=path.join(root,'📁-archive'),kept=[path.join(root,'📁-archive-old','receipt.pdf'),path.join(root,'📁-archive0','receipt.pdf')];
    fs.writeFileSync(path.join(cache,'index-demo.txt'),[path.join(folder,'deep','receipt.pdf'),...kept].join('\n')+'\n');
    run('prepare','--index','demo');
    const stat=fs.statSync(path.join(cache,'index-demo.txt')),db=new Database(path.join(cache,'live.sqlite'));
    try{
      db.exec('CREATE TABLE scopes(name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER,pid INTEGER,problem TEXT,lastChange TEXT); CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path)); CREATE TABLE jobs(scope TEXT,path TEXT);');
      db.query('INSERT INTO scopes VALUES (?,?,1,1073741824,NULL,NULL)').run('demo',`${stat.mtimeMs}:${stat.size}`);
      const add=db.query('INSERT INTO changes VALUES (?,?,0,?,1)');
      db.transaction(()=>{add.run('demo',folder,1);for(let i=0;i<100000;i++)add.run('demo',path.join(root,'gone',String(i)),0);})();
    }finally{db.close();}
    const result=run('search','receipt view:all','--index','demo');assert.equal(result.engine,'sqlite-trigram');assert.deepEqual(new Set(result.paths),new Set(kept));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('live updates retain CR/LF names and accept a new path beyond the old overlay cap',{timeout:30000},async()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-live-overflow-'))),root=path.join(dir,'files'),cache=path.join(dir,'cache');fs.mkdirSync(root);
  const helper=path.join(dir,'events'),env={...process.env,FE_DATA_DIR:cache,FE_CONFIG_DIR:path.join(dir,'config'),FE_EVENTS_HELPER:helper};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const names=['new\rname.txt','new\nname.txt'],files=names.map(name=>path.join(root,name));
  let service:ReturnType<typeof spawn>|undefined;
  try{
    execFileSync(exe,[...prefix,'index',root,'--name','demo','--exhaustive'],{env,timeout:10000});
    execFileSync(exe,[...prefix,'prepare','--index','demo'],{env,timeout:10000});
    const stat=fs.statSync(path.join(cache,'index-demo.txt')),db=new Database(path.join(cache,'live.sqlite'));
    try{
      db.exec('CREATE TABLE scopes(name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER,pid INTEGER,problem TEXT,lastChange TEXT); CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path)); CREATE TABLE jobs(scope TEXT,path TEXT,failures INTEGER DEFAULT 0,retryAt REAL DEFAULT 0); CREATE TABLE streams(root TEXT PRIMARY KEY,uuid TEXT,cursor TEXT);');
      db.query('INSERT INTO scopes VALUES (?,?,0,1073741824,NULL,NULL)').run('demo',`${stat.mtimeMs}:${stat.size}`);
      const add=db.query('INSERT INTO changes VALUES (?,?,0,0,0)');db.transaction(()=>{for(let i=0;i<100000;i++)add.run('demo',path.join(root,'gone',String(i)));})();
    }finally{db.close();}
    for(const p of files)fs.writeFileSync(p,'fixture');
    fs.writeFileSync(helper,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;for(const r of JSON.parse(s).roots){console.log(JSON.stringify({root:r.path,ready:true}));console.log(JSON.stringify({root:r.path,uuid:'fixture',cursor:'1',events:${JSON.stringify(files.map(p=>({path:p,flags:256})))}}));}setInterval(()=>{},1000);\n`,{mode:0o700});
    const socket=path.join(dir,'service.sock');service=spawn(exe,[...prefix,'serve','--socket',socket,'--live'],{env,stdio:['ignore','ignore','pipe']});let log='';service.stderr!.on('data',d=>log+=d);
    const deadline=Date.now()+15000;let journalReady=false;
    while(Date.now()<deadline){const live=new Database(path.join(cache,'live.sqlite'),{readonly:true});try{journalReady=Number(live.query("SELECT count(*) AS n FROM changes WHERE scope='demo' AND present=1").get()?.n)===2;}finally{live.close();}if(journalReady&&fs.existsSync(socket+'.json'))break;await new Promise(r=>setTimeout(r,100));}
    assert(journalReady,'Both special paths must survive a full old-sized overlay: '+log.slice(-500));
    for(const p of files){const result=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:`name:${JSON.stringify(path.basename(p))} view:all`,index:'demo'}));assert(result.paths.includes(p));assert.equal(result.live.problem,null);}
  }finally{if(service&&service.exitCode===null&&service.signalCode===null){const done=new Promise<void>(r=>service!.once('exit',()=>r()));service.kill('SIGTERM');await done;}fs.rmSync(dir,{recursive:true,force:true});}
});
