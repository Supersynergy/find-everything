import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {Database} from 'bun:sqlite';

test('automatic merge resumes for prepared and streaming scopes while new filenames remain searchable',async()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-auto-merge-')));
  const root=path.join(dir,'files'),data=path.join(dir,'data'),journal=path.join(data,'live.sqlite');
  const helper=path.join(dir,'events'),packet=path.join(dir,'packet');
  const env={...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(dir,'config'),FE_EVENTS_HELPER:helper,FE_LIVE_MERGE_THRESHOLD:'2000'};
  const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[path.resolve('src/cli.ts'),...args,'--json'],{env,encoding:'utf8',timeout:10000}));
  let watcher:ReturnType<typeof spawn>|undefined,db:Database|undefined,stderr='';
  const start=()=>{
    const code=`const {startLive}=await import(${JSON.stringify(path.resolve('src/live.ts'))});const stop=await startLive(undefined,5,()=>false);for await(const _ of process.stdin){}stop();`;
    watcher=spawn(process.execPath,['--eval',code],{env,stdio:['pipe','ignore','pipe']});watcher.stderr!.on('data',s=>stderr+=s);
  };
  const stop=async()=>{if(watcher){const exit=once(watcher,'exit');watcher.stdin!.end();await exit;watcher=undefined;}};
  const until=async(condition:()=>boolean)=>{const end=Date.now()+8000;while(!condition()){assert(Date.now()<end,stderr);await Bun.sleep(10);}};
  try{
    fs.mkdirSync(root);
    const folder=path.join(root,'sub'),old=path.join(folder,'obsolete.txt'),late=path.join(root,'during-merge.txt'),special=path.join(root,'special\nname.txt');
    fs.mkdirSync(folder);fs.writeFileSync(old,'old');
    const scopes=['prepared','streaming'];
    for(const scope of scopes)run('index',root,'--name',scope,'--exhaustive');
    fs.unlinkSync(path.join(data,'search-streaming.sqlite'));fs.rmSync(folder,{recursive:true});fs.writeFileSync(special,'special');
    db=new Database(journal,{create:true});db.exec('PRAGMA busy_timeout=1000;CREATE TABLE scopes(name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER,problem TEXT,pid INTEGER,lastChange TEXT);CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path));CREATE TABLE jobs(scope TEXT,path TEXT,failures INTEGER,retryAt REAL,PRIMARY KEY(scope,path));');
    const add=db.query('INSERT INTO changes VALUES (?,?,?,?,?)');
    db.transaction(()=>{
      for(const scope of scopes){
        const stat=fs.statSync(path.join(data,'index-'+scope+'.txt'));
        db!.query('INSERT INTO scopes VALUES(?,?,1,NULL,?,NULL)').run(scope,`${stat.mtimeMs}:${stat.size}`,process.pid);
        add.run(scope,folder,0,1,1);add.run(scope,special,1,0,1);
        for(let i=0;i<20000;i++)add.run(scope,path.join(root,'deleted-'+i),0,0,1);
      }
    })();
    // Legacy read-only client before the writer migrates the journal.
    assert.deepEqual(run('search','name:special view:all','--index','streaming').paths,[special]);
    fs.writeFileSync(helper,`#!${process.execPath}
import fs from 'node:fs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const root=JSON.parse(input).roots[0],file=${JSON.stringify(packet)};
let cursor=Number(root.cursor||0);console.log(JSON.stringify({root:root.path,ready:true}));
setInterval(()=>{if(!fs.existsSync(file))return;const p=JSON.parse(fs.readFileSync(file));
if(p.cursor<=cursor)return;cursor=p.cursor;console.log(JSON.stringify({...p,root:root.path,uuid:'test',cursor:String(cursor)}));},5);\n`,{mode:0o700});
    start();
    await until(()=>!!db!.query("SELECT 1 FROM sqlite_master WHERE name='merged_changes'").get()&&!!db!.query('SELECT 1 FROM merged_changes LIMIT 1').get());
    await stop();assert(db.query('SELECT count(*) AS n FROM merge_queue').get().n>0);
    start();
    fs.writeFileSync(late,'late');fs.writeFileSync(folder,'directory became file');
    const send=(cursor:number,events:{path:string;flags:number}[])=>{
      fs.writeFileSync(packet+'.tmp',JSON.stringify({cursor,events}));fs.renameSync(packet+'.tmp',packet);
    };
    send(1,[{path:late,flags:256},{path:folder,flags:256}]);
    await until(()=>db!.query('SELECT cursor FROM streams WHERE root=?').get(root)?.cursor==='1');
    assert(db.query('SELECT count(*) AS n FROM merge_queue').get().n>0,'create committed while merge still active');
    for(const scope of scopes){
      const result=run('search','name:during-merge view:all','--index',scope);
      assert.equal(result.engine,scope==='prepared'?'sqlite-trigram':'complete-stream');
      assert.deepEqual(result.paths,[late]);
      assert.deepEqual(run('search','name:obsolete view:all','--index',scope).paths,[]);
    }
    await until(()=>!db!.query('SELECT 1 FROM merge_queue LIMIT 1').get());
    for(const scope of scopes)assert(db.query('SELECT count(*) AS n FROM merged_changes WHERE scope=?').get(scope).n>=20000);
    // A repair in a separate connection can enqueue an already-obsolete watermark
    // while the watcher has no events. Draining it must roll forward atomically.
    db.transaction(()=>{
      const add=db!.query("INSERT INTO changes VALUES('streaming',?,0,0,3)");
      for(let i=0;i<2001;i++)add.run(path.join(root,'external-'+i));
      db!.exec("UPDATE scopes SET revision=3 WHERE name='streaming';INSERT INTO merge_queue VALUES ('streaming',2)");
    })();
    await until(()=>!db!.query("SELECT 1 FROM merge_queue WHERE scope='streaming'").get());
    assert.equal(db.query("SELECT count(*) AS n FROM merged_changes WHERE scope='streaming' AND revision=3").get().n,2001);
    assert.equal(run('compact','--index','prepared','--rows','1').resumable,true);
    fs.unlinkSync(special);send(2,[{path:special,flags:512}]);
    await until(()=>db!.query('SELECT cursor FROM streams WHERE root=?').get(root)?.cursor==='2');
    run('compact','--index','prepared');await stop();
    for(const scope of scopes)assert.deepEqual(run('search','name:special view:all','--index',scope).paths,[]);
    fs.unlinkSync(path.join(data,'search-prepared.sqlite'));
    assert.deepEqual(run('search','name:during-merge view:all','--index','prepared').paths,[late]);
    assert.equal(db.query("SELECT count(*) AS n FROM merged_changes WHERE scope='prepared' AND revision<=2").get().n,0);
    // Fresh snapshot drops the checkpoint and durable rows for its own scope.
    fs.unlinkSync(packet);fs.appendFileSync(path.join(data,'index-streaming.txt'),'/after-reset\n');start();
    await until(()=>!db!.query("SELECT 1 FROM merged_changes WHERE scope='streaming' LIMIT 1").get());
    assert.deepEqual(run('search','name:after-reset view:all','--index','streaming').paths,['/after-reset']);
  }finally{await stop();db?.close();fs.rmSync(dir,{recursive:true,force:true});}
},30000);

test('streaming overlay retries a publication between filesystem and SQLite generation reads',()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'fe-generation-'));
  try{
    const file=path.join(data,'index-demo.txt');
    fs.writeFileSync(file,'/old\n');
    const code=`
import fs from 'node:fs';
import {Database} from 'bun:sqlite';
import {openLive,deltaFor} from ${JSON.stringify(path.resolve('src/delta.ts'))};
const file=${JSON.stringify(file)},db=openLive(),stamp=()=>{const s=fs.statSync(file);return s.mtimeMs+':'+s.size;};
db.query("INSERT INTO scopes(name,stamp,revision) VALUES ('demo',?,1)").run(stamp());
const query=Database.prototype.query;let published=false;
Database.prototype.query=function(sql){
  if(!published && sql.includes('SELECT stamp,revision FROM scopes WHERE name=?')){
    published=true;fs.writeFileSync(file,'/new-generation\\n');
    db.transaction(()=>{db.query("UPDATE scopes SET stamp=?,revision=2").run(stamp());db.query("INSERT INTO changes VALUES ('demo','/late',1,0,2)").run();})();
  }
  return query.call(this,sql);
};
const result=deltaFor('demo');db.close();console.log(JSON.stringify({published,revision:result.revision,paths:result.additions}));`;
    assert.deepEqual(JSON.parse(execFileSync(process.execPath,['--eval',code],{env:{...process.env,FE_DATA_DIR:data},encoding:'utf8'})),{published:true,revision:2,paths:['/late']});
  }finally{fs.rmSync(data,{recursive:true,force:true});}
});
