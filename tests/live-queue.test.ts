import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {socketRequest} from '../src/socket';

test('duplicate-heavy replay keeps all scopes without exhausting the distinct-path budget',{timeout:30000},async()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-queue-'))),root=path.join(dir,'files'),cache=path.join(dir,'cache'),helper=path.join(dir,'events');fs.mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:cache,FE_CONFIG_DIR:path.join(dir,'config'),FE_EVENTS_HELPER:helper};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const added=path.join(root,'receipt.txt'),last=path.join(root,'last.txt');let service:ReturnType<typeof spawn>|undefined;
  try{
    for(const name of ['one','two']){execFileSync(exe,[...prefix,'index',root,'--name',name,'--exhaustive'],{env,timeout:10000});execFileSync(exe,[...prefix,'prepare','--index',name],{env,timeout:10000});}
    fs.writeFileSync(added,'fixture');fs.writeFileSync(last,'fixture');
    fs.writeFileSync(helper,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;for(const r of JSON.parse(s).roots){console.log(JSON.stringify({root:r.path,ready:true}));console.log(JSON.stringify({root:r.path,uuid:'fixture',cursor:'1',events:[{path:${JSON.stringify(added)},flags:256}]}));for(let i=0;i<512;i++)console.log(JSON.stringify({root:r.path,uuid:'fixture',cursor:String(i+2),events:Array.from({length:128},()=>({path:${JSON.stringify(added)},flags:256,scopes:['one']}))}));console.log(JSON.stringify({root:r.path,uuid:'fixture',cursor:'515',events:[{path:${JSON.stringify(last)},flags:256}]}));}setInterval(()=>{},1000);\n`,{mode:0o700});
    const socket=path.join(dir,'service.sock');service=spawn(exe,[...prefix,'serve','--socket',socket,'--live'],{env,stdio:['ignore','ignore','pipe']});let log='';service.stderr!.on('data',d=>log+=d);
    const deadline=Date.now()+15000;let ready=false;
    while(Date.now()<deadline){
      if(fs.existsSync(path.join(cache,'live.sqlite'))){const db=new Database(path.join(cache,'live.sqlite'),{readonly:true});try{const row=db.query("SELECT count(*) AS n FROM changes WHERE path=? AND present=1").get(last) as {n:number};ready=row.n===2;}finally{db.close();}}
      if(ready&&fs.existsSync(socket+'.json'))break;await new Promise(r=>setTimeout(r,100));
    }
    assert(ready,'Both scopes must receive the final event: '+log.slice(-500));
    for(const name of ['one','two']){const result=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:'receipt view:all',index:name}));assert(result.paths.includes(added),'An unscoped event must remain visible in '+name);assert.equal(result.live.problem,null,'Duplicate events must not trigger a backlog gap');}
  }finally{if(service&&service.exitCode===null&&service.signalCode===null){const done=new Promise<void>(r=>service!.once('exit',()=>r()));service.kill('SIGTERM');await done;}fs.rmSync(dir,{recursive:true,force:true});}
});
