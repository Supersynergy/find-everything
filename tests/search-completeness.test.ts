import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Database} from 'bun:sqlite';

function fixture() {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-coverage-'))),root=path.join(dir,'files');
  fs.mkdirSync(root);
  const cache=path.join(dir,'cache'),env={...process.env,FE_DATA_DIR:cache,FE_CONFIG_DIR:path.join(dir,'config')};
  const executable=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(executable,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000,maxBuffer:8*1024**2}));
  const snapshot=(paths:string[])=>fs.writeFileSync(path.join(cache,'index-demo.txt'),paths.join('\n')+'\n');
  return {dir,root,cache,run,snapshot,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

test('exhaustive indexing includes generated, Library, local and ignored paths and preserves explicit exclusions',()=>{
  const f=fixture();
  try {
    const relative=['Library/receipt.pdf','.local/receipt.pdf','node_modules/receipt.pdf','build/receipt.pdf','ignored/receipt.pdf','normal/receipt.pdf','private/receipt.pdf'];
    for(const name of relative){const file=path.join(f.root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');}
    fs.writeFileSync(path.join(f.root,'.ignore'),'ignored/\n');
    f.run('index',f.root,'--name','demo','--exhaustive','--exclude','private');
    const result=f.run('search','receipt ext:pdf view:all','--index','demo');
    assert.deepEqual(new Set(result.paths),new Set(relative.filter(p=>!p.startsWith('private/')).map(p=>path.join(f.root,p))));
    const saved=f.run('indexes').find((item:any)=>item.name==='demo');
    assert.equal(saved.options.exhaustive,true);assert.equal(saved.options.includeIgnored,true);assert.equal(saved.options.includeHidden,true);
  }finally{f.close();}
});

test('composed and decomposed Unicode names match identically before and after preparation',()=>{
  const f=fixture();
  try {
    f.run('index',f.root,'--name','demo');
    const decomposed=path.join(f.root,'Cafe\u0301','Re\u0301sume\u0301.pdf'),composed=path.join(f.root,'Café','Résumé.txt'),pipe=path.join(f.root,'literal|pipe.txt');
    f.snapshot([decomposed,composed,pipe,path.join(f.root,'unrelated.txt')]);
    for(const prepared of [false,true]) {
      if(prepared)f.run('prepare','--index','demo');
      for(const query of ['résumé','re\u0301sume\u0301','name:résumé','"résumé"','café/'])assert.deepEqual(new Set(f.run('search',query,'--index','demo').paths),new Set([decomposed,composed]),query);
      assert.deepEqual(f.run('search','"literal|pipe"','--index','demo').paths,[pipe]);
      assert.deepEqual(f.run('search','!résumé ext:pdf','--index','demo').paths,[]);
    }
  }finally{f.close();}
});

test('absolute folder filters exclude prefix siblings in streaming and prepared search',()=>{
  const f=fixture();
  try {
    f.run('index',f.root,'--name','demo');
    const folder=path.join(f.root,'Invoices'),wanted=path.join(folder,'2026','receipt.pdf');
    f.snapshot([wanted,path.join(f.root,'Invoices-old','receipt.pdf'),path.join(f.root,'Invoices2','receipt.pdf')]);
    for(const prepared of [false,true]){
      if(prepared)f.run('prepare','--index','demo');
      for(const suffix of ['', '/'])assert.deepEqual(f.run('search',`in:${JSON.stringify(folder+suffix)} ext:pdf`,'--index','demo').paths,[wanted]);
    }
  }finally{f.close();}
});

test('prepared image type includes tif, tiff, jpg and jpeg without invented wildcard extensions',()=>{
  const f=fixture();
  try {
    f.run('index',f.root,'--name','demo');
    const wanted=['tif','tiff','jpg','jpeg'].map(ext=>path.join(f.root,'photo.'+ext));
    f.snapshot([...wanted,path.join(f.root,'photo.tif?')]);f.run('prepare','--index','demo');
    assert.deepEqual(new Set(f.run('search','type:image','--index','demo').paths),new Set(wanted));
  }finally{f.close();}
});

test('scanner diagnostics and skipped newline paths prevent a false complete answer',()=>{
  const f=fixture();
  try {
    const walker=path.join(f.dir,'scanner');
    fs.writeFileSync(walker,`#!/bin/sh\nprintf '%s\\0' '${f.root}/receipt.pdf' '${f.root}/bad\nname.pdf'\nprintf '%s\\n' 'fixture: Permission denied' >&2\n`,{mode:0o700});
    const executable=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
    execFileSync(executable,[...prefix,'index',f.root,'--name','demo'],{env:{...process.env,FE_FD:walker,FE_DATA_DIR:f.cache,FE_CONFIG_DIR:path.join(f.dir,'config')},timeout:10000});
    const result=f.run('search','receipt','--index','demo');
    assert.equal(result.paths.length,1);assert.equal(result.complete,false);
    assert(result.warnings.some((w:string)=>/scanner|permission/i.test(w)));
    assert(result.warnings.some((w:string)=>/skipped|line break/i.test(w)));
  }finally{f.close();}
});

test('live subtree deletion below a non-BMP folder removes every descendant',()=>{
  const f=fixture();
  try {
    f.run('index',f.root,'--name','demo');
    const folder=path.join(f.root,'📁-archive'),removed=path.join(folder,'nested','receipt.pdf'),kept=path.join(f.root,'kept.pdf');
    f.snapshot([removed,kept]);f.run('prepare','--index','demo');
    const base=fs.statSync(path.join(f.cache,'index-demo.txt'));
    const db=new Database(path.join(f.cache,'live.sqlite'));
    try{
      db.exec('CREATE TABLE scopes(name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER,pid INTEGER,problem TEXT,lastChange TEXT); CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER); CREATE TABLE jobs(scope TEXT,path TEXT);');
      db.query('INSERT INTO scopes VALUES (?,?,1,1073741824,NULL,NULL)').run('demo',`${base.mtimeMs}:${base.size}`);
      db.query('INSERT INTO changes VALUES (?,?,0,1,1)').run('demo',folder);
    }finally{db.close();}
    assert.deepEqual(f.run('search','ext:pdf','--index','demo').paths,[kept]);
  }finally{f.close();}
});

test('status counts both known properties on sparse and dense legacy indexes',()=>{
  const f=fixture();
  try {
    f.run('index',f.root,'--name','demo');
    f.snapshot(Array.from({length:128},(_,i)=>path.join(f.root,String(i))));
    f.run('prepare','--index','demo');
    const db=new Database(path.join(f.cache,'search-demo.sqlite'));
    const known=()=>f.run('status').indexes.find((i:any)=>i.name==='demo').search.propertiesKnown;
    try {
      db.exec("UPDATE meta SET value='2' WHERE key='version'; UPDATE files SET size=0 WHERE id<=3; UPDATE files SET mtime=0 WHERE id BETWEEN 2 AND 4");
      assert.equal(known(),2);
      db.exec('UPDATE files SET mtime=0');
      assert.equal(known(),3);
    }finally{db.close();}
  }finally{f.close();}
});

test('legacy accelerators remain usable and normalize Unicode without rebuilding or query writes',()=>{
  const f=fixture();
  try {
    f.run('index',f.root,'--name','demo');
    const wanted=path.join(f.root,'Cafe\u0301','Re\u0301sume\u0301.pdf');f.snapshot([wanted]);f.run('prepare','--index','demo');
    const file=path.join(f.cache,'search-demo.sqlite'),db=new Database(file);
    try {
      db.query("UPDATE meta SET value='2' WHERE key='version'").run();
      db.query('UPDATE files SET nameKey=?').run('Re\u0301sume\u0301.pdf'.toLowerCase());
      db.query('UPDATE directories SET pathKey=?').run(path.dirname(wanted).toLowerCase()+'/');
      db.exec("INSERT INTO names_fts(names_fts) VALUES('rebuild'); INSERT INTO directories_fts(directories_fts) VALUES('rebuild');");
    }finally{db.close();}
    const before=fs.statSync(file).mtimeMs;
    for(const query of ['résumé','name:résumé',`in:${JSON.stringify(path.join(f.root,'Café'))}`]) {
      const result=f.run('search',query,'--index','demo');assert.equal(result.engine,'sqlite-trigram');assert.deepEqual(result.paths,[wanted]);
    }
    assert.equal(fs.statSync(file).mtimeMs,before,'Queries must not rewrite a legacy accelerator');
    f.run('prepare','--index','demo');
    const upgraded=new Database(file,{readonly:true});try{assert.equal(upgraded.query("SELECT value FROM meta WHERE key='version'").get()?.value,'3');}finally{upgraded.close();}
  }finally{f.close();}
});

test('exhaustive rebuild settings persist for saved and built-in indexes',()=>{
  const f=fixture();
  try {
    fs.mkdirSync(path.join(f.root,'Library'));const wanted=path.join(f.root,'Library','receipt.pdf');fs.writeFileSync(wanted,'fixture');
    f.run('index',f.root,'--name','demo');f.run('index','--index','demo','--exhaustive');
    const result=f.run('search','receipt','--index','demo');assert.deepEqual(result.paths,[wanted]);assert.equal(result.complete,true);
    const scanner=path.join(f.dir,'fd');fs.writeFileSync(scanner,`#!/bin/sh\nprintf '%s\\0' '${wanted}'\n`,{mode:0o700});
    const executable=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
    execFileSync(executable,[...prefix,'index','--index','all','--exhaustive'],{env:{...process.env,FE_FD:scanner,FE_DATA_DIR:f.cache,FE_CONFIG_DIR:path.join(f.dir,'config')},timeout:10000});
    const all=f.run('indexes').find((item:any)=>item.name==='all');
    assert.equal(all.options.exhaustive,true);assert.equal(all.configurationChanged,false);assert(!all.exclusions.includes('Volumes'));
    assert.deepEqual(f.run('search','receipt','--index','all').paths,[wanted]);
  }finally{f.close();}
});

test('application directories remain discoverable before the lookup is prepared',()=>{
  const f=fixture();
  try {
    f.run('index',f.root,'--name','demo');const wanted=path.join(f.root,'Editor.app')+'/';
    f.snapshot([wanted,path.join(f.root,'Editor.txt')]);
    for(const prepared of [false,true]){
      if(prepared)f.run('prepare','--index','demo');
      for(const query of ['type:app','ext:app','*.app'])assert.deepEqual(f.run('search',query,'--index','demo').paths,[wanted]);
    }
  }finally{f.close();}
});
