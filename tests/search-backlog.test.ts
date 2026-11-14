import {test} from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Database} from 'bun:sqlite';
import {socketRequest} from '../src/socket';

test('first-page filename searches stay fresh and checkpoint a half-million row live backlog',async()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-search-backlog-'))),data=path.join(dir,'data'),root=path.join(dir,'files'),socket=path.join(dir,'api.sock');
  fs.mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(dir,'config')},cli=path.resolve('src/cli.ts'),file=path.join(root,'new-ß-filename.txt'),stable=path.join(root,'stable-proof.txt');
  let server:ReturnType<typeof spawn>|undefined,journal:Database|undefined,lookup:Database|undefined;
  const query=(q:string,preview=true)=>socketRequest(socket,'/v1/search?'+new URLSearchParams({q,index:'demo',limit:'10',...(preview?{phase:'preview'}:{})}));
  try{
    fs.writeFileSync(stable,'base');
    const folder=path.join(root,'stable-folder');fs.mkdirSync(folder);
    execFileSync(process.execPath,[cli,'index',root,'--name','demo','--exhaustive'],{env,stdio:'pipe'});
    execFileSync(process.execPath,['--eval',`import {openLive} from ${JSON.stringify(path.resolve('src/delta.ts'))};openLive().close();`],{env});
    journal=new Database(path.join(data,'live.sqlite'));lookup=new Database(path.join(data,'search-demo.sqlite'),{readonly:true});
    const snapshot=fs.statSync(path.join(data,'index-demo.txt'));
    journal.query("INSERT INTO scopes(name,stamp,revision,pid) VALUES ('demo',?,2,?)").run(snapshot.mtimeMs+':'+snapshot.size,process.pid);
    const added=journal.query("INSERT INTO changes VALUES('demo',?,0,0,?)");
    journal.transaction(()=>{for(let i=0;i<510000;i++)added.run(path.join(root,'missing-'+String(i).padStart(6,'0')),1+Math.floor(i/256));})();
    const revision=2000;
    journal.query("INSERT INTO changes VALUES ('demo',?,1,0,?)").run(folder,revision);
    fs.writeFileSync(file,'fresh');
    journal.transaction(()=>{journal!.query("INSERT INTO changes VALUES('demo',?,1,0,?)").run(file,revision);journal!.query("UPDATE scopes SET revision=?").run(revision);})();
    server=spawn(process.execPath,[cli,'serve','--socket',socket],{env,stdio:'ignore'});
    const end=Date.now()+5000;while(!fs.existsSync(socket+'.json')){assert(Date.now()<end);await Bun.sleep(10);}
    const term='literal:'+JSON.stringify(path.basename(file))+' view:all',get=(key:string)=>lookup!.query('SELECT value FROM meta WHERE key=?').get(key)?.value;
    const t=performance.now();
    const hit=await query(term);assert.deepEqual(hit.paths,[file]);assert.equal(hit.provisional,true);assert.equal(hit.complete,false);assert.equal(hit.coverage.matched,null);assert.equal(hit.nextOffset,null);
    const cursor=get('syncPartialPath');assert(cursor&&get('syncPartialRevision')==='1');assert.equal(get('liveRevision'),'0','partial revision must not publish its successor');
    assert.deepEqual((await query('name:stable-proof view:all')).paths,[stable]);
    fs.unlinkSync(file);journal.transaction(()=>{journal!.query('UPDATE changes SET present=0,revision=? WHERE path=?').run(revision+1,file);journal!.query('UPDATE scopes SET revision=?').run(revision+1);})();
    const gone=await query(term);assert.deepEqual(gone.paths,[]);assert.equal(gone.cacheHit,false);assert.notEqual(get('syncPartialPath'),cursor);
    assert.equal(get('liveRevision'),'0');assert(performance.now()-t<10000);
    const advanced=await query('name:missing- sort:name view:all');assert(advanced.provisional);assert.equal(get('liveRevision'),'1','finish all 256 paths before publishing revision 1');
    const previewMs=Math.round(performance.now()-t);
    assert.deepEqual((await query('name:stable-folder view:all')).paths,[folder+'/']);
    const historical=await query('name:able-pro view:all',false);
    assert.deepEqual(historical.paths,[stable]);assert.equal(historical.coverage.matched,1);assert.equal(historical.complete,true);assert(!historical.provisional);
    assert.equal(get('liveRevision'),String(revision+1));
    console.log('510000 pending rows, preview add/delete '+previewMs+' ms, full search '+Math.round(performance.now()-t-previewMs)+' ms');
  }finally{
    if(server?.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill();await exited;}
    lookup?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});
  }
},30000);
