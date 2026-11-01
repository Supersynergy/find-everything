import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [cli,output,mode='check']=process.argv.slice(2);
if(!cli||!output)throw new Error('Usage: bench-cancel.ts cli output [record|check]');
const dir=mkdtempSync(path.join(tmpdir(),'fe-cancel-')),socket=path.join(dir,'s.sock');
const files=['index-everything.txt','search-everything.sqlite'].map(f=>path.join(process.env.FE_DATA_DIR||path.join(process.env.HOME!,'.cache/hypersearch'),f));
const stamps=()=>files.map(f=>{const s=statSync(f);return [s.mtimeMs,s.size]});
const before=stamps(),samples:any[]=[];let log='';
const service=spawn(cli,['serve','--socket',socket],{stdio:['ignore','ignore','pipe']});service.stderr!.on('data',d=>log+=d);
try{
 for(let i=0;i<300&&!log.includes('\n');i++){if(service.exitCode!==null)throw new Error(log);await new Promise(r=>setTimeout(r,10));}
 const {token}=JSON.parse(readFileSync(socket+'.json','utf8'));
 const get=(route:string)=>new Promise<any>((resolve,reject)=>{
  const req=http.get({socketPath:socket,path:route,headers:{Host:'localhost',Authorization:'Bearer '+token},timeout:12000},res=>{let body='';res.setEncoding('utf8');res.on('data',d=>body+=d);res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(body)})}catch(e){reject(e)}})});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Deadline')));
 });
 const search=(q:string,generation:number)=>get('/v1/search?'+new URLSearchParams({q,index:'everything',limit:'1000',client:'cancel-benchmark',generation:String(generation),priority:'foreground'}));
 for(const [i,q]of ['do omit:system;generated sort:name','d omit:system;generated sort:name'].entries()){
  const old=search(q,2*i+1);await new Promise(r=>setTimeout(r,40));
  const start=performance.now(),latest=await search('favorites:true',2*i+2),latestMs=performance.now()-start,obsolete=await old;
  assert.equal(latest.status,200,JSON.stringify(latest.body));assert(latest.body.paths.length>0);assert.equal(latest.body.engine,'sqlite-trigram');
  const health=await get('/health'),sample={query:q,latestMs,obsoleteStatus:obsolete.status,latestCount:latest.body.coverage.matched,state:health.body.search};samples.push(sample);console.log(JSON.stringify(sample));
  if(mode==='check'){assert.equal(obsolete.status,409);assert(latestMs<500,'Latest input must not wait for obsolete SQL');assert(health.body.search.canceled>=i+1);}
 }
 assert.deepEqual(stamps(),before);
 writeFileSync(output,JSON.stringify({passed:mode==='check',mode,samples,indexFilesChanged:false,cliSha256:createHash('sha256').update(readFileSync(cli)).digest('hex'),limits:{osCache:'uncontrolled',physicalWrites:'unmeasured'}},null,2));
}catch(e){writeFileSync(output,JSON.stringify({passed:false,error:String(e),samples},null,2));throw e;}
finally{const done=once(service,'exit');service.kill('SIGTERM');await done;rmSync(dir,{recursive:true,force:true});}
