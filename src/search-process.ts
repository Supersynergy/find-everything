import {spawn,ChildProcess} from 'node:child_process';
import path from 'node:path';
import {track} from './engine';
declare const Bun:{main:string};

export const searchCanceled=()=>Object.assign(new Error('Search superseded or canceled'),{status:409,code:'SEARCH_CANCELED'});
const IDLE_RETIRE_MS=600000;
const busy=()=>Object.assign(new Error('Search queue is full; retry after current requests finish'),{status:503});
export type SearchWork={query:string;index:string;limit:number;offset:number;client?:string;generation?:number;priority?:string;phase?:string};
type Job={id:number;work:SearchWork;resolve:(data:any)=>void;reject:(error:Error)=>void;cleanup:()=>void};

/** One reusable, disposable reader. Live index writes stay in the service. */
export class SearchProcess {
 private child?:ChildProcess;
 private stopping?:Promise<void>;
 private active?:Job;
 private queue:Job[]=[];
 private clients=new Map<string,number>();
 private sequence=0;
 private closed=false;
 private idle?:ReturnType<typeof setTimeout>;
 private starts=0;private canceled=0;private completed=0;private retiredPid?:number;
 private readonly exit=()=>this.close();
 constructor(private launch:()=>ChildProcess=()=>{
  const source=Bun.main.includes('$bunfs')?[]:[path.join(__dirname,'cli.ts')];
  return track(spawn(process.execPath,[...source,'_search-worker'],{
   detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],env:{...process.env,FE_SEARCH_WORKER:'1',FE_SEARCH_OWNER_PID:String(process.pid)}
  }));
 },private prepare:(work:SearchWork)=>void=()=>{}){process.once('exit',this.exit);}
 canSync(){return !this.active&&!this.stopping;}
 /** Starts the reader ahead of the first keystroke so the first query skips the process start.
  * The same idle timer as after a search applies, so an unused warm reader still retires. */
 warm(){if(this.closed||this.stopping||this.child)return;this.start();clearTimeout(this.idle);this.idle=setTimeout(()=>this.retire(),IDLE_RETIRE_MS);this.idle.unref();}
 status(){return {pid:this.child?.pid??null,active:this.active?1:0,queued:this.queue.length,starts:this.starts,canceled:this.canceled,completed:this.completed,retiredPid:this.retiredPid??null};}
 advance(work:SearchWork){
  if(work.client===undefined&&work.generation===undefined)return;
  if(!work.client||!/^[a-zA-Z0-9_-]{8,64}$/.test(work.client)||!Number.isSafeInteger(work.generation)||work.generation!<0)throw new Error('Invalid search client or generation');
  const previous=this.clients.get(work.client);
  if(previous!==undefined&&work.generation!<previous)throw searchCanceled();
  if(previous===undefined){
   for(const key of this.clients.keys()){
    if(this.clients.size<64)break;
    if(this.active?.work.client!==key&&!this.queue.some(j=>j.work.client===key))this.clients.delete(key);
   }
   if(this.clients.size>=64)throw busy();
  }
  this.clients.delete(work.client);this.clients.set(work.client,work.generation!);
  for(const job of [...this.queue,...(this.active?[this.active]:[])])if(job.work.client===work.client&&job.work.generation!<work.generation!)this.cancel(job);
 }
 search(work:SearchWork,signal:AbortSignal):Promise<any>{
  if(this.closed)return Promise.reject(new Error('Search service is closing'));
  this.advance(work);
  if(signal.aborted)return Promise.reject(searchCanceled());
  // Foreground work can discard its own same-generation prefetch.
  if(work.priority==='foreground')for(const job of [...this.queue,...(this.active?[this.active]:[])])if(job.work.client===work.client&&work.client&&job.work.priority==='prefetch')this.cancel(job);
  if(this.queue.length+(this.active?1:0)>=2)return Promise.reject(busy());
  return new Promise((resolve,reject)=>{
   const job:Job={id:++this.sequence,work,resolve,reject,cleanup:()=>{clearTimeout(timer);signal.removeEventListener('abort',abort)}};
   const abort=()=>this.cancel(job),timer=setTimeout(()=>this.cancel(job,new Error('Search exceeded 12 seconds')),12000);
   signal.addEventListener('abort',abort,{once:true});this.queue.push(job);this.drain();
  });
 }
 private finish(job:Job,error?:Error,data?:any){job.cleanup();if(error)job.reject(error);else job.resolve(data);}
 private cancel(job:Job,error:Error=searchCanceled()){
  if(this.active===job){this.active=undefined;this.canceled++;this.finish(job,error);this.retire();}
  else {const i=this.queue.indexOf(job);if(i<0)return;this.queue.splice(i,1);this.canceled++;this.finish(job,error);}
  this.drain();
 }
 private drain(){
  if(this.closed||this.active||this.stopping||!this.queue.length)return;
  clearTimeout(this.idle);
  const job=this.queue.shift()!;this.active=job;
  try {
   this.prepare(job.work);
   if(!this.child)this.start();
   this.child!.stdin!.write(JSON.stringify({id:job.id,...job.work})+'\n',error=>{if(error&&this.active===job)this.cancel(job,error)});
  }catch(e){this.cancel(job,e);}
 }
 private start(){
  const child=this.launch();this.child=child;this.starts++;
  let buffer='',errors='';child.stdout!.setEncoding('utf8');
  child.stdout!.on('data',chunk=>{
   if(this.child!==child)return;
   buffer+=chunk;
   if(Buffer.byteLength(buffer)>4*1024**2){if(this.active)this.cancel(this.active,new Error('Search response exceeds 4 MiB'));return;}
   let end:number;
   while((end=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    try {
     const reply=JSON.parse(line),job=this.active;
     if(!job||reply.id!==job.id)throw new Error('Invalid search worker response');
     this.active=undefined;
     this.finish(job,reply.error?new Error(reply.error):undefined,reply.data);this.completed++;
     this.idle=setTimeout(()=>this.retire(),IDLE_RETIRE_MS);this.idle.unref();this.drain();
    }catch(e){if(this.active)this.cancel(this.active,e);else this.retire();return;}
   }
  });
  child.stderr!.on('data',d=>{errors=(errors+d).slice(-2000)});
  child.stdin!.on('error',e=>{if(this.child===child&&this.active)this.cancel(this.active,e)});
  child.on('error',e=>{if(this.child===child&&this.active)this.cancel(this.active,e)});
  child.once('close',()=>{
   if(this.child!==child)return;
   this.child=undefined;
   if(this.active){const job=this.active;this.active=undefined;this.finish(job,new Error('Search worker stopped: '+errors.slice(-400)));}
   this.drain();
  });
 }
 private retire(){
  clearTimeout(this.idle);
  const child=this.child;if(!child)return;
  this.child=undefined;this.retiredPid=child.pid;
  // Reap the previous reader before starting another; never overlap SQL jobs.
  this.stopping=new Promise<void>(resolve=>child.once('close',resolve));
  this.stopping.then(()=>{this.stopping=undefined;this.drain()});
  // A refused signal must never escape: retire runs from request, exit and close
  // callbacks, where a throw would crash the service and leave the app without a socket.
  if(!this.signalReader(child))child.stdin?.destroy();
 }
 /** Kills the detached reader group; answers false when the signal itself failed. */
 private signalReader(child:ChildProcess):boolean{
  if(process.platform==='win32')return this.trySignal(()=>child.kill('SIGKILL'));
  if(child.pid&&this.trySignal(()=>process.kill(-child.pid!,'SIGKILL')))return true;
  return this.trySignal(()=>child.kill('SIGKILL'));
 }
 private trySignal(send:()=>boolean):boolean{
  try {send();return true;}
  catch(e){return e.code==='ESRCH';}
 }
 close(){
  if(this.closed)return;this.closed=true;process.removeListener('exit',this.exit);
  for(const job of this.queue.splice(0))this.finish(job,searchCanceled());
  if(this.active){const job=this.active;this.active=undefined;this.finish(job,searchCanceled());}
  this.retire();
 }
}
