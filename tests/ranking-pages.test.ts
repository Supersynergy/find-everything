import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {relevanceScore} from '../src/search-ranking';
import {parseQuery} from '../src/engine';

test('empty relevance pages keep exact order across short, exhausted and revisited type buckets',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fe-rank-pages-')),root=path.join(dir,'files'),cache=path.join(dir,'cache');fs.mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:cache,FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try{
    run('index',root,'--name','demo');
    const extensions=['txt','app','unknown','ts','json','o'];
    const files=extensions.flatMap((ext,bucket)=>Array.from({length:[1009,3,7,1031,11,2][bucket]},(_,i)=>path.join(root,`${String(i).padStart(5,'0')}-${bucket}.${ext}`)));
    fs.writeFileSync(path.join(cache,'index-demo.txt'),files.join('\n')+'\n');run('prepare','--index','demo');
    const query='view:smart omit:none',parsed=parseQuery(query),expected=[...files].sort((a,b)=>relevanceScore(a,parsed)-relevanceScore(b,parsed)||(a<b?-1:a>b?1:0));
    const program=`import assert from 'node:assert/strict';const {searchPrepared}=await import(${JSON.stringify(path.resolve('src/path-search.ts'))});const {parseQuery}=await import(${JSON.stringify(path.resolve('src/engine.ts'))});const expected=${JSON.stringify(expected)},parsed=parseQuery(${JSON.stringify(query)});for(const offset of [1000,2000,1008,1009,1011,1012,1018,1019,2059,2062,2063,0,1500,1000])for(const limit of [1,11,1000]){const r=searchPrepared('demo',parsed,limit,offset);assert.equal(r.coverage.matched,expected.length);assert.deepEqual(r.paths,expected.slice(offset,offset+limit),'offset='+offset+' limit='+limit);assert.equal(r.complete,true);}`;
    execFileSync(process.execPath,['--eval',program],{env,encoding:'utf8',timeout:30000});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
