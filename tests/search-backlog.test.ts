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
    const removedDir=path.join(root,'removed-tree');fs.mkdirSync(removedDir);
    const kept=path.join(root,'archive-rare-receipt.doc'),removed=path.join(removedDir,'old-rare-receipt.doc'),late=path.join(removedDir,'new-rare-receipt.doc');
    fs.writeFileSync(kept,'kept');fs.writeFileSync(removed,'old');
    const folder=path.join(root,'stable-folder');fs.mkdirSync(folder);
    const replacement=path.join(root,'café-replaced');fs.mkdirSync(replacement);
    execFileSync(process.execPath,[cli,'index',root,'--name','demo','--exhaustive'],{env,stdio:'pipe'});
    execFileSync(process.execPath,['--eval',`import {openLive} from ${JSON.stringify(path.resolve('src/delta.ts'))};openLive().close();`],{env});
    journal=new Database(path.join(data,'live.sqlite'));lookup=new Database(path.join(data,'search-demo.sqlite'),{readonly:true});
    const snapshot=fs.statSync(path.join(data,'index-demo.txt'));
    journal.query("INSERT INTO scopes(name,stamp,revision,pid) VALUES ('demo',?,2,?)").run(snapshot.mtimeMs+':'+snapshot.size,process.pid);
    const added=journal.query("INSERT INTO changes VALUES('demo',?,0,0,?)");
    journal.transaction(()=>{for(let i=0;i<510000;i++)added.run(path.join(root,'missing-'+String(i).padStart(6,'0')),1+Math.floor(i/256));})();
    const revision=2000;
    journal.query("INSERT INTO changes VALUES ('demo',?,1,0,?)").run(folder,revision);
    journal.query("INSERT INTO tree_barriers VALUES ('demo',?,?)").run(removedDir,1999);
    fs.unlinkSync(removed);fs.writeFileSync(late,'late');
    journal.query("INSERT INTO merged_changes VALUES ('demo',?,1,0,?)").run(late,revision);
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
    assert.equal(historical.engine,'sqlite-journal');
    assert(Number(get('liveRevision'))<revision,'selective final must not replay half a million unrelated paths');
    const overlooked=path.join(root,'outside-recent-window-ß.txt');
    fs.writeFileSync(overlooked,'present');
    journal.query("INSERT INTO changes VALUES ('demo',?,1,0,100)").run(overlooked);
    const recovered=await query('literal:outside-recent-window-ß.txt view:all');
    assert.deepEqual(recovered.paths,[]);assert(recovered.provisional);assert.equal(recovered.coverage.matched,null);
    assert.deepEqual((await query('literal:outside-recent-window-ß.txt view:all',false)).paths,[overlooked]);
    const sparse=await query('literal:no-such-preview-candidate view:all');assert.deepEqual(sparse.paths,[]);assert(sparse.provisional);
    fs.rmdirSync(replacement);fs.writeFileSync(replacement,'regular file');
    journal.transaction(()=>{journal!.query("INSERT INTO changes VALUES('demo',?,1,1,?)").run(replacement,revision+2);journal!.query("UPDATE scopes SET revision=?").run(revision+2);})();
    const replacementQuery='literal:'+JSON.stringify('café-replaced'.normalize('NFD'))+' view:all';
    const replacePreview=await query(replacementQuery);assert.deepEqual(replacePreview.paths,[replacement]);
    const replaceExact=await query(replacementQuery,false);assert.deepEqual(replaceExact.paths,[replacement]);assert.equal(replaceExact.properties[0].dir,0);assert.equal(replaceExact.properties[0].path,replacement);
    const pendingStart=performance.now();
    const folded=await query('literal:rare-receipt view:all',false);
    assert.equal(folded.engine,'sqlite-journal');assert.deepEqual(folded.paths,[kept,late]);assert.equal(folded.coverage.matched,2);
    assert.equal(folded.properties.find(r=>r.path===late).size,4);
    const pendingMs=Math.round(performance.now()-pendingStart);
    const exhaustive=await query('name:able-pro sort:path view:all',false);
    assert.deepEqual(exhaustive.paths,historical.paths);assert.deepEqual(exhaustive.properties,historical.properties);
    assert.equal(get('liveRevision'),String(revision+2));
    const preparedReplacement=await query(replacementQuery,false);
    assert.deepEqual(preparedReplacement.paths,replaceExact.paths);assert.deepEqual(preparedReplacement.properties,replaceExact.properties);
    assert.deepEqual((await query('literal:rare-receipt view:all',false)).paths,folded.paths);
    console.log('510000 pending rows, preview add/delete '+previewMs+' ms, exact journal query '+pendingMs+' ms, full catch-up and parity queries '+Math.round(performance.now()-t-previewMs-pendingMs)+' ms');
  }finally{
    if(server?.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill();await exited;}
    lookup?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});
  }
},30000);

test('bounded preview enumerates a rare addition beyond the recent window when the entire pending range fits',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fe-bounded-preview-')),root=path.join(dir,'files'),data=path.join(dir,'data');fs.mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(dir,'config')};
  try{
    execFileSync(process.execPath,[path.resolve('src/cli.ts'),'index',root,'--name','demo','--exhaustive'],{env,stdio:'pipe'});
    const script=`
      import {Database} from 'bun:sqlite';import {baseStamp,openLive} from './src/delta';
      import {exactPendingLiteral,pendingFilenamePage} from './src/path-search';import {parseQuery} from './src/engine';
      const d=openLive(),source=baseStamp('demo'),pending={source,applied:0,target:2},pq=parseQuery('literal:rare-preview.txt view:all');
      d.query("INSERT INTO scopes(name,stamp,revision) VALUES ('demo',?,2)").run(source);
      const add=d.query("INSERT INTO changes VALUES ('demo',?,?,0,?)");
      d.transaction(()=>{add.run('/rare-preview.txt',1,1);for(let i=0;i<6000;i++)add.run('/gone'+i,0,2);})();
      const initial=pendingFilenamePage('demo',pq,10,0,pending),bounded=exactPendingLiteral('demo',pq,10,pending,true);
      d.transaction(()=>{for(let i=6000;i<18000;i++)add.run('/gone'+i,0,2);})();
      let materialized=false;const orig=Database.prototype.query;Database.prototype.query=function(sql){if(sql.includes('revision>? AND present=1'))materialized=true;return orig.call(this,sql);};
      const limited=exactPendingLiteral('demo',parseQuery('literal:missing-preview view:all'),10,pending,true);
      d.close();console.log(JSON.stringify({initial:initial.paths,bounded:bounded.paths,truncated:limited===undefined,materialized}));`;
    assert.deepEqual(JSON.parse(execFileSync(process.execPath,['--eval',script],{env,encoding:'utf8'})),{initial:[],bounded:['/rare-preview.txt'],truncated:true,materialized:false});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
