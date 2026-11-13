import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseQuery} from '../src/engine';
import {relevanceScore} from '../src/search-ranking';

test('indexed prefix previews preserve exact relevance pages and retain non-prefix full matches',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fe-prefix-page-')),root=path.join(dir,'files'),cache=path.join(dir,'cache');fs.mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:cache,FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try{
    run('index',root,'--name','demo');
    const files=[path.join(root,'ne.md'),path.join(root,'ne.app'),path.join(root,'ne'),...Array.from({length:1450},(_,i)=>path.join(root,`new-${String(i).padStart(5,'0')}.${i%3?'json':'md'}`)),path.join(root,'one.pdf'),path.join(root,'network','aaa.pdf'),path.join(root,'unrelated.txt')];
    fs.writeFileSync(path.join(cache,'index-demo.txt'),files.join('\n')+'\n');run('prepare','--index','demo');
    for(const query of ['ne view:smart omit:none','new view:smart omit:none','one view:smart omit:none','n|o view:smart omit:none','NE view:smart omit:none','ne view:all']){
      const parsed=parseQuery(query),needle=query.split(' ')[0],matching=files.filter(p=>needle.includes('|')?needle.split('|').some(t=>p.toLowerCase().includes(t)):/[A-Z]/.test(needle)?p.includes(needle):p.toLowerCase().includes(needle));
      const ranked=parsed.smart===true;const expected=[...matching].sort((a,b)=>(ranked?relevanceScore(a,parsed)-relevanceScore(b,parsed):0)||(path.basename(a).toLowerCase()<path.basename(b).toLowerCase()?-1:path.basename(a).toLowerCase()>path.basename(b).toLowerCase()?1:files.indexOf(a)-files.indexOf(b)));
      const call=`const{searchPrepared}=await import(${JSON.stringify(path.resolve('src/path-search.ts'))});const{parseQuery}=await import(${JSON.stringify(path.resolve('src/engine.ts'))});const p=parseQuery(${JSON.stringify(query)});console.log(JSON.stringify([searchPrepared('demo',p,1000,0,true),searchPrepared('demo',p,1000,0),searchPrepared('demo',p,1000,1000)]));`;
      const [preview,full,later]=JSON.parse(execFileSync(process.execPath,['--eval',call],{env,encoding:'utf8',timeout:30000}));
      assert.equal(preview.provisional,true);assert.equal(preview.coverage.matched,null);assert.equal(preview.complete,false);assert.deepEqual(preview.paths,expected.slice(0,preview.paths.length),query);
      assert.equal(full.coverage.matched,expected.length);assert.deepEqual(full.paths,expected.slice(0,1000),query);assert.deepEqual(later.paths,expected.slice(1000,2000),query);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
