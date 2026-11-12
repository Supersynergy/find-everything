import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {socketRequest} from '../src/socket';

for(const mode of ['disappearing directory','replaced directory','coalesced stale subtree'] as const)test(mode+' is reconciled without a false gap',{timeout:30000},async()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-dir-race-'))),root=path.join(dir,'files'),folder=path.join(root,'changing'),cache=path.join(dir,'cache');fs.mkdirSync(folder,{recursive:true});
  const old=path.join(folder,'old.txt'),kept=path.join(root,'kept.txt');fs.writeFileSync(old,'old');fs.writeFileSync(kept,'keep');
  const helper=path.join(dir,'events'),wrapper=path.join(dir,'fd'),env={...process.env,FE_DATA_DIR:cache,FE_CONFIG_DIR:path.join(dir,'config'),FE_EVENTS_HELPER:helper};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];let service:ReturnType<typeof spawn>|undefined;
  try{
    execFileSync(exe,[...prefix,'index',root,'--name','demo','--exhaustive'],{env,timeout:10000});execFileSync(exe,[...prefix,'prepare','--index','demo'],{env,timeout:10000});
    if(mode==='coalesced stale subtree'){fs.rmSync(old);fs.writeFileSync(path.join(folder,'new.txt'),'new');}
    fs.writeFileSync(wrapper,`#!${process.execPath}\nimport fs from 'node:fs';import{spawnSync}from'node:child_process';const args=process.argv.slice(2);if(args.at(-1)===${JSON.stringify(folder)}&&${JSON.stringify(mode)}!=='coalesced stale subtree'){fs.rmSync(${JSON.stringify(folder)},{recursive:true,force:true});if(${JSON.stringify(mode)}==='replaced directory')fs.writeFileSync(${JSON.stringify(folder)},'replacement');}const r=spawnSync('/opt/homebrew/bin/fd',args,{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o700});
    fs.writeFileSync(helper,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;for(const r of JSON.parse(s).roots){console.log(JSON.stringify({root:r.path,ready:true}));console.log(JSON.stringify({root:r.path,uuid:'fixture',cursor:'1',events:[{path:${JSON.stringify(folder)},flags:1}]}));}setInterval(()=>{},1000);\n`,{mode:0o700});
    const socket=path.join(dir,'service.sock');service=spawn(exe,[...prefix,'serve','--socket',socket,'--live'],{env:{...env,FE_FD:wrapper},stdio:['ignore','ignore','pipe']});let log='';service.stderr!.on('data',d=>log+=d);
    const deadline=Date.now()+15000;let ready=false;
    while(Date.now()<deadline){if(fs.existsSync(path.join(cache,'live.sqlite'))){const db=new Database(path.join(cache,'live.sqlite'),{readonly:true});try{ready=!!db.query("SELECT 1 FROM streams WHERE cursor='1'").get();}finally{db.close();}}if(ready&&fs.existsSync(socket+'.json'))break;await new Promise(r=>setTimeout(r,80));}
    assert(ready,'Directory event did not commit: '+log.slice(-500));
    const result=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:'view:all',index:'demo'}));assert.equal(result.live.problem,null);assert(!result.paths.some((p:string)=>p.replace(/\/$/,'')===old));assert(result.paths.includes(kept));
    if(mode==='coalesced stale subtree')assert(result.paths.includes(path.join(folder,'new.txt')));
    if(mode==='replaced directory')assert(result.paths.includes(folder));
    if(mode==='disappearing directory')assert(!result.paths.some((p:string)=>p.replace(/\/$/,'')===folder));
  }finally{if(service&&service.exitCode===null&&service.signalCode===null){const done=new Promise<void>(r=>service!.once('exit',()=>r()));service.kill('SIGTERM');await done;}fs.rmSync(dir,{recursive:true,force:true});}
});
