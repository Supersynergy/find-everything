import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,statSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Database} from 'bun:sqlite';

test('column filters apply globally, preserve quoted values and reverse stable pages without writes',()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-columns-'))),root=path.join(dir,'Project Sounds');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  try {
    const names=['alpha laser.wav','beta.wav','zero.txt','last.txt'];
    names.forEach((n,i)=>writeFileSync(path.join(root,n),'x'.repeat([12,24,0,100][i])));
    run('index',root,'--name','demo');run('prepare','--index','demo');run('properties','--index','demo','--max-files','100');
    const cache=path.join(dir,'cache/search-demo.sqlite'),stamp=statSync(cache).mtimeMs;
    assert.deepEqual(run('search','sort:name-desc','--index','demo','-n','2').paths,[path.join(root,'zero.txt'),path.join(root,'last.txt')]);
    assert.deepEqual(run('search','sort:path-desc','--index','demo','-n','2','--offset','2').paths,[path.join(root,'beta.wav'),path.join(root,'alpha laser.wav')]);
    assert.deepEqual(run('search','name:"alpha laser"','--index','demo').paths,[path.join(root,'alpha laser.wav')]);
    assert.deepEqual(run('search','name:"Project Sounds"','--index','demo').paths,[]);
    assert.deepEqual(run('search','name:'+JSON.stringify('alpha "laser" (dark)'),'--index','demo').paths,[]);
    assert.equal(run('search',`in:${JSON.stringify(root)} ext:wav;txt`,'--index','demo','-n','1').coverage.matched,4);
    assert.deepEqual(run('search','size:12..24 sort:small','--index','demo','-n','1').paths,[path.join(root,'alpha laser.wav')]);
    assert.deepEqual(run('search','size:=0','--index','demo').paths,[path.join(root,'zero.txt')]);
    assert.equal(statSync(cache).mtimeMs,stamp,'queries must not rewrite the index');
    const db=new Database(cache);db.exec("UPDATE files SET size=NULL,mtime=NULL WHERE name='zero.txt'");db.close();
    for(const sort of ['name','name-desc','path','path-desc','big','small','new','old']){
      const all=run('search','sort:'+sort,'--index','demo','-n','1000').paths;
      for(const offset of [1,3,4,6])for(const limit of [1,3]){
        assert.deepEqual(run('search','sort:'+sort,'--index','demo','--offset',String(offset),'-n',String(limit)).paths,all.slice(offset,offset+limit),`${sort}: offset=${offset} limit=${limit}`);
      }
    }
    rmSync(cache);
    assert.deepEqual(run('search','sort:name-desc','--index','demo','-n','2').paths,[path.join(root,'zero.txt'),path.join(root,'last.txt')]);
    assert.deepEqual(run('search','name:"alpha laser"','--index','demo').paths,[path.join(root,'alpha laser.wav')]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
