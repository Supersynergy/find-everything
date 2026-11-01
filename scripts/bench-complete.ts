import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {socketRequest} from '../src/socket';
const [candidate,baseline,output,rowsArg='200000']=process.argv.slice(2);
if(!candidate||!baseline||!output)throw new Error('Usage: bench-complete.ts candidate baseline output.json [rows]');
const n=Number(rowsArg);if(!Number.isInteger(n)||n<1000||n>1000000)throw new Error('Rows must be 1000..1000000');
const dir=mkdtempSync(path.join(tmpdir(),'fe-fullbench-')),root=path.join(dir,'files');mkdirSync(root);
const data=Array.from({length:n},(_,i)=>path.join(root,`project-${Math.floor(i/10)}`,`${i%97===0?'überblick':i%7===0?'README':'common'}-${String(i).padStart(7,'0')}.${i%3===0?'md':'ts'}`));
const queries=['common sort:name','0000123 sort:name','ext:md sort:name','project-52 sort:name','überblick sort:name','missing-unique-result sort:name','a sort:name','common sort:name-desc','project-52 sort:path-desc','omit:generated sort:name'];
const matches=(p:string,q:string)=>q.startsWith('omit:generated')?!/(?:node_modules|\.git|\.build|__pycache__|\.cache|\.venv|target|DerivedData|\.next|dist|build|\.turbo)\//.test(p):q.startsWith('ext:md')?p.endsWith('.md'):p.toLowerCase().includes(q.split(' ')[0]);
const cmp=(a:string,b:string)=>{const x=path.basename(a).toLowerCase(),y=path.basename(b).toLowerCase();return x<y?-1:x>y?1:a<b?-1:a>b?1:0;};
const pathCmp=(a:string,b:string)=>{const x=(path.dirname(a)+'/').toLowerCase(),y=(path.dirname(b)+'/').toLowerCase();return x<y?-1:x>y?1:cmp(a,b);};
const expected=queries.map(q=>data.filter(p=>matches(p,q)).sort((a,b)=>q.endsWith('sort:path-desc')?-pathCmp(a,b):cmp(a,b)*(q.endsWith('sort:name-desc')?-1:1)));
const digest=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const samples:any[]=[],preparation:any[]=[];let service:ReturnType<typeof spawn>|undefined;
const wait=()=>new Promise(r=>setTimeout(r,10));
try {
 for(const [variant,cli] of [...(baseline==='-'?[]:[['baseline',baseline]]),['candidate',candidate]]) {
  const env={...process.env,FE_DATA_DIR:path.join(dir,variant),FE_CONFIG_DIR:path.join(dir,variant+'-config')};
  execFileSync(cli,['index',root,'--name','bench'],{env,timeout:20000});
  const file=path.join(env.FE_DATA_DIR,'index-bench.txt');writeFileSync(file,data.join('\n')+'\n');
  const before=statSync(file).mtimeMs;
  if(variant==='candidate'||process.argv.includes('--prepare-baseline')){const t=performance.now();const result=JSON.parse(execFileSync(cli,['prepare','--index','bench','--seconds','60','--json'],{env,encoding:'utf8',timeout:65000}));assert.equal(result.ready,true);preparation.push({variant,...result,wallMs:performance.now()-t,sourceBytes:statSync(file).size});}
  const socket=path.join(dir,variant+'.sock');let log='';
  service=spawn(cli,['serve','--socket',socket],{env,stdio:['ignore','ignore','pipe']});service.stderr!.on('data',d=>log+=d);
  for(let i=0;i<500&&!log.includes('\n');i++){if(service.exitCode!==null)throw new Error(log);await wait();}
  assert(log.includes('\n'),'service startup');
  for(let round=0;round<5;round++) for(let i=0;i<queries.length;i++) {
   const t=performance.now();const result=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:queries[i]+(queries[i].startsWith('omit:')?' '.repeat(round):''),index:'bench',limit:'300'}));
   const ms=performance.now()-t,ordered=result.paths.every((p:string,j:number)=>p===expected[i][j]),correctCount=result.coverage?.matched===expected[i].length;
   assert(result.paths.every((p:string)=>matches(p,queries[i])),'returned paths must match');
   if(variant==='candidate'){assert(ordered,queries[i]+' order');assert(correctCount,queries[i]+' count');assert.equal(result.complete,true);}
   samples.push({variant,round,query:queries[i],ms,engineMs:result.elapsedMs,cacheHit:result.cacheHit??false,complete:result.complete,correctCount,ordered,matched:expected[i].length,returned:result.paths.length});
  }
  if(variant==='candidate'&&n>=175000){const result=await socketRequest(socket,'/v1/search?'+new URLSearchParams({q:queries[0],index:'bench',limit:'300',offset:'150000'}));assert.deepEqual(result.paths,expected[0].slice(150000,150300));assert.equal(result.coverage.matched,expected[0].length);}
  const rssKiB=Number(execFileSync('ps',['-o','rss=','-p',String(service.pid)],{encoding:'utf8'}).trim());
  assert.equal(statSync(file).mtimeMs,before,'queries must not rewrite the source snapshot');
  preparation.push({variant,rssKiB,pathSnapshotChanged:false,cliSha256:digest(cli)});
  service.kill('SIGTERM');await new Promise<void>(r=>service!.once('exit',()=>r()));service=undefined;
 }
 const quantile=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))];
 const summary=Object.fromEntries((baseline==='-'?['candidate']:['baseline','candidate']).map(v=>{const rows=samples.filter(s=>s.variant===v),first=rows.filter(s=>s.round===0),warm=rows.filter(s=>s.round>0);return[v,{firstPassMs:first.map(r=>({query:r.query,ms:r.ms})),warmMedianMs:quantile(warm.map(r=>r.ms),.5),warmP95Ms:quantile(warm.map(r=>r.ms),.95),completeChecks:rows.filter(r=>r.complete&&r.correctCount&&r.ordered).length,totalChecks:rows.length}];}));
 const report={passed:true,fixture:{rows:n,sha256:createHash('sha256').update(data.map(p=>p.slice(root.length)).join('\n')).digest('hex'),queries},summary,preparation,samples,limits:{cold:'new service; OS disk cache uncontrolled',physicalWriteBytes:'unmeasured',windowsComparison:false}};
 writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({summary,preparation}));
}catch(e){writeFileSync(output,JSON.stringify({passed:false,error:String(e),samples,preparation},null,2));throw e;}
finally{service?.kill('SIGTERM');rmSync(dir,{recursive:true,force:true});}
