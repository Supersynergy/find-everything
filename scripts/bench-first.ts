import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [cli,output,mode='check',workload='names']=process.argv.slice(2);
if(!cli||!output||!['check','record'].includes(mode))throw new Error('Usage: bench-first.ts cli output [check|record]');
const dir=mkdtempSync(path.join(tmpdir(),'fe-first-')),socket=path.join(dir,'s.sock');
const files=['index-everything.txt','search-everything.sqlite'].map(f=>path.join(process.env.FE_DATA_DIR||path.join(process.env.HOME!,'.cache/hypersearch'),f));
const stamps=()=>files.map(f=>{const s=statSync(f);return [s.mtimeMs,s.size]});
const before=stamps(),samples:any[]=[];let log='';
const service=spawn(cli,['serve','--socket',socket],{stdio:['ignore','ignore','pipe']});service.stderr!.on('data',d=>log+=d);
try{
 for(let i=0;i<300&&!log.includes('\n');i++){if(service.exitCode!==null)throw new Error(log);await new Promise(r=>setTimeout(r,10));}
 const {token}=JSON.parse(readFileSync(socket+'.json','utf8'));
 const get=(q:string,preview:boolean)=>new Promise<any>((resolve,reject)=>{
  const start=performance.now(),req=http.get({socketPath:socket,path:'/v1/search?'+new URLSearchParams({q,index:'everything',limit:'1000',...(preview?{phase:'preview'}:{})}),headers:{Host:'localhost',Authorization:'Bearer '+token},timeout:12000},res=>{let body='';res.setEncoding('utf8');res.on('data',d=>body+=d);res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,200,body);resolve({data:JSON.parse(body),ms:performance.now()-start})}catch(e){reject(e)}})});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Deadline')));
 });
 for(const term of workload==='experience'?['','ext:pdf size:>10m','dm:7d','ext:pdf in:/Users/master/Downloads']:['was','do','d','master','ext:ts']){
  const query=term+' omit:system;generated sort:name',first=await get(query,true),full=await get(query,false),warm=await get(query,true);
  assert.equal(first.data.engine,'sqlite-trigram');assert.deepEqual(first.data.paths,full.data.paths);assert.deepEqual(first.data.properties,full.data.properties);if(mode==='check')assert.equal(first.data.coverage.matched,null);
  const sample={query,firstMs:first.ms,exactMs:full.ms,warmFirstMs:warm.ms,matched:full.data.coverage.matched,firstPaths:first.data.paths.length};samples.push(sample);console.log(JSON.stringify(sample));
 }
 assert.deepEqual(stamps(),before);
 writeFileSync(output,JSON.stringify({passed:true,mode,samples,indexFilesChanged:false,cliSha256:createHash('sha256').update(readFileSync(cli)).digest('hex'),limits:{osCache:'uncontrolled',physicalWrites:'unmeasured'}},null,2));
}catch(e){writeFileSync(output,JSON.stringify({passed:false,error:String(e),samples},null,2));throw e;}
finally{const done=once(service,'exit');service.kill('SIGTERM');await done;rmSync(dir,{recursive:true,force:true});}
