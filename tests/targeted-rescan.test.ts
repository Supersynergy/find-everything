import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
test('durable targeted enumeration, unchanged directories, pagination, event fences and diagnostic receipt',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-directory-recovery-')));
  try{
    const result=spawnSync(process.execPath,[path.resolve('tests/fixtures/targeted-rescan/check.ts')],{encoding:'utf8',timeout:25000,
      env:{...process.env,HOME:root,FE_DATA_DIR:path.join(root,'index'),FE_CONFIG_DIR:path.join(root,'config')}});
    assert.equal(result.status,0,result.stderr+' '+result.stdout);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('offline CloudStorage directory events and automatic scan hints survive a watcher restart without media extraction',{timeout:25000},()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-cloud-events-')));
  try{
    const r=spawnSync(process.execPath,[path.resolve('tests/fixtures/targeted-rescan/cloud-events.ts')],{encoding:'utf8',timeout:20000,
      env:{...process.env,HOME:root,FE_DATA_DIR:path.join(root,'index'),FE_CONFIG_DIR:path.join(root,'config'),FE_EVENTS_HELPER:path.join(root,'events')}});
    assert.equal(r.status,0,r.stderr);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
