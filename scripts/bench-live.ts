import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import os from 'node:os';
import {once} from 'node:events';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';

type Probe={case:string;ms:number;status:number|null;timeout:boolean;version?:string;returned?:number;matched?:number|null;complete?:boolean;engine?:string;signature?:string;warningCount?:number;error?:string};
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
async function probe(socket:string,token:string,label:string,route:string,timeoutMs:number):Promise<Probe>{
  const start=performance.now();
  return new Promise(resolve=>{
    let settled=false;
    const finish=(data:Omit<Probe,'case'|'ms'>)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      resolve({case:label,ms:performance.now()-start,...data});
    };
    const req=http.get({socketPath:socket,path:route,headers:{Host:'localhost',Authorization:'Bearer '+token}},res=>{
      let body='';
      res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;if(body.length>1024**2)req.destroy(new Error('Response budget exceeded'));});
      res.on('end',()=>{
        try{
          const data=JSON.parse(body) as {version?:string;paths?:string[];coverage?:{matched?:number|null};complete?:boolean;engine?:string;warnings?:string[]};
          finish({status:res.statusCode??null,timeout:false,version:data.version,returned:data.paths?.length,matched:data.coverage?.matched,complete:data.complete,engine:data.engine,
            signature:data.paths?sha(JSON.stringify(data.paths)):undefined,warningCount:data.warnings?.length});
        }catch{finish({status:res.statusCode??null,timeout:false,error:'Invalid JSON response'});}
      });
    });
    req.on('error',error=>finish({status:null,timeout:false,error:(error as NodeJS.ErrnoException).code??error.name}));
    const timer=setTimeout(()=>{finish({status:null,timeout:true});req.destroy();},timeoutMs);
  });
}
if(process.argv[2]==='--installed'){
  const output=path.resolve(process.argv[3]??'.measure/installed-baseline.json');
  const socket='/Users/master/.cache/hypersearch/run/search.sock',descriptor=socket+'.json';
  const stat=fs.lstatSync(descriptor);assert.equal(stat.uid,process.getuid!());assert.equal(stat.mode&0o077,0);
  const info=JSON.parse(fs.readFileSync(descriptor,'utf8')) as {pid:number;ownerPid:number;version:string;token:string};
  const ps=()=>execFileSync('ps',['-p',String(info.pid),'-o','pid=,ppid=,etime=,time=,pcpu=,rss='],{encoding:'utf8'}).trim();
  const before=ps(),client='measure-'+process.pid;let generation=0;
  const cases=[
    {id:'health',route:'/health',count:6,timeout:2000},
    {id:'updates',route:'/v1/updates?index=everything',count:3,timeout:2000},
    {id:'empty-name-page',query:'sort:name',count:3,timeout:2000},
    {id:'short-preview',query:'ne view:smart omit:none',count:3,timeout:3000}
  ];
  const rows:Probe[]=[];
  for(const c of cases){
    for(let i=0;i<c.count;i++){
      const route=c.route??'/v1/search?'+new URLSearchParams({q:c.query!,index:'everything',limit:'10',offset:'0',client,generation:String(++generation),priority:'foreground',...(c.id==='short-preview'?{phase:'preview'}:{})});
      rows.push(await probe(socket,info.token,c.id,route,c.timeout));
    }
    console.log(JSON.stringify({case:c.id,completed:c.count,timeouts:rows.filter(r=>r.case===c.id&&r.timeout).length}));
  }
  const summary=Object.fromEntries(cases.map(c=>{
    const group=rows.filter(r=>r.case===c.id),ok=group.filter(r=>r.status===200&&!r.timeout&&!r.error).map(r=>r.ms);
    return [c.id,{samples:group.length,successes:ok.length,timeouts:group.filter(r=>r.timeout).length,
      p50Ms:ok.length?percentile(ok,.5):null,p95Ms:ok.length?percentile(ok,.95):null,deadlineMs:c.timeout}];
  }));
  const report={date:new Date().toISOString(),installedVersion:info.version,pid:info.pid,ownerPid:info.ownerPid,before,after:ps(),summary,rows,
    limits:['Short live diagnostic; not a stable latency distribution','Concurrent user/agent activity uncontrolled','Timeouts are censored, not completed request durations','No file paths or service credentials stored']};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,summary}));
}else if(process.argv[2]==='--replay'){
  await replay(path.resolve(process.argv[3]),path.resolve(process.argv[4]),Number(process.argv[5]??6000));
}else throw new Error('Usage: bun scripts/bench-live.ts --installed [OUTPUT_JSON] | --replay CLI OUTPUT_DIRECTORY [PATHS]');

function resources(parent:number){
  const text=execFileSync('ps',['-axo','pid=,ppid=,rss=,time='],{encoding:'utf8'});
  const rows=text.trim().split('\n').map(line=>line.trim().split(/\s+/)).filter(r=>r.length>=4).map(r=>({pid:Number(r[0]),ppid:Number(r[1]),rssKiB:Number(r[2]),cpu:r[3]}));
  const ids=new Set([parent]);for(let i=0;i<6;i++)for(const row of rows)if(ids.has(row.ppid))ids.add(row.pid);
  const owned=rows.filter(r=>ids.has(r.pid));return {processes:owned,sumRssKiB:owned.reduce((sum,r)=>sum+r.rssKiB,0)};
}
async function replay(cli:string,output:string,count:number){
  assert(Number.isSafeInteger(count)&&count>=1&&count<=10000);
  fs.mkdirSync(output,{recursive:true});
  const root=path.join(output,'files'),data=path.join(output,'data'),config=path.join(output,'config');fs.mkdirSync(root,{recursive:true});
  const kept=path.join(root,'stable.txt');fs.writeFileSync(kept,'keep');
  const removed=Array.from({length:count},(_,i)=>path.join(root,'old-'+String(i).padStart(7,'0')+'.txt'));
  const paths=[...removed,kept],names=['one','two','three','four'];
  const helper=path.join(output,'events'),trigger=path.join(output,'trigger'),gap=path.join(output,'gap'),ready=path.join(output,'helper-ready');
  const env={...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:config,FE_EVENTS_HELPER:helper};
  const run=(...args:string[])=>execFileSync(cli,[...args,'--json'],{env,encoding:'utf8',timeout:30000,maxBuffer:1024**2});
  for(const name of names){
    run('index',root,'--name',name,'--exhaustive');fs.writeFileSync(path.join(data,'index-'+name+'.txt'),paths.join('\n')+'\n');run('prepare','--index',name);
  }
  fs.writeFileSync(path.join(output,'paths.json'),JSON.stringify(removed));
  const code='#!'+process.execPath+'\nimport fs from "node:fs";let input="";for await(const c of process.stdin)input+=c;const {roots}=JSON.parse(input);for(const r of roots)console.log(JSON.stringify({root:r.path,ready:true}));fs.writeFileSync('+JSON.stringify(ready)+',String(process.pid));let sent=false,gapped=false;setInterval(()=>{if(!sent&&fs.existsSync('+JSON.stringify(trigger)+')){sent=true;const paths=JSON.parse(fs.readFileSync('+JSON.stringify(path.join(output,'paths.json'))+',"utf8"));for(const r of roots)console.log(JSON.stringify({root:r.path,uuid:"fixture",cursor:"1",events:paths.map(path=>({path,flags:512}))}));}if(!gapped&&fs.existsSync('+JSON.stringify(gap)+')){gapped=true;for(const r of roots)console.log(JSON.stringify({root:r.path,uuid:"fixture",cursor:"2",gap:"fixture lost history",events:[]}));}},10);\n';
  fs.writeFileSync(helper,code,{mode:0o700});
  const socketDir=fs.mkdtempSync(path.join(os.tmpdir(),'fe-lv-')),socket=path.join(socketDir,'api.sock');
  const service=spawn(cli,['serve','--socket',socket,'--live',...names.flatMap(n=>['--live-index',n])],{env,stdio:['ignore','ignore','pipe']});
  let error='';service.stderr!.on('data',d=>{error=(error+d).slice(-4000);});
  let token='';
  const request=async(label:string,route:string,timeout=15000)=>{
    const result=await probe(socket,token,label,route,timeout);
    assert.equal(result.status,200,JSON.stringify(result));assert(!result.timeout);return result;
  };
  const waitFor=async(check:()=>boolean,timeout:number)=>{const end=Date.now()+timeout;while(!check()){if(Date.now()>end||service.exitCode!==null)throw new Error('Replay service: '+error);await new Promise(r=>setTimeout(r,10));}};
  try{
    await waitFor(()=>fs.existsSync(socket+'.json')&&fs.existsSync(ready),10000);
    token=(JSON.parse(fs.readFileSync(socket+'.json','utf8')) as {token:string}).token;
    const searchRoute=(name:string)=>'/v1/search?'+new URLSearchParams({q:'sort:name',index:name,limit:'10'});
    assert.equal((await request('before',searchRoute(names[0]))).matched,count+1);
    const before=resources(service.pid!),started=performance.now();fs.writeFileSync(trigger,'go');
    await new Promise(r=>setTimeout(r,350));
    const health:Probe[]=[];
    for(let i=0;i<12;i++){health.push(await probe(socket,token,'during-live-replay','/health',500));await new Promise(r=>setTimeout(r,20));}
    const matches:Probe[]=[];
    await waitFor(()=>{
      const live=new Database(path.join(data,'live.sqlite'),{readonly:true});
      try{return live.query('SELECT count(*) AS n FROM scopes WHERE revision>=1').get().n===names.length;}catch{return false;}finally{live.close();}
    },20000);
    for(const name of names){const result=await request(name,searchRoute(name));assert.equal(result.matched,1);assert.equal(result.returned,1);assert.equal(result.signature,sha(JSON.stringify([kept])));matches.push(result);}
    const visibleMs=performance.now()-started,after=resources(service.pid!);
    fs.writeFileSync(gap,'gap');
    await waitFor(()=>{
      const live=new Database(path.join(data,'live.sqlite'),{readonly:true});
      try{return live.query("SELECT count(*) AS n FROM scopes WHERE problem='fixture lost history'").get().n===names.length;}catch{return false;}finally{live.close();}
    },5000);
    const warning=await request('gap-preserved',searchRoute(names[0]));assert.equal(warning.complete,false);assert((warning.warningCount??0)>0);
    const completed=health.filter(r=>r.status===200&&!r.timeout).map(r=>r.ms);
    const report={passed:true,cliSha256:sha(fs.readFileSync(cli)),count,scopes:names.length,events:count*names.length,visibleMs,
      before,after,health,summary:{successes:completed.length,timeouts:health.filter(r=>r.timeout).length,p50Ms:completed.length?percentile(completed,.5):null,p95Ms:completed.length?percentile(completed,.95):null,maxCompletedMs:completed.length?Math.max(...completed):null},matches,
      gapPreserved:true,limits:['Controlled replay of previously indexed, now absent paths','Same four scopes and path set; source timestamps differ','API probes start 350 ms after replay trigger','Timeouts are censored; p95 covers completed responses only','Observed sum of process RSS is not peak or physical-memory accounting','Concurrent host activity uncontrolled']};
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,summary:report.summary,visibleMs}));
  }finally{
    if(service.exitCode===null&&service.signalCode===null){const done=once(service,'exit',{signal:AbortSignal.timeout(5000)});service.kill('SIGTERM');await done;}
    fs.writeFileSync(path.join(output,'service.log'),error);fs.rmSync(socketDir,{recursive:true,force:true});
  }
}
