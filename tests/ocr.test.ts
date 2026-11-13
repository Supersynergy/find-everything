import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
test('explicit Vision OCR indexes scanned PDF pages and images with provenance; budgets and stale files remain visible',()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-ocr-'))),root=path.join(dir,'files');fs.mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'data'),FE_CONFIG_DIR:path.join(dir,'config'),FE_CONTENT_HELPER:path.resolve('.acceptance/fe-content-probe')};
  const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[path.resolve('src/cli.ts'),...args,'--json'],{env,encoding:'utf8',timeout:40000}));
  try{
    execFileSync(path.resolve('.acceptance/ocr-fixtures'),[root],{timeout:10000});
    run('index',root,'--name','ocrdocs');run('content','index','--index','ocrdocs');
    assert.equal(run('search','content:Polarstern','--index','ocrdocs').paths.length,0);
    run('content','index','--index','ocrdocs','--ocr','--ocr-pages','2');
    const result=run('search','content:Polarstern','--index','ocrdocs');assert.equal(result.paths.length,2);assert.equal(result.complete,false);
    assert(result.extraction.every(p=>p.method==='vision-ocr'));
    assert.deepEqual(result.extraction.map(p=>p.pages.length).sort(),[1,2]);
    assert(result.extraction.every(p=>p.pages.every(v=>v.method==='ocr')));
    assert.deepEqual(run('search','content:"Zweiter Beleg"','--index','ocrdocs').paths,[path.join(root,'scan.pdf')]);
    fs.appendFileSync(path.join(root,'scan.png'),'changed');
    assert.deepEqual(run('search','content:Polarstern','--index','ocrdocs').paths,[path.join(root,'scan.pdf')]);
    run('content','clear','--index','ocrdocs');run('content','index','--index','ocrdocs','--ocr','--ocr-pages','1');
    const bounded=run('search','content:Polarstern','--index','ocrdocs');assert(!bounded.paths.includes(path.join(root,'scan.pdf')));assert(bounded.coverage.unknown>0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
},120000);
