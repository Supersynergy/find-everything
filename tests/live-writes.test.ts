import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {Database} from 'bun:sqlite';

test('duplicate removals and internal metadata stay quiet while membership, user metadata and subtree removals advance', {timeout:30000}, async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-writes-')));
  const data=path.join(root,'cache'),helper=path.join(root,'events'),trigger=path.join(root,'packet');
  const cli=process.env.FE_TEST_CLI || process.execPath;
  const prefix=process.env.FE_TEST_CLI ? [] : [path.resolve('src/cli.ts')];
  const env={...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(root,'config'),FE_EVENTS_HELPER:helper};
  const internal=path.join(data,'counts-one.sqlite'),user=path.join(root,'counts-one.sqlite');
  const removed=path.join(root,'gone'),tree=path.join(root,'gone-folder'),ignore=path.join(root,'.gitignore');
  let service:ReturnType<typeof spawn>|undefined,db:Database|undefined;
  async function until(check:()=>boolean){
    const end=Date.now()+6000;
    while(!check()){assert(Date.now()<end,'event checkpoint timed out');await new Promise(r=>setTimeout(r,20));}
  }
  try {
    fs.writeFileSync(user,'user');
    for(const args of [['index',root,'--name','one','--exhaustive'],['prepare','--index','one']])
      execFileSync(cli,[...prefix,...args],{env,timeout:10000,stdio:'pipe'});
    fs.writeFileSync(internal,'cache');fs.writeFileSync(ignore,'');
    fs.writeFileSync(helper,`#!${process.execPath}
import fs from 'node:fs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const root=JSON.parse(input).roots[0].path,file=${JSON.stringify(trigger)};
let last=0;
setInterval(()=>{if(!fs.existsSync(file))return;const packet=JSON.parse(fs.readFileSync(file,'utf8'));
if(packet.cursor===last)return;last=packet.cursor;
console.log(JSON.stringify({...packet,root,uuid:'fixture',cursor:String(last)}));},10);
`,{mode:0o700});
    const sock=path.join(root,'s.sock');
    service=spawn(cli,[...prefix,'serve','--socket',sock,'--live','--live-index','one'],{env,stdio:'ignore'});
    await until(()=>fs.existsSync(sock+'.json'));
    db=new Database(path.join(data,'live.sqlite'),{readonly:true});db.exec('PRAGMA busy_timeout=1000');
    let cursor=0;
    const send=async(events:{path:string;flags:number}[])=>{
      cursor++;
      fs.writeFileSync(trigger+'.tmp',JSON.stringify({cursor,events:[...events,{path:root,flags:16}]}));
      fs.renameSync(trigger+'.tmp',trigger);
      await until(()=>db!.query('SELECT cursor FROM streams WHERE root=?').get(root)?.cursor===String(cursor));
      return db!.query("SELECT revision FROM scopes WHERE name='one'").get().revision as number;
    };
    const revision=await send([removed,tree,internal,ignore].map((p,i)=>({path:p,flags:[512,512|131072,256,256][i]})));
    const row=(p:string)=>db!.query("SELECT present,tree FROM changes WHERE scope='one' AND path=?").get(p);
    assert.equal(row(ignore).present,1);assert.equal(row(internal).present,1);
    assert.deepEqual(row(tree),{present:0,tree:1});
    assert.equal(await send([{path:removed,flags:512},{path:internal,flags:4096}]),revision);
    fs.appendFileSync(user,' changed');
    assert.equal(await send([{path:user,flags:4096}]),revision+1);
    assert.equal(row(user).present,1);
    assert.equal(await send([{path:tree,flags:512|131072}]),revision+2);
    fs.writeFileSync(removed,'returned');fs.unlinkSync(internal);
    await send([{path:removed,flags:256},{path:internal,flags:512}]);
    assert.equal(row(removed).present,1);assert.equal(row(internal).present,0);
  } finally {
    db?.close();
    if(service&&service.exitCode===null&&service.signalCode===null){const done=once(service,'exit');service.kill();await done;}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
