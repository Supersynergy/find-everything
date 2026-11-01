import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {socketRequest} from '../src/socket';
import {Database} from 'bun:sqlite';
test('a disappearing ignore-check parent does not abort valid events in the same batch',{timeout:10000},async()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-event-race-'))),root=path.join(dir,'files'),racing=path.join(root,'race');mkdirSync(racing,{recursive:true});
  const gone=path.join(racing,'gone.txt'),kept=path.join(root,'kept.txt');writeFileSync(gone,'race');
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>execFileSync(exe,[...prefix,...args],{env,encoding:'utf8',timeout:10000});
  let service:ReturnType<typeof spawn>|undefined;
  try{
    run('index',root,'--name','demo');writeFileSync(kept,'new');
    const fd=path.join(dir,'fd-wrapper'),helper=path.join(dir,'events');
    writeFileSync(fd,`#!${process.execPath}\nimport{renameSync,existsSync}from'node:fs';import{spawnSync}from'node:child_process';const a=process.argv.slice(2);if(a.includes('--max-depth')&&a.at(-1)===${JSON.stringify(racing)}&&existsSync(${JSON.stringify(racing)}))renameSync(${JSON.stringify(racing)},${JSON.stringify(path.join(dir,'removed'))});const r=spawnSync('/opt/homebrew/bin/fd',a,{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o700});
    writeFileSync(helper,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;const{roots}=JSON.parse(s);for(const r of roots){console.log(JSON.stringify({root:r.path,ready:true}));console.log(JSON.stringify({root:r.path,uuid:'fixture',cursor:'1',events:[{path:${JSON.stringify(gone)},flags:256},{path:${JSON.stringify(kept)},flags:256}]}));}setInterval(()=>{},1000);\n`,{mode:0o700});
    const socket=path.join(dir,'service.sock');let log='';
    service=spawn(exe,[...prefix,'serve','--socket',socket,'--live'],{env:{...env,FE_FD:fd,FE_EVENTS_HELPER:helper},stdio:['ignore','ignore','pipe']});service.stderr!.on('data',d=>log+=d);
    const deadline=Date.now()+6000;let found=false;
    while(Date.now()<deadline){
      if(existsSync(socket+'.json')){const result=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:'kept',index:'demo'}));if(result.paths.includes(kept)){found=true;break;}}
      await new Promise(r=>setTimeout(r,60));
    }
    assert(found,'Valid event was lost after disappearing directory: '+log.slice(-1200));
    const removed=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:'gone',index:'demo'}));assert.deepEqual(removed.paths,[]);
  }finally{if(service?.exitCode===null){const stopped=new Promise<void>(r=>service!.once('exit',()=>r()));service.kill('SIGTERM');await stopped;}rmSync(dir,{recursive:true,force:true});}
});
test('a second live service waits for the running owner, then takes the socket over',{timeout:30000},async()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-daemon-takeover-'))),root=path.join(dir,'files');mkdirSync(root,{recursive:true});writeFileSync(path.join(root,'kept.txt'),'x');
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config'),FE_EVENTS_HELPER:path.join(dir,'events')};
  writeFileSync(env.FE_EVENTS_HELPER,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;const{roots}=JSON.parse(s);for(const r of roots)console.log(JSON.stringify({root:r.path,ready:true}));setInterval(()=>{},1000);\n`,{mode:0o700});
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  execFileSync(exe,[...prefix,'index',root,'--name','demo'],{env,encoding:'utf8',timeout:15000});
  const socket=path.join(dir,'service.sock'),services:ReturnType<typeof spawn>[]=[];
  const start=()=>{const p=spawn(exe,[...prefix,'serve','--socket',socket,'--live'],{env,stdio:['ignore','ignore','pipe']});p.stderr!.on('data',()=>{});services.push(p);return p;};
  const servingPid=()=>{try{return (JSON.parse(readFileSync(socket+'.json','utf8')) as {pid:number}).pid;}catch{return 0;}};
  const waitFor=async(check:()=>boolean,ms:number)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(check())return true;await new Promise(r=>setTimeout(r,80));}return false;};
  try{
    const first=start();
    assert(await waitFor(()=>servingPid()===first.pid,8000),'first live service never owned the socket');
    const second=start();
    await new Promise(r=>setTimeout(r,2000));
    assert.equal(second.exitCode,null,'the waiting service must not exit while another owner serves');
    assert.equal(servingPid(),first.pid);
    const stopped=new Promise<void>(r=>first.once('exit',()=>r()));first.kill('SIGTERM');await stopped;
    assert(await waitFor(()=>servingPid()===second.pid,15000),'waiting service did not take the socket over');
    const hit=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:'kept',index:'demo'}));
    assert(hit.paths.includes(path.join(root,'kept.txt')));
  }finally{
    for(const p of services){if(p.exitCode===null&&p.signalCode===null){const stopped=new Promise<void>(r=>p.once('exit',()=>r()));p.kill('SIGTERM');await stopped;}}
    rmSync(dir,{recursive:true,force:true});
  }
});
test('restarting the live service clears only the stale "Event stream stopped" marker',{timeout:30000},async()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-daemon-restart-'))),root=path.join(dir,'files');mkdirSync(root,{recursive:true});writeFileSync(path.join(root,'a.txt'),'x');
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config'),FE_EVENTS_HELPER:path.join(dir,'events')};
  writeFileSync(env.FE_EVENTS_HELPER,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;const{roots}=JSON.parse(s);for(const r of roots)console.log(JSON.stringify({root:r.path,ready:true}));setInterval(()=>{},1000);\n`,{mode:0o700});
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  execFileSync(exe,[...prefix,'index',root,'--name','demo'],{env,encoding:'utf8',timeout:15000});
  const socket=path.join(dir,'service.sock');
  const spawnService=()=>{const p=spawn(exe,[...prefix,'serve','--socket',socket,'--live'],{env,stdio:['ignore','ignore','pipe']});p.stderr!.on('data',()=>{});return p;};
  const problem=()=>{const db=new Database(path.join(env.FE_DATA_DIR,'live.sqlite'),{readonly:true});try{return (db.query("SELECT coalesce(problem,'') AS p FROM scopes WHERE name='demo'").get() as {p:string}).p;}finally{db.close();}};
  const waitFor=async(check:()=>boolean,ms:number)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(check())return true;await new Promise(r=>setTimeout(r,80));}return false;};
  let service:ReturnType<typeof spawn>|undefined;
  try{
    service=spawnService();
    assert(await waitFor(()=>existsSync(socket+'.json'),8000),'service never listened');
    execFileSync('pkill',['-f',env.FE_EVENTS_HELPER],{timeout:10000});
    assert(await waitFor(()=>problem().startsWith('Event stream stopped'),8000),'a lost event stream must leave a marker');
    const stopped=new Promise<void>(r=>service!.once('exit',()=>r()));service.kill('SIGTERM');await stopped;
    service=spawnService();
    assert(await waitFor(()=>problem()==='',8000),'a ready event stream must clear the restart marker: '+problem());
  }finally{
    if(service&&service.exitCode===null&&service.signalCode===null){const stopped=new Promise<void>(r=>service!.once('exit',()=>r()));service.kill('SIGTERM');await stopped;}
    rmSync(dir,{recursive:true,force:true});
  }
});

test('a coalesced directory event rescans that directory instead of marking the scope as drifted',{timeout:20000},async()=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-mustscan-'))),root=path.join(dir,'files');mkdirSync(root,{recursive:true});
  writeFileSync(path.join(root,'old.txt'),'x');
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config'),FE_EVENTS_HELPER:path.join(dir,'events')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  execFileSync(exe,[...prefix,'index',root,'--name','demo'],{env,encoding:'utf8',timeout:15000});
  const added=path.join(root,'coalesced.txt');writeFileSync(added,'new');
  // flags 1 = kFSEventStreamEventFlagMustScanSubDirs: macOS coalesced events for a directory.
  writeFileSync(env.FE_EVENTS_HELPER,`#!${process.execPath}\nlet s='';for await(const c of process.stdin)s+=c;const{roots}=JSON.parse(s);for(const r of roots){console.log(JSON.stringify({root:r.path,ready:true}));console.log(JSON.stringify({root:r.path,uuid:'fixture',cursor:'1',events:[{path:${JSON.stringify(root)},flags:1}]}));}setInterval(()=>{},1000);\n`,{mode:0o700});
  const socket=path.join(dir,'service.sock');let service:ReturnType<typeof spawn>|undefined,log='';
  try{
    service=spawn(exe,[...prefix,'serve','--socket',socket,'--live'],{env,stdio:['ignore','ignore','pipe']});service.stderr!.on('data',d=>log+=d);
    const deadline=Date.now()+10000;let found=false;
    while(Date.now()<deadline){
      if(existsSync(socket+'.json')){const result=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:'coalesced',index:'demo'}));if(result.paths.includes(added)){found=true;break;}}
      await new Promise(r=>setTimeout(r,60));
    }
    assert(found,'A coalesced directory event must rescan that directory: '+log.slice(-1200));
    const db=new Database(path.join(env.FE_DATA_DIR,'live.sqlite'),{readonly:true});
    try{const row=db.query('SELECT problem FROM scopes WHERE name=?').get('demo') as {problem:string|null}|null;
      assert.equal(row?.problem??null,null,'A rescan must not mark the scope as drifted');}finally{db.close();}
  }finally{if(service?.exitCode===null){const stopped=new Promise<void>(r=>service!.once('exit',()=>r()));service.kill('SIGTERM');await stopped;}rmSync(dir,{recursive:true,force:true});}
});
