import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {socketRequest} from '../src/socket';

// The caller supplies an already watched directory and owns the single probe file.
const [cli,data,socket,scope,directory,output]=process.argv.slice(2);
if(![cli,data,socket,scope,directory,output].every(Boolean)||!/^[-\w]+$/.test(scope))throw Error('Usage: bun scripts/trace-merge.ts CLI DATA SOCKET INDEX PROBE_DIR REPORT.json');
const db=new Database(path.join(data,'live.sqlite'),{readonly:true}),prepared=new Database(path.join(data,'search-'+scope+'.sqlite'),{readonly:true});
const file=path.join(directory,'fe-merge-probe-'+randomUUID()+'-ß.txt');
const state=()=>{const journal=db.query('SELECT revision FROM scopes WHERE name=?').get(scope)?.revision;
  let applied:number|string;
  try{applied=Number(prepared.query("SELECT value FROM meta WHERE key='liveRevision'").get()?.value);}catch(e){applied=String(e.code||e.message);}
  return {journal,applied,queued:db.query('SELECT watermark FROM merge_queue WHERE scope=?').get(scope)?.watermark??null};};
const waitFor=async(test:()=>boolean)=>{const deadline=performance.now()+90000;while(!test()){if(performance.now()>deadline)throw Error('Journal did not observe the probe within 90 seconds');await new Promise(r=>setTimeout(r,20));}};
const present=()=>db.query('SELECT present FROM (SELECT present,revision FROM changes WHERE scope=? AND path=? UNION ALL SELECT present,revision FROM merged_changes WHERE scope=? AND path=?) ORDER BY revision DESC LIMIT 1').get(scope,file,scope,file)?.present;
const ms=(t:number)=>Math.round(performance.now()-t);
const {version,apiRevision}=JSON.parse(fs.readFileSync(socket+'.json','utf8'));
const events:Record<string,unknown>[]=[];
const origin=performance.now(),at=()=>Math.round(performance.now()-origin);
const helper=path.join(path.dirname(fs.realpathSync(cli)),'fe-events');
const observer=spawn(helper,[],{stdio:['pipe','pipe','pipe']});
let observerReady=false,observerError='',phase:'create'|'delete'='create';
const direct:{phase:string,atMs:number,flags:number,cursor:string}[]=[];
const times:Record<string,number>={};
const lines=createInterface({input:observer.stdout});
observer.on('error',e=>observerError=e.message);
observer.stderr.on('data',d=>observerError=(observerError+d).slice(-300));
lines.on('line',line=>{
  try{
    const m=JSON.parse(line);
    if(m.ready)observerReady=true;
    for(const e of m.events??[])if(e.path===file&&(e.flags&(256|512|2048)))direct.push({phase,atMs:at(),flags:e.flags,cursor:m.cursor});
  }catch(e){observerError=String(e);}
});
observer.stdin.on('error',e=>observerError=e.message);
observer.stdin.end(JSON.stringify({roots:[{path:fs.realpathSync(directory),since:Date.now()/1000}]}));
let owned=false,passed=false;let failures=0;
const report=()=>fs.writeFileSync(output,JSON.stringify({version,apiRevision,scope,probe:file,host:os.hostname(),passed,events,observer:{helper,ready:observerReady,error:observerError,direct,times}},null,2)+'\n');
const action=async(name:string,operation:()=>unknown|Promise<unknown>)=>{
  const before=state(),started=performance.now();
  let result:unknown;try{result=await operation();}
  catch(error){events.push({name,before,after:state(),ms:ms(started),error:String(error)});report();throw error;}
  const event={name,before,after:state(),ms:ms(started),result};events.push(event);report();console.log(JSON.stringify(event));return result;
};
async function search(name:string,preview:boolean,want:boolean){
  return action(name,async()=>{
    const r=await socketRequest(socket,'/v1/search?'+new URLSearchParams({index:scope,q:'literal:'+JSON.stringify(path.basename(file))+' view:all',limit:'10',...(preview?{phase:'preview'}:{})}));
    assert.equal(r.paths.includes(file),want);
    return {engine:r.engine,complete:r.complete,matched:r.coverage?.matched,provisional:r.provisional??false,elapsedMs:r.elapsedMs,cacheHit:r.cacheHit};
  });
}
try{
  db.exec('PRAGMA busy_timeout=2000');prepared.exec('PRAGMA busy_timeout=2000');
  await waitFor(()=>{if(observerError||observer.exitCode!==null)throw Error('Direct FSEvent observer: '+observerError);return observerReady;});
  await action('queue',()=>JSON.parse(execFileSync(cli,['journal','merge','--index',scope],{encoding:'utf8',timeout:30000})));
  assert(state().queued!==null,'No real journal work for this scope');
  await action('create-journal',async()=>{times.create=at();fs.writeFileSync(file,'Find Everything live probe',{flag:'wx'});owned=true;await waitFor(()=>present()===1);times.createJournal=at();});
  await search('preview-create',true,true).catch(()=>failures++);
  await search('full-create',false,true).catch(()=>failures++);
  await action('delete-journal',async()=>{phase='delete';times.delete=at();fs.unlinkSync(file);owned=false;await waitFor(()=>present()===0);times.deleteJournal=at();});
  await search('preview-delete',true,false).catch(()=>failures++);
  await search('full-delete',false,false).catch(()=>failures++);
  await waitFor(()=>direct.some(e=>e.phase==='create')&&direct.some(e=>e.phase==='delete'));
  passed=!failures;if(!passed)process.exitCode=1;
}finally{
  if(owned)fs.unlinkSync(file);
  lines.close();
  if(observer.exitCode===null&&observer.signalCode===null){const done=once(observer,'close');observer.kill();await done;}
  report();prepared.close();db.close();
}
