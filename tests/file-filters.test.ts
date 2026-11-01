import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

test('favorites combine globally with other filters; working view is reversible and queries do not write',()=>{
  const dir=realpathSync(mkdtempSync(path.join(homedir(),'fe-favorites-test-'))),root=path.join(dir,'project');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config'),FE_FAVORITES_FILE:path.join(dir,'pins.json')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try {
    const names=['README.md','node_modules/pkg/a.js','.git/config','.secret','dist/a.wav','laser.wav'];
    const files=names.map(n=>path.join(root,n));for(const p of files){mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,'a'.repeat(50));}
    run('index',root,'--name','demo');
    writeFileSync(path.join(dir,'cache/index-demo.txt'),[...files,'/System/Library/fixture.dylib'].join('\n')+'\n');
    run('prepare','--index','demo');run('properties','--index','demo','--max-files','100');
    run('favorites','add',files[0],files[1],files[5]);
    assert.equal(run('search','favorites:true','--index','demo','-n','1').coverage.matched,3);
    assert.deepEqual(run('search','is:favorite ext:wav size:1..100','--index','demo').paths,[files[5]]);
    assert.deepEqual(new Set(run('search','favorites:true view:working','--index','demo').paths),new Set([files[0],files[5]]));
    assert.deepEqual(new Set(run('search','view:working','--index','demo').paths),new Set([files[0],files[3],files[5]]));
    assert.equal(run('search','omit:system;generated;hidden','--index','demo').coverage.matched,2);
    assert.equal(run('search','omit:system;generated view:all','--index','demo').coverage.matched,7);
    const favoritesStamp=statSync(env.FE_FAVORITES_FILE).mtimeMs,cache=path.join(dir,'cache/search-demo.sqlite'),cacheStamp=statSync(cache).mtimeMs;
    run('favorites','list');run('favorites','add',files[0]);run('search','favorites:true view:working','--index','demo');
    assert.equal(statSync(env.FE_FAVORITES_FILE).mtimeMs,favoritesStamp);assert.equal(statSync(cache).mtimeMs,cacheStamp);
    run('favorites','remove',files[5]);assert.deepEqual(run('search','favorites:true ext:wav','--index','demo').paths,[]);
  }finally {rmSync(dir,{recursive:true,force:true});}
});
