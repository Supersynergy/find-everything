import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('fold cursor skips newer rows without stranding an older watermark behind the cursor',()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'fe-fold-cursor-'));
  try {
    execFileSync(process.execPath,['--eval',`
      import assert from 'node:assert/strict';
      import {openLive,mergeLiveBatch,LIVE_MERGE_BATCH} from ${JSON.stringify(path.resolve('src/delta.ts'))};
      const db=openLive(), put=db.prepare("INSERT INTO changes VALUES ('x',?,1,0,?)");
      db.transaction(()=>{
        db.exec("INSERT INTO scopes(name,revision) VALUES('x',3); INSERT INTO merge_queue VALUES('x',1)");
        for(let i=0;i<LIVE_MERGE_BATCH;i++)put.run('/a'+i,2);
        put.run('/y',1);
      })();
      assert.equal(mergeLiveBatch(db,'x'),0);
      assert(db.query("SELECT 1 FROM merge_queue").get());
      put.run('/A',1);
      assert.equal(mergeLiveBatch(db,'x'),1);
      assert(db.query("SELECT 1 FROM merge_queue").get());
      assert.equal(mergeLiveBatch(db,'x'),1);
      assert.equal(mergeLiveBatch(db,'x'),0);
      assert(!db.query("SELECT 1 FROM merge_queue").get());
      assert.equal(db.query("SELECT count(*) AS n FROM changes").get().n,LIVE_MERGE_BATCH);
      assert.equal(db.query("SELECT count(*) AS n FROM merged_changes").get().n,2);
      db.close();
    `],{env:{...process.env,FE_DATA_DIR:data},timeout:10000});
  } finally {fs.rmSync(data,{recursive:true,force:true});}
});
