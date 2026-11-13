import {test} from 'bun:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
test('metadata explanation skips the property scan and preserves exact status',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fe-status-')),env={...process.env,FE_DATA_DIR:path.join(root,'data'),FE_CONFIG_DIR:path.join(root,'config')};fs.mkdirSync(path.join(root,'files'));fs.writeFileSync(path.join(root,'files/a.txt'),'x');
 const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[path.resolve('src/cli.ts'),...args,'--json'],{env,encoding:'utf8'}));
 try{run('index',path.join(root,'files'),'--name','demo');run('prepare','--index','demo');run('properties','--index','demo');
 const r=JSON.parse(execFileSync(process.execPath,['--eval',`import{Database}from'bun:sqlite';let scans=0;const q=Database.prototype.query;Database.prototype.query=function(s){if(s.includes('count(*) AS n FROM files WHERE size'))scans++;return q.call(this,s);};const{searchIndexStatus}=await import(${JSON.stringify(path.resolve('src/path-search.ts'))});const fast=searchIndexStatus('demo',false),before=scans,exact=searchIndexStatus('demo');console.log(JSON.stringify({fast,before,exact,scans}));`],{env,encoding:'utf8'}));
 assert.equal(r.before,0);assert.equal(r.fast.propertiesKnown,null);assert.equal(r.fast.propertiesCountExact,false);assert.equal(r.exact.propertiesKnown,1);assert.equal(r.scans,1);assert.equal(r.fast.rows,r.exact.rows);
 assert.equal(run('explain','view:all','--index','demo').lookup.propertiesKnown,null);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
