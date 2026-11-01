import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const [baseline,candidate,output,index='everything']=process.argv.slice(2);
if(!baseline||!candidate||!output)throw new Error('Usage: bench-broad.ts baseline-cli|@reference.json candidate-cli output [existing-index]');
const dir=mkdtempSync(path.join(tmpdir(),'fe-broad-'));
const queries=['d omit:system;generated sort:name','d omit:system;generated sort:big','sort:big','do omit:system;generated sort:name','ext:ts omit:system;generated sort:name','a sort:name'];
const files=[`index-${index}.txt`,`search-${index}.sqlite`].map(p=>path.join(process.env.FE_DATA_DIR||path.join(process.env.HOME!,'.cache/hypersearch'),p));
const stamps=()=>files.map(p=>{const s=statSync(p);return [s.mtimeMs,s.size]});
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const reference=baseline.startsWith('@')?JSON.parse(readFileSync(baseline.slice(1),'utf8')):null;
if(reference){assert.equal(reference.passed,true);assert.equal(reference.index,index);assert.deepEqual(reference.queries,queries);assert.equal(reference.indexFilesChanged,false);}
const before=stamps(),samples:any[]=reference?reference.samples.filter((s:any)=>s.variant==='baseline'):[],resources:any[]=reference?reference.resources.filter((r:any)=>r.variant==='baseline'):[];
let service:ReturnType<typeof spawn>|undefined;
try {
 for(const [variant,cli] of [...(reference?[]:[['baseline',baseline]]),['candidate',candidate]]){
  const socket=path.join(dir,'search.sock');let log='';
  service=spawn(cli,['serve','--socket',socket],{stdio:['ignore','ignore','pipe']});service.stderr!.on('data',d=>log+=d);
  for(let i=0;i<500&&!log.includes('\n');i++){if(service.exitCode!==null)throw new Error(log);await new Promise(r=>setTimeout(r,10));}
  assert(log.includes('\n'));
  const {token}=JSON.parse(readFileSync(socket+'.json','utf8'));
  const call=(query:string)=>new Promise<any>((resolve,reject)=>{
   const req=http.get({socketPath:socket,path:'/v1/search?'+new URLSearchParams({q:query,index,limit:'1000'}),headers:{Host:'localhost',Authorization:'Bearer '+token},timeout:45000},res=>{
    let body='';res.setEncoding('utf8');res.on('data',d=>{body+=d;if(body.length>4*1024**2)req.destroy(new Error('Response limit'));});res.on('error',reject);res.on('end',()=>{try{const data=JSON.parse(body);assert.equal(res.statusCode,200,data.error);resolve(data)}catch(e){reject(e)}});
   });req.on('timeout',()=>req.destroy(new Error('45 second benchmark deadline')));req.on('error',reject);
  });
  for(let round=0;round<2;round++)for(const query of queries){
   const start=performance.now(),r=await call(query+' '.repeat(round));
   assert.equal(r.engine,'sqlite-trigram',r.warnings?.join(';'));
   const signature=hash([r.paths,r.properties,r.coverage,r.nextOffset,r.complete]);
   if(variant==='candidate')assert.equal(signature,samples.find(s=>s.variant==='baseline'&&s.query===query&&s.round===round)?.signature,query);
   const sample={variant,query,round,wallMs:performance.now()-start,engineMs:r.elapsedMs,matched:r.coverage.matched,cacheHit:r.cacheHit,signature};samples.push(sample);console.log(JSON.stringify(sample));
  }
  resources.push({variant,rssKiB:Number(execFileSync('ps',['-o','rss=','-p',String(service.pid)],{encoding:'utf8'}).trim()),cliSha256:digest(cli),cpu:execFileSync('ps',['-o','time=','-p',String(service.pid)],{encoding:'utf8'}).trim()});
  const done=once(service,'exit');service.kill('SIGTERM');await done;service=undefined;
 }
 assert.deepEqual(stamps(),before,'Search must not modify the stored path snapshot or accelerator');
 writeFileSync(output,JSON.stringify({passed:true,index,queries,samples,resources,sourceFiles:before,reference:reference?{file:baseline.slice(1),sha256:digest(baseline.slice(1))}:null,indexFilesChanged:false,limits:{cold:'Fresh service, OS cache uncontrolled',physicalWriteBytes:'unmeasured',swapDelta:'unmeasured',windowsComparison:false}},null,2));
}catch(e){writeFileSync(output,JSON.stringify({passed:false,error:String(e),samples,resources},null,2));throw e;}
finally{if(service){const done=once(service,'exit');service.kill('SIGTERM');await done;}rmSync(dir,{recursive:true,force:true});}
