import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {Database} from 'bun:sqlite';
import {wave} from './fixtures';

test('all indexed name matches are counted, sorted and paginated without truncation or query writes', () => {
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-complete-'))), root=path.join(dir,'files');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath, prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000,maxBuffer:8e6}));
  try {
    run('index',root,'--name','demo');
    const paths=Array.from({length:35021},(_,i)=>path.join(root,`common-${String(35020-i).padStart(6,'0')}.${i%2?'md':'ts'}`));
    paths.push(path.join(root,'Überblick ü.md'),path.join(root,'quote "literal".md'));
    const file=path.join(dir,'cache/index-demo.txt');writeFileSync(file,paths.join('\n')+'\n');
    const first=run('search','common sort:name','--index','demo','-n','1000');
    assert.equal(first.complete,true);assert.equal(first.coverage.matched,35021);assert.equal(first.nextOffset,1000);
    const prep=run('prepare','--index','demo');assert.equal(prep.ready,true);
    const expected=paths.filter(p=>path.basename(p).startsWith('common-')).sort();
    const actual:string[]=[];let offset=0,snapshot='';
    do {const r=run('search','common sort:name','--index','demo','-n','1000','--offset',String(offset));
      assert.equal(r.complete,true);assert.equal(r.coverage.matched,expected.length);
      if(snapshot)assert.equal(r.snapshotId,snapshot);snapshot=r.snapshotId;actual.push(...r.paths);offset=r.nextOffset;
    } while(offset!==null);
    assert.deepEqual(actual,expected);assert.equal(new Set(actual).size,actual.length);
    assert.deepEqual(run('search','common-000001 sort:path','--index','demo').paths,expected.filter(p=>p.includes('common-000001')));
    assert.deepEqual(run('search','common sort:path','--index','demo','-n','300','--offset','34000').paths,expected.slice(34000,34300));
    assert.deepEqual(run('search','überblick','--index','demo').paths,[paths.at(-2)]);
    assert.deepEqual(run('search','common-000001|common-035020 ext:md','--index','demo').paths,expected.filter(p=>(p.includes('common-000001')||p.includes('common-035020'))&&p.endsWith('.md')));
    const db=path.join(dir,'cache/search-demo.sqlite'), before=statSync(db).mtimeMs, base=statSync(file).mtimeMs;
    for(let i=0;i<3;i++)run('search','common ext:ts !0000','--index','demo');
    assert.equal(statSync(db).mtimeMs,before);assert.equal(statSync(file).mtimeMs,base);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('combined view removes overlapping paths and reuses saved audio without another traversal',()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-combine-'))),root=path.join(dir,'files');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try {
    const common=path.join(root,'common.txt'),added=path.join(root,'added.txt');writeFileSync(common,'common');run('index',root,'--name','one');
    writeFileSync(added,'added');const audio=path.join(root,'short.wav');writeFileSync(audio,wave(.1));run('index',root,'--name','two');run('enrich','--index','two');
    (env as any).FE_FD='/usr/bin/false';
    const before=statSync(path.join(dir,'cache/index-one.txt')).mtimeMs;
    const combined=run('combine','--name','everything','--sources','one,two');assert.equal(combined.ready,true);assert.equal(combined.filesystemScan,false);assert.equal(combined.rows,3);
    const result=run('search','','--index','everything');assert.equal(result.coverage.matched,3);assert.deepEqual(new Set(result.paths),new Set([common,added,audio]));
    assert.deepEqual(run('search','audio: duration:<1s','--index','everything').paths,[audio]);
    const cached=statSync(path.join(dir,'cache/search-everything.sqlite')).mtimeMs;
    assert.equal(run('combine','--name','everything','--sources','one,two','--replace').reused,true);
    assert.equal(statSync(path.join(dir,'cache/search-everything.sqlite')).mtimeMs,cached);
    assert.equal(statSync(path.join(dir,'cache/index-one.txt')).mtimeMs,before);assert(result.warnings.some((w:string)=>w.includes('Combined saved indexes')));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('preparation publishes beside an active journal without acquiring its own lock twice',()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-publish-'))),root=path.join(dir,'files');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try{
    run('index',root,'--name','demo');const file=path.join(dir,'cache/index-demo.txt');writeFileSync(file,path.join(root,'old.txt')+'\n');
    const s=statSync(file),db=new Database(path.join(dir,'cache/live.sqlite'),{create:true});
    db.exec('CREATE TABLE scopes(name TEXT,stamp TEXT,revision INTEGER,pid INTEGER,problem TEXT,lastChange TEXT); CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER); CREATE TABLE jobs(scope TEXT,path TEXT);');
    db.query('INSERT INTO scopes VALUES (?,?,?,?,NULL,NULL)').run('demo',`${s.mtimeMs}:${s.size}`,1,process.pid);
    const added=path.join(root,'new.txt');writeFileSync(added,'new');db.query('INSERT INTO changes VALUES (?,?,1,0,1)').run('demo',added);db.close();
    assert.equal(run('prepare','--index','demo').ready,true);
    const result=run('search','new','--index','demo');assert.equal(result.complete,true);assert.deepEqual(result.paths,[added]);assert.equal(result.coverage.indexed,2);
    const all=run('search','','--index','demo','-n','1');assert.equal(all.coverage.matched,2);assert.equal(all.nextOffset,1);
    const cache=new Database(path.join(dir,'cache/search-demo.sqlite'));
    cache.exec('CREATE TABLE name_writes(action TEXT); CREATE TRIGGER audit_name_insert AFTER INSERT ON files BEGIN INSERT INTO name_writes VALUES (\'insert\'); END; CREATE TRIGGER audit_name_delete AFTER DELETE ON files BEGIN INSERT INTO name_writes VALUES (\'delete\'); END;');cache.close();
    writeFileSync(added,'changed file properties only');
    const journal=new Database(path.join(dir,'cache/live.sqlite'));journal.exec('UPDATE scopes SET revision=2; UPDATE changes SET revision=2;');journal.close();
    const changed=run('search','new size:>10','--index','demo');assert.deepEqual(changed.paths,[added]);assert.equal(changed.coverage.indexed,2);
    const inspected=new Database(path.join(dir,'cache/search-demo.sqlite'),{readonly:true});
    try{assert.equal(inspected.query('SELECT count(*) AS n FROM name_writes').get().n,0,'property-only events must not rewrite filename/FTS rows');}finally{inspected.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('global property filtering happens before page limits and unchanged properties are not written again',()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-properties-'))),root=path.join(dir,'files');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try{
    for(let i=0;i<30;i++)writeFileSync(path.join(root,`a-${String(i).padStart(3,'0')}.txt`),'x');
    const large=path.join(root,'zzz-largest.txt');writeFileSync(large,'x'.repeat(10000));
    run('index',root,'--name','demo');
    const unknown=run('search','size:>100','--index','demo','-n','1');assert.equal(unknown.complete,false);assert.equal(unknown.coverage.metadataUnknown,31);assert.deepEqual(unknown.paths,[]);
    const properties=run('properties','--index','demo','--max-files','100');assert.equal(properties.inspected,31);assert.equal(properties.pending,0);
    assert.deepEqual(run('search','size:>100 sort:big','--index','demo','-n','1').paths,[large]);
    const sorted=run('search','sort:big','--index','demo','-n','1');assert.equal(sorted.complete,true);assert.deepEqual(sorted.paths,[large]);
    const db=path.join(dir,'cache/search-demo.sqlite'),before=statSync(db).mtimeMs;
    assert.equal(run('properties','--index','demo','--max-files','100').inspected,0);assert.equal(statSync(db).mtimeMs,before);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('preparation resumes its byte checkpoint and changing the path snapshot invalidates the accelerator',()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-resume-'))),root=path.join(dir,'files');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try{
    run('index',root,'--name','demo');const file=path.join(dir,'cache/index-demo.txt');
    const paths=Array.from({length:2200},(_,i)=>path.join(root,`ä-${i}.txt`));writeFileSync(file,paths.join('\n')+'\n');
    const partial=run('prepare','--index','demo','--rows','1024');assert.equal(partial.ready,false);assert.equal(partial.rows,1024);
    const ready=run('prepare','--index','demo');assert.equal(ready.ready,true);assert.equal(ready.rows,2200);
    assert.equal(run('search','ä-','--index','demo').coverage.matched,2200);
    writeFileSync(file,path.join(root,'replacement.txt')+'\n');
    assert.equal(run('search','ä-','--index','demo').paths.length,0);
    run('prepare','--index','demo');assert.deepEqual(run('search','replacement','--index','demo').paths,[path.join(root,'replacement.txt')]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a damaged derived cache falls back and can be regenerated without changing its path snapshot',()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-cache-recovery-'))),root=path.join(dir,'files');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try {
    const wanted=path.join(root,'wanted.txt');writeFileSync(wanted,'fixture');run('index',root,'--name','demo');
    const source=path.join(dir,'cache/index-demo.txt'),before=statSync(source).mtimeMs,cache=path.join(dir,'cache/search-demo.sqlite');
    writeFileSync(cache,'interrupted derived file');writeFileSync(cache+'.building','interrupted schema');
    assert.deepEqual(run('search','wanted','--index','demo').paths,[wanted]);
    assert.equal(run('prepare','--index','demo').ready,true);assert.equal(statSync(source).mtimeMs,before);
    assert.deepEqual(run('search','wanted','--index','demo').paths,[wanted]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
