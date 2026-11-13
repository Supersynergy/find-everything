import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Database} from 'bun:sqlite';
import {socketRequest} from '../src/socket';
import {wave} from './fixtures';

function fixture(){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-cache-'))),root=path.join(dir,'files');fs.mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'data'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:20000}));
  const stamp=(name:string)=>{const s=fs.statSync(path.join(env.FE_DATA_DIR,'index-'+name+'.txt'));return String(s.mtimeMs)+':'+s.size;};
  const journal=()=>{
    const db=new Database(path.join(env.FE_DATA_DIR,'live.sqlite'),{create:true});
    db.exec('CREATE TABLE scopes(name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER,problem TEXT,pid INTEGER,lastChange TEXT);CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path));CREATE TABLE jobs(scope TEXT,path TEXT);');
    for(const name of ['demo','other'])db.query('INSERT INTO scopes VALUES(?,?,0,NULL,?,NULL)').run(name,stamp(name),process.pid);
    return db;
  };
  return {dir,root,env,exe,prefix,run,journal};
}

test('API caches isolate scopes/backends, canonicalize queries and bind post-sync snapshots',async()=>{
  const f=fixture(),socket=path.join(f.dir,'api.sock');let child:ReturnType<typeof spawn>|undefined,db:Database|undefined;
  try{
    const a=path.join(f.root,'common.txt');fs.writeFileSync(a,'x');
    for(const name of ['Alpha.txt','alpha-lower.txt','é.txt','two  spaces.txt'])fs.writeFileSync(path.join(f.root,name),'x');
    f.run('index',f.root,'--name','demo');f.run('prepare','--index','demo');f.run('properties','--index','demo');
    f.run('index',f.root,'--name','other');f.run('prepare','--index','other');db=f.journal();
    child=spawn(f.exe,[...f.prefix,'serve','--socket',socket],{env:f.env,stdio:['ignore','ignore','pipe']});
    const deadline=Date.now()+5000;
    while(!fs.existsSync(socket+'.json')){if(child.exitCode!==null||Date.now()>deadline)throw new Error('Test service failed to start');await new Promise(r=>setTimeout(r,10));}
    const search=(q:string)=>socketRequest(socket,'/v1/search?'+new URLSearchParams({q,index:'demo',limit:'100'}));
    const first=await search('common sort:name');assert.equal(first.cacheHit,false);
    const alias=await search('  common   sort:name  ');assert.equal(alias.cacheHit,true);assert.equal(alias.query,'  common   sort:name  ');assert.deepEqual(alias.paths,[a]);
    db.exec("UPDATE scopes SET revision=1 WHERE name='other'");
    assert.equal((await search('common sort:name')).cacheHit,true,'unrelated journal scope');
    fs.writeFileSync(path.join(f.env.FE_DATA_DIR,'media-demo.sqlite'),'unrelated backend changed');
    assert.equal((await search('common sort:name')).cacheHit,true,'unrelated backend');
    db.exec("UPDATE scopes SET problem='fixture journal gap' WHERE name='demo'");
    const gap=await search('common sort:name');assert.equal(gap.cacheHit,true);assert.equal(gap.complete,false);assert(gap.warnings.includes('fixture journal gap'));
    db.exec("UPDATE scopes SET problem=NULL WHERE name='demo'");assert.equal((await search('common sort:name')).complete,true);
    const upper=await search('Alpha sort:name'),lower=await search('alpha sort:name');
    assert.equal(lower.cacheHit,false);assert.equal(upper.paths.length,1);assert.equal(lower.paths.length,2);
    await search('é sort:name');assert.equal((await search('e\u0301 sort:name')).cacheHit,true);
    assert.equal((await search('name:"two  spaces.txt" sort:name')).paths.length,1);
    assert.equal((await search('name:"two spaces.txt" sort:name')).paths.length,0);
    const added=path.join(f.root,'common-added.txt');fs.writeFileSync(added,'new');
    db.query('INSERT INTO changes VALUES(?,?,1,0,1)').run('demo',added);db.exec("UPDATE scopes SET revision=1 WHERE name='demo'");
    const synced=await search('common sort:name');assert.equal(synced.cacheHit,false);assert.equal(synced.coverage.matched,2);assert(synced.paths.includes(added));
    assert.equal((await search('common sort:name')).cacheHit,true,'post-sync snapshot binding');
    assert.equal((await search('common size:>10 sort:name')).coverage.matched,0);
    fs.writeFileSync(a,'x'.repeat(50));db.query('INSERT INTO changes VALUES(?,?,1,0,2)').run('demo',a);db.exec("UPDATE scopes SET revision=2 WHERE name='demo'");
    const changed=await search('common sort:name');assert.equal(changed.properties.find((r:{path:string})=>r.path===a).size,50);assert.equal(changed.coverage.matched,2);
    assert.deepEqual((await search('common size:>10 sort:name')).paths,[a]);
    const file=path.join(f.env.FE_DATA_DIR,'search-demo.sqlite');
    const edit=(target:string,size:number)=>{const external=new Database(target);try{external.query('UPDATE files SET size=? WHERE name=?').run(size,'common.txt');}finally{external.close();}const stat=fs.statSync(target);fs.utimesSync(target,stat.atime,new Date(stat.mtimeMs+2000));};
    edit(file,70);
    const external=await search('common sort:name');assert.equal(external.cacheHit,false);assert.equal(external.properties.find((r:{path:string})=>r.path===a).size,70);
    assert.equal((await search('common sort:name')).cacheHit,true);
    const replacement=file+'.replacement';fs.copyFileSync(file,replacement);edit(replacement,90);fs.renameSync(replacement,file);
    const replaced=await search('common sort:name');assert.equal(replaced.cacheHit,false);assert.equal(replaced.properties.find((r:{path:string})=>r.path===a).size,90);
    assert.equal((await search('common sort:name')).cacheHit,true);
  }finally{
    db?.close();if(child?.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
    fs.rmSync(f.dir,{recursive:true,force:true});
  }
});

test('hydration and property-only events retain name aggregates with fresh properties',()=>{
  const f=fixture();
  try{
    for(let i=0;i<40;i++)fs.writeFileSync(path.join(f.root,'common-'+String(i).padStart(3,'0')+'.txt'),'x'.repeat(i+1));
    f.run('index',f.root,'--name','demo');f.run('prepare','--index','demo');f.run('index',f.root,'--name','other');f.journal().close();
    const program=String.raw`
      import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {Database} from 'bun:sqlite';
      const {parseQuery}=await import(process.env.FE_SOURCE+'/src/engine.ts');
      const {searchPrepared,indexProperties,syncSearch}=await import(process.env.FE_SOURCE+'/src/path-search.ts');
      const original=Database.prototype.query;let aggregateCalls=0;
      Database.prototype.query=function(sql){if(/count\s*\(/i.test(sql))aggregateCalls++;return original.call(this,sql);};
      const names=()=>searchPrepared('demo',parseQuery('common sort:name'),100,0);
      const sizes=()=>searchPrepared('demo',parseQuery('common size:>20 sort:name'),100,0);
      assert.equal(names().coverage.matched,40);assert.equal(sizes().coverage.matched,0);
      await indexProperties('demo',100,10);let before=aggregateCalls;
      const hydrated=names();assert.equal(aggregateCalls,before,'hydration must reuse exact name counts');assert.equal(hydrated.properties.at(-1).size,40);
      assert.equal(sizes().coverage.matched,20);assert(aggregateCalls>before,'property counts recomputed');
      const live=new Database(path.join(process.env.FE_DATA_DIR,'live.sqlite')),updated=path.join(process.env.FE_ROOT,'common-000.txt');fs.writeFileSync(updated,'x'.repeat(100));
      live.query('INSERT INTO changes VALUES(?,?,1,0,1)').run('demo',updated);live.exec("UPDATE scopes SET revision=1 WHERE name='demo'");
      syncSearch('demo');before=aggregateCalls;const changed=names();assert.equal(aggregateCalls,before,'property-only events retain name counts');assert.equal(changed.properties[0].size,100);assert.equal(sizes().coverage.matched,21);
      const added=path.join(process.env.FE_ROOT,'common-new.txt');fs.writeFileSync(added,'new');live.query('INSERT INTO changes VALUES(?,?,1,0,2)').run('demo',added);live.exec("UPDATE scopes SET revision=2 WHERE name='demo'");
      syncSearch('demo');before=aggregateCalls;assert.equal(names().coverage.matched,41);assert(aggregateCalls>before,'membership invalidates counts');
      live.query('INSERT INTO changes VALUES(?,?,0,0,3) ON CONFLICT(scope,path) DO UPDATE SET present=0,revision=3').run('demo',updated);live.exec("UPDATE scopes SET revision=3 WHERE name='demo'");
      syncSearch('demo');const removed=names();assert.equal(removed.coverage.matched,40);assert(!removed.paths.includes(updated));live.close();console.log('passed');
    `;
    const out=execFileSync(process.execPath,['--eval',program],{env:{...f.env,FE_SOURCE:path.resolve('.'),FE_ROOT:f.root},encoding:'utf8',timeout:10000});assert(out.includes('passed'));
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('live media cleanup selects exact descendants below a non-BMP directory',async()=>{
  const f=fixture(),folder=path.join(f.root,'📁'),sibling=path.join(f.root,'📁-sibling');
  fs.mkdirSync(folder);fs.mkdirSync(sibling);
  const removed=path.join(folder,'a.wav'),kept=path.join(sibling,'b.wav');
  fs.writeFileSync(removed,wave(.1));fs.writeFileSync(kept,wave(.1));
  const helper=path.join(f.dir,'events'),socket=path.join(f.dir,'live.sock');let child:ReturnType<typeof spawn>|undefined;
  try{
    f.run('index',f.root,'--name','demo');f.run('enrich','--index','demo');
    const code='#!'+process.execPath+'\nimport fs from "node:fs";let s="";for await(const c of process.stdin)s+=c;const {roots}=JSON.parse(s);fs.rmSync('+JSON.stringify(folder)+',{recursive:true});for(const r of roots){console.log(JSON.stringify({root:r.path,ready:true}));console.log(JSON.stringify({root:r.path,uuid:"fixture",cursor:"1",events:[{path:'+JSON.stringify(folder)+',flags:131584}]}));}setInterval(()=>{},1000);\n';
    fs.writeFileSync(helper,code,{mode:0o700});
    child=spawn(f.exe,[...f.prefix,'serve','--socket',socket,'--live','--live-index','demo'],{env:{...f.env,FE_EVENTS_HELPER:helper},stdio:['ignore','ignore','pipe']});
    let log='';child.stderr!.on('data',d=>log+=d);
    const deadline=Date.now()+8000;let remaining:string[]=[];
    while(Date.now()<deadline){
      const db=new Database(path.join(f.env.FE_DATA_DIR,'media-demo.sqlite'),{readonly:true});
      try{db.exec('PRAGMA busy_timeout=1000');remaining=db.query('SELECT path FROM files ORDER BY path').all().map((r:{path:string})=>r.path);}finally{db.close();}
      if(!remaining.includes(removed))break;
      if(child.exitCode!==null)throw new Error(log);
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.deepEqual(remaining,[kept],'deleted descendants are removed while prefix siblings remain');
  }finally{
    if(child?.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
    fs.rmSync(f.dir,{recursive:true,force:true});
  }
},15000);
