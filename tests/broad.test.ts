import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Database} from 'bun:sqlite';
import {socketRequest} from '../src/socket';

test('broad short terms, exclusions and sparse properties preserve exact pages through RAM cache eviction and invalidation',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fe-broad-')),root=path.join(dir,'root');mkdirSync(root);
 const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config'),FE_FAVORITES_FILE:path.join(dir,'pins.json')};
 const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
 const run=(...args:string[])=>execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000});
 let child:ReturnType<typeof spawn>|undefined;
 try{
  run('index',root,'--name','demo');
  const rows=Array.from({length:24000},(_,i)=>({
   id:i+1,path:`/Volumes/FE/${i%7?'abcdefghijklmn-dark':'quiet'}/${i%13===0?'node_modules/':''}p${Math.floor(i/10)}/${i%17===0?'Dark':i%19===0?'überblick':'tone'}-${String(i).padStart(5,'0')}.${i%3?'wav':'md'}`,
   size:i%11===0?i:null,mtime:i%17===0?i+1000:null
  }));
  const source=path.join(env.FE_DATA_DIR,'index-demo.txt');writeFileSync(source,rows.map(r=>r.path).join('\n')+'\n');run('prepare','--index','demo');
  const file=path.join(env.FE_DATA_DIR,'search-demo.sqlite'),db=new Database(file);
  const update=db.query('UPDATE files SET size=?,mtime=? WHERE id=?');db.transaction(()=>{for(const r of rows)update.run(r.size,r.mtime,r.id)})();db.close();
  const before=[source,file].map(f=>[statSync(f).mtimeMs,statSync(f).size]);
  (env as any).FE_FD='/usr/bin/false';
  const socket=path.join(dir,'s.sock');child=spawn(exe,[...prefix,'serve','--socket',socket],{env,stdio:['ignore','ignore','pipe']});let log='';child.stderr!.on('data',d=>log+=d);
  for(let i=0;i<300&&!log.includes('\n');i++){if(child.exitCode!==null)throw new Error(log);await new Promise(r=>setTimeout(r,10));}assert(log.includes('\n'));
  const call=(q:string,offset=0,preview=false)=>socketRequest(socket,'/v1/search?'+new URLSearchParams({index:'demo',q,limit:'27',offset:String(offset),...(preview?{phase:'preview'}:{})}));
  for(const term of ['d','da','a','e','x','D','ü','dark','tone'])for(const omit of [false,true])for(const sort of ['name','name-desc','path','path-desc','big','small','new','old']){
   const matching=rows.filter(r=>(/[A-Z]/.test(term)?r.path.includes(term):r.path.toLowerCase().includes(term))&&(!omit||!r.path.includes('/node_modules/')));
   const field=sort==='big'||sort==='small'?'size':sort==='new'||sort==='old'?'mtime':null;
   const expected=[...matching].sort((a,b)=>{
    if(field){const x=a[field],y=b[field];if(x===null||y===null){if(x!==y)return x===null?1:-1;}else if(x!==y)return (x-y)*(sort==='big'||sort==='new'?-1:1);return (a.id-b.id)*(sort==='big'||sort==='new'?-1:1);}
    const x=sort.startsWith('path')?path.dirname(a.path).toLowerCase():path.basename(a.path).toLowerCase(),y=sort.startsWith('path')?path.dirname(b.path).toLowerCase():path.basename(b.path).toLowerCase();
    const result=x<y?-1:x>y?1:sort.startsWith('path')?path.basename(a.path).localeCompare(path.basename(b.path),'en'):a.id-b.id;
    return result*(sort.endsWith('-desc')?-1:1);
   });
   const query=term+(omit?' omit:generated':'')+' sort:'+sort;
   const preview=await call(query,0,true);assert.equal(preview.provisional,true,query);assert.equal(preview.coverage.matched,null,query);assert.equal(preview.complete,false,query);assert.deepEqual(preview.paths,expected.slice(0,27).map(r=>r.path),query);
   for(const offset of [0,Math.max(0,expected.length-35)]){
    const r=await call(query,offset);assert.equal(r.engine,'sqlite-trigram',query);assert.equal(r.coverage.matched,expected.length,query);assert.deepEqual(r.paths,expected.slice(offset,offset+27).map(r=>r.path),query);
    assert.equal(r.coverage.metadataUnknown,field?matching.filter(r=>r[field]===null).length:0,query);
   }
  }
  for(const q of ['d !quiet','d|quiet omit:generated','name:tone omit:generated','d ext:md','in:/Volumes/FE/quiet omit:hidden','zz-never-matches']){
   const preview=await call(q,0,true),full=await call(q);assert.deepEqual(preview.paths,full.paths,q);assert.deepEqual(preview.properties,full.properties,q);
  }
  const both=await call('d size:>100 dm:999999d sort:big');
  for(const q of ['omit:generated','d size:>100 dm:999999d sort:big','size:>100 sort:name','dm:999999d sort:new']){
   const preview=await call(q,0,true),full=await call(q);assert.equal(preview.provisional,true,q);assert.equal(preview.coverage.matched,null,q);assert.deepEqual(preview.paths,full.paths,q);assert.deepEqual(preview.properties,full.properties,q);
  }
  assert.equal(both.coverage.metadataUnknown,rows.filter(r=>r.path.toLowerCase().includes('d')&&(r.size===null||r.mtime===null)).length);
  for(const q of ['d !quiet','d|quiet omit:generated','name:tone omit:generated','d ext:md']){
   const r=await call(q);assert.equal(r.engine,'sqlite-trigram');assert(r.paths.length>0);
  }
  // Exceed the term-cache entry count, then revisit an evicted broad term.
  const letters='abcdefghijklmn',terms:string[]=[];
  for(let start=0;start<letters.length;start++)for(let end=start+2;end<=letters.length;end++)terms.push(letters.slice(start,end));
  for(const term of terms.slice(0,70))await call(term);
  const beforeChange=await call('d omit:generated');assert.equal(beforeChange.coverage.matched,rows.filter(r=>r.path.toLowerCase().includes('d')&&!r.path.includes('/node_modules/')).length);
  assert.deepEqual([source,file].map(f=>[statSync(f).mtimeMs,statSync(f).size]),before);
  const changed=new Database(file);changed.exec("UPDATE meta SET value='1' WHERE key='propertiesRevision'; UPDATE files SET size=999999 WHERE id=2");changed.close();
  const after=await call('d omit:generated sort:big');assert.equal(after.properties[0].size,999999);
  // Source replacement invalidates both counts and cached membership tables.
  writeFileSync(source,'/Volumes/FE/dark/new.wav\n');run('prepare','--index','demo');
  const fresh=await call('d omit:generated');assert.deepEqual(fresh.paths,['/Volumes/FE/dark/new.wav']);assert.equal(fresh.coverage.matched,1);
 }finally{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}rmSync(dir,{recursive:true,force:true});}
});

test('live property lookups in other scopes retain the active search cache',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fe-maintenance-')),root=path.join(dir,'root');mkdirSync(root);
 const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
 const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
 const run=(...args:string[])=>execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000});
 try{
  for(const scope of ['active','one','two','three','four']){
   run('index',root,'--name',scope);
   writeFileSync(path.join(env.FE_DATA_DIR,`index-${scope}.txt`),Array.from({length:1200},(_,i)=>`/Volumes/FE/${i%3?'dark':'quiet'}/p${i}/tone.wav`).join('\n')+'\n');
   run('prepare','--index',scope);
  }
  const program=`
   import {Database} from 'bun:sqlite';
   import assert from 'node:assert/strict';
   const {searchPrepared,cachedFileProperties,syncSearch}=await import(${JSON.stringify(path.resolve('src/path-search.ts'))});
   const {parseQuery}=await import(${JSON.stringify(path.resolve('src/engine.ts'))});
   const parsed=parseQuery('d omit:generated');
   const first=searchPrepared('active',parsed,27,0);assert.equal(first.coverage.matched,800);
   let builds=0;const original=Database.prototype.exec;
   Database.prototype.exec=function(sql){if(sql.startsWith('CREATE TEMP TABLE'))builds++;return original.call(this,sql)};
   for(const scope of ['one','two','three','four']){cachedFileProperties(scope,'/Volumes/FE/dark/p1/tone.wav');syncSearch(scope);}
   const next=searchPrepared('active',parsed,27,0);assert.deepEqual(next,first);
   assert.equal(builds,0,'Live maintenance must not evict and rebuild the active query cache');
  `;
  execFileSync(process.execPath,['--eval',program],{env,encoding:'utf8',timeout:10000});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
