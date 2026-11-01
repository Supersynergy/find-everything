/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseQuery} from '../src/engine';
import {normalizeQuery} from '../src/smart-query';

const cli=path.resolve('src/cli.ts');

test('content: is a literal document predicate, not a fuzzy filename term',()=>{
  const pq=parseQuery('content:"quarterly revenue" ext:pdf');
  assert.equal((pq as typeof pq & {content?:string}).content,'quarterly revenue');
  assert.deepEqual(pq.fuzzy,[]);assert.equal(pq.constraints.length,1);
  assert.equal(normalizeQuery('content:"(keep these literal)"'),'content:"(keep these literal)"');
});

test('invalid and repeated content predicates fail explicitly',()=>{
  for(const query of ['content:','content:""','content:a content:b','content:"unterminated','content:"'+('x'.repeat(513))+'"'])assert.throws(()=>parseQuery(query),/content|quoted/i,query);
});

function fixture(run:(root:string,env:NodeJS.ProcessEnv,file:string)=>void) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-content-query-')));
  const cache=path.join(root,'cache');fs.mkdirSync(cache);
  const file=path.join(root,'innocent-name.txt');fs.writeFileSync(file,'Only document text contains the obsidian telescope.');
  fs.writeFileSync(path.join(cache,'index-documents.txt'),file+'\n');
  const env={...process.env,FE_DATA_DIR:cache,FE_CONFIG_DIR:path.join(root,'config'),FE_FAVORITES_FILE:path.join(root,'favorites.json'),FE_LEARNING_FILE:path.join(root,'learning.json')};
  try {run(root,env,file);} finally {fs.rmSync(root,{recursive:true,force:true});}
}

test('CLI explicitly prepares, searches and clears document contents',()=>fixture((root,env,file)=>{
  const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[cli,...args,'--json'],{env,encoding:'utf8',timeout:15000}));
  const before=run('search','content:telescope','--index','documents','--snapshot');
  assert.deepEqual(before.paths,[]);assert.equal(before.complete,false);
  const indexed=run('content','index','--index','documents','--max-files','10','--seconds','5');assert.equal(indexed.indexed,1);
  const found=run('search','content:"obsidian telescope" ext:txt','--index','documents','--snapshot');
  assert.deepEqual(found.paths,[file]);assert.equal(found.content,true);assert.equal(found.coverage.matched,1);
  assert.match(found.snippets[0].text,/obsidian telescope/);
  assert.equal(run('content','status','--index','documents').indexed,1);
  assert.equal(run('content','clear','--index','documents').cleared,true);
  assert.deepEqual(run('search','content:telescope','--index','documents','--snapshot').paths,[]);
}));

test('the shared app/API search route returns content hits without a query-time directory scan',()=>fixture((root,env,file)=>{
  const marker=path.join(root,'unexpected-scan'),fd=path.join(root,'fd');
  fs.writeFileSync(fd,`#!/bin/sh\nprintf scan > ${JSON.stringify(marker)}\nexit 42\n`,{mode:0o700});
  const code=`const c=await import('./src/content-search');const s=await import('./src/services');await c.indexContents('documents',10,5);const result=await s.searchFiles('content:telescope','documents',20,{},false,true);console.log(JSON.stringify(result));`;
  const result=JSON.parse(execFileSync(process.execPath,['-e',code],{env:{...env,FE_FD:fd},encoding:'utf8',timeout:15000}));
  assert.deepEqual(result.paths,[file]);assert.equal(fs.existsSync(marker),false);
}));
