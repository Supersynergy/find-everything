import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {socketRequest} from '../src/socket';

type Mode='other-scope'|'properties';
type Reply={paths:string[];coverage:{matched:number};nextOffset:number|null;engine:string;cacheHit:boolean;complete:boolean};
type Trace={mode:Mode;steps:number;timesMs:number[];hits:number;p50Ms:number;p95Ms:number};
type HF1={command:string;mean:number;stddev:number;times:number[];exit_codes:number[]};
type HF2={name:string;summary:{time_wall_clock:{mean:number;stddev:number}};measurements:{time_wall_clock:{value:number};exit_code:number}[]};
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const quantile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
const envFor=(data:string)=>({...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:data+'-config'});
const route='/v1/search?'+new URLSearchParams({q:'ne sort:name',index:'bench',limit:'300'});
const expected=Array.from({length:300},(_,i)=>'/Fixture/one-'+String(i).padStart(7,'0')+'.txt');

async function trace(cli:string,data:string,mode:Mode):Promise<Trace>{
  const socketDir=fs.mkdtempSync(path.join(os.tmpdir(),'fe-cb-')),socket=path.join(socketDir,'api.sock');
  const child=spawn(cli,['serve','--socket',socket],{env:envFor(data),stdio:['ignore','ignore','pipe']});
  let error='';child.stderr!.on('data',b=>{error=(error+b).slice(-2000);});
  const deadline=Date.now()+5000;
  let journal:Database|undefined,properties:Database|undefined;
  try{
    while(!fs.existsSync(socket+'.json')){if(child.exitCode!==null||Date.now()>deadline)throw new Error('Private service startup: '+error);await new Promise(r=>setTimeout(r,10));}
    const search=async()=>{
      const reply=await socketRequest(socket,route) as Reply;
      assert.equal(reply.engine,'sqlite-trigram');assert.equal(reply.complete,true);
      assert.equal(reply.coverage.matched,500000);assert.equal(reply.nextOffset,300);assert.deepEqual(reply.paths,expected);
      return reply;
    };
    await search();
    if(mode==='other-scope')journal=new Database(path.join(data,'live.sqlite'));
    else properties=new Database(path.join(data,'search-bench.sqlite'));
    const timesMs:number[]=[];let hits=0;
    for(let i=0;i<8;i++){
      if(journal)journal.exec("UPDATE scopes SET revision=revision+1 WHERE name='other'");
      if(properties)properties.transaction(()=>{
        properties!.query("UPDATE files SET size=? WHERE id=1").run(i+100);
        properties!.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='propertiesRevision'");
      })();
      const started=performance.now(),reply=await search();timesMs.push(performance.now()-started);hits+=Number(reply.cacheHit);
    }
    return {mode,steps:8,timesMs,hits,p50Ms:quantile(timesMs,.5),p95Ms:quantile(timesMs,.95)};
  }finally{
    journal?.close();properties?.close();
    if(child.exitCode===null){const exited=once(child,'exit',{signal:AbortSignal.timeout(3000)});child.kill('SIGTERM');await exited;}
    fs.rmSync(socketDir,{recursive:true,force:true});
  }
}
const args=process.argv.slice(2);
if(args[0]==='--trace'){
  const [,cli,data,mode]=args;
  assert(mode==='other-scope'||mode==='properties');
  const result=await trace(cli,data,mode);
  fs.appendFileSync(path.join(path.dirname(data),path.basename(data)+'-'+mode+'-traces.jsonl'),JSON.stringify(result)+'\n');
  console.log(JSON.stringify(result));
}else{
  const [baselineArg,candidateArg,outputArg]=args;
  if(!baselineArg||!candidateArg||!outputArg)throw new Error('Usage: bun scripts/bench-cache.ts BASELINE_CLI CANDIDATE_CLI OUTPUT_DIRECTORY');
  const baseline=path.resolve(baselineArg),candidate=path.resolve(candidateArg),output=path.resolve(outputArg);
  fs.mkdirSync(output,{recursive:true});const empty=path.join(output,'empty');fs.mkdirSync(empty,{recursive:true});
  const paths=Array.from({length:500000},(_,i)=>'/Fixture/one-'+String(i).padStart(7,'0')+'.txt').join('\n')+'\n';
  for(const [name,cli] of [['baseline',baseline],['candidate',candidate]] as const){
    const data=path.join(output,name),env=envFor(data);
    const run=(...argv:string[])=>execFileSync(cli,[...argv,'--json'],{env,encoding:'utf8',timeout:120000,maxBuffer:1024**2});
    if(!fs.existsSync(path.join(data,'search-bench.sqlite'))){
      run('index',empty,'--name','bench');fs.writeFileSync(path.join(data,'index-bench.txt'),paths);run('prepare','--index','bench');
      run('index',empty,'--name','other');
      const db=new Database(path.join(data,'live.sqlite'),{create:true});
      db.exec('CREATE TABLE scopes(name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER,problem TEXT,pid INTEGER,lastChange TEXT);CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER);CREATE TABLE jobs(scope TEXT,path TEXT);');
      for(const scope of ['bench','other']){
        const s=fs.statSync(path.join(data,'index-'+scope+'.txt'));
        db.query('INSERT INTO scopes VALUES(?,?,0,NULL,?,NULL)').run(scope,String(s.mtimeMs)+':'+s.size,process.pid);
      }db.close();
    }
  }
  const normalize=(r:HF1|HF2):HF1=>'measurements' in r?{command:r.name,mean:r.summary.time_wall_clock.mean,stddev:r.summary.time_wall_clock.stddev,times:r.measurements.map(x=>x.time_wall_clock.value),exit_codes:r.measurements.map(x=>x.exit_code)}:r;
  const measurements:Record<string,unknown>={};
  // Preserve earlier runs when reusing the frozen fixture for a changed binary.
  const stamp=Date.now();
  for(const file of ['summary.json','other-scope.json','properties.json',...['baseline','candidate'].flatMap(name=>['other-scope','properties'].map(mode=>name+'-'+mode+'-traces.jsonl'))]){
    const existing=path.join(output,file);if(fs.existsSync(existing))fs.renameSync(existing,existing+'.previous-'+stamp);
  }
  for(const mode of ['other-scope','properties'] as const){
    const command=(name:string,cli:string)=>[process.execPath,import.meta.path,'--trace',cli,path.join(output,name),mode].map(quote).join(' ');
    const file=path.join(output,mode+'.json');
    console.log(execFileSync('hyperfine',['--warmup','1','--runs','3','--shell','none','--export-json',file,
      '--command-name','baseline',command('baseline',baseline),'--command-name','candidate',command('candidate',candidate)],{encoding:'utf8',timeout:120000,maxBuffer:1024**2}));
    const raw=JSON.parse(fs.readFileSync(file,'utf8')) as {results:(HF1|HF2)[]};
    const [before,after]=raw.results.map(normalize);
    assert([...before.exit_codes,...after.exit_codes].every(x=>x===0));
    measurements[mode]={baselineMs:before.mean*1000,candidateMs:after.mean*1000,speedup:before.mean/after.mean,
      baselineStddevMs:before.stddev*1000,candidateStddevMs:after.stddev*1000};
  }
  const report={passed:true,rows:500000,requestsPerTrace:8,runs:3,warmup:1,fixtureSha256:sha(paths),
    baselineSha256:sha(fs.readFileSync(baseline)),candidateSha256:sha(fs.readFileSync(candidate)),measurements,
    limits:['Synthetic frozen path list; no filesystem scan during queries','Each command includes service startup and one cold warmup query','Per-request warm timings retained in trace JSONL','OS file cache uncontrolled; no native-UI or 68-million-row performance claim']};
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
