import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('point visibility equals the streaming journal for media refresh, including ancestor replacement',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fe-point-visibility-'));
  try {
    fs.writeFileSync(path.join(dir,'index-demo.txt'),'');
    const result=execFileSync(process.execPath,['--eval',`
      import {openLive,baseStamp,deltaFor,visibleJournalPaths} from ${JSON.stringify(path.resolve('src/delta.ts'))};
      const db=openLive();
      db.query("INSERT INTO scopes(name,stamp,revision) VALUES('demo',?,5)").run(baseStamp('demo'));
      db.exec("INSERT INTO changes VALUES ('demo','/a/removed',0,0,3),('demo','/a/restored',1,0,5),('demo','/new/bar',1,0,5); INSERT INTO merged_changes VALUES ('demo','/a/old',1,0,2),('demo','/new',1,1,5); INSERT INTO tree_barriers VALUES ('demo','/a',4)");
      db.close();
      const paths=['/a','/a/old','/a/nested/base','/a/restored','/a/removed','/new/bar','/new/old','/untouched/','/'];
      const full=deltaFor('demo');console.log(JSON.stringify({full:paths.filter(p=>full.visible(p)),point:[...visibleJournalPaths('demo',paths)]}));
    `],{env:{...process.env,FE_DATA_DIR:dir},encoding:'utf8'});
    const {point,full}=JSON.parse(result);
    assert.deepEqual(point,full);
    assert.deepEqual(point,['/a','/a/restored','/new/bar','/untouched/','/']);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
