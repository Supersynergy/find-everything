import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,spawnSync,ChildProcessWithoutNullStreams} from 'node:child_process';
import {track} from './engine';

export const INSTANT_MODEL='embeddinggemma-q4:5090578d9565bb06545b4552f76e6bc2c93e4a66:256:chunks-v1';
const FILES:Record<string,string>={
  'config.json':'6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b',
  'tokenizer.json':'4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47',
  'onnx/model_q4.onnx':'ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043',
  'onnx/model_q4.onnx_data':'599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02'};
interface Configuration {modelId:string;model:string;python:string;files:Record<string,number>;tokenizerBytes?:number;coreBytes?:number;coreDataBytes?:number}
export interface EmbeddingReply {vectors:number[][];pid:number;setupMs:number;peakRssMiB:number}
export interface DocumentEncoder {encode(texts:string[],kind:'query'|'document'|'passage'):Promise<EmbeddingReply>}
export const instantRuntime=()=>process.env.FE_INSTANTFIND_RUNTIME||path.join(os.homedir(),'Library/Application Support/FindEverything/instantfind');
const configFile=()=>path.join(instantRuntime(),'config.json');
function configuration():Configuration {
  const file=configFile(),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||process.getuid&&stat.uid!==process.getuid())throw new Error('Unsafe instantfind configuration');
  const value=JSON.parse(fs.readFileSync(file,'utf8')) as Configuration;
  if(value.modelId!==INSTANT_MODEL||!path.isAbsolute(value.model)||!path.isAbsolute(value.python))throw new Error('Invalid instantfind configuration');
  for(const name of Object.keys(FILES))if(fs.statSync(path.join(value.model,name)).size!==value.files[name])throw new Error('Instantfind model changed; run setup again');
  if(value.tokenizerBytes!==undefined){const tokenizer=fs.lstatSync(path.join(value.model,'tokenizer.sqlite'));if(!tokenizer.isFile()||tokenizer.isSymbolicLink()||tokenizer.mode&0o077||tokenizer.size!==value.tokenizerBytes)throw new Error('Compact tokenizer changed; run setup again');}
  if(value.coreBytes!==undefined){for(const [name,size] of [['core.onnx',value.coreBytes],['core.data',value.coreDataBytes]] as const){const file=fs.lstatSync(path.join(value.model,'onnx',name));if(!file.isFile()||file.isSymbolicLink()||file.mode&0o077||file.size!==size)throw new Error('Memory-efficient model changed; run setup again');}}
  return value;
}
function workerPath(){
  const installed=path.resolve(path.dirname(fs.realpathSync(process.execPath)),'../Resources/instantfind/worker.py');
  return process.env.FE_INSTANTFIND_WORKER||(fs.existsSync(installed)?installed:path.resolve(__dirname,'../runtime/instantfind/worker.py'));
}
export function instantRuntimeStatus(){
  try {const value=configuration();return {ready:true,model:INSTANT_MODEL,modelPath:value.model,python:value.python};}
  catch(error){return {ready:false,model:INSTANT_MODEL,reason:String((error as Error).message)};}
}
export async function setupInstantRuntime(model:string,python:string){
  if(!path.isAbsolute(model)||!path.isAbsolute(python))throw new Error('Use absolute --model and --python paths');
  const probe=spawnSync(python,['-c','import numpy, onnxruntime, sqlite3; print(onnxruntime.__version__)'],{encoding:'utf8',timeout:15000});
  if(probe.status!==0)throw new Error('The Python environment needs numpy and onnxruntime; no dependencies were installed');
  const base=instantRuntime(),target=path.join(base,'models',randomUUID());
  fs.mkdirSync(target,{recursive:true,mode:0o700});const sizes:Record<string,number>={};
  try {
    for(const [name,expected] of Object.entries(FILES)){
      const source=path.join(model,name),hash=createHash('sha256');
      for await(const chunk of fs.createReadStream(source))hash.update(chunk);
      if(hash.digest('hex')!==expected)throw new Error(`Unexpected pinned model file: ${name}`);
      const destination=path.join(target,name);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});fs.copyFileSync(source,destination);fs.chmodSync(destination,0o600);
      const copied=createHash('sha256');for await(const chunk of fs.createReadStream(destination))copied.update(chunk);
      if(copied.digest('hex')!==expected)throw new Error(`Model changed while copying: ${name}`);
      sizes[name]=fs.statSync(destination).size;
    }
    const compact=path.join(target,'tokenizer.sqlite');
    const prepare=spawnSync(python,[path.join(path.dirname(workerPath()),'compact_tokenizer.py'),path.join(target,'tokenizer.json'),compact],{encoding:'utf8',timeout:60000});
    if(prepare.status!==0)throw new Error('Compact tokenizer preparation failed: '+(prepare.stderr||prepare.error?.message||'unknown error').slice(-600));
    fs.chmodSync(compact,0o600);
    const core=spawnSync(python,[path.join(path.dirname(workerPath()),'compact_model.py'),target],{encoding:'utf8',timeout:60000});
    if(core.status!==0)throw new Error('Memory-efficient model preparation failed: '+(core.stderr||core.error?.message||'unknown error').slice(-600));
    const value:Configuration={modelId:INSTANT_MODEL,model:target,python,files:sizes,tokenizerBytes:fs.statSync(compact).size,coreBytes:fs.statSync(path.join(target,'onnx/core.onnx')).size,coreDataBytes:fs.statSync(path.join(target,'onnx/core.data')).size};
    const temporary=configFile()+'.'+randomUUID();fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,configFile());
  }catch(error){fs.rmSync(target,{recursive:true,force:true});throw error;}
  return instantRuntimeStatus();
}
export class InstantFindWorker implements DocumentEncoder {
  private child?:ChildProcessWithoutNullStreams;
  private sequence=0;
  private pending?:{id:number;resolve:(reply:EmbeddingReply)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
  private buffer='';private tail:Promise<unknown>=Promise.resolve();private queued=0;
  encode(texts:string[],kind:'query'|'document'|'passage'):Promise<EmbeddingReply>{
    if(this.queued>=4)return Promise.reject(new Error('Instantfind queue is full'));
    this.queued++;
    const task=this.tail.then(()=>this.perform(texts,kind));
    this.tail=task.catch(()=>{}).finally(()=>{this.queued--;});return task;
  }
  private start(){
    const config=configuration();
    const helper=workerPath();
    const child=track(spawn(config.python,[helper,config.model],{detached:process.platform!=='win32'&&process.env.FE_SEARCH_WORKER!=='1',stdio:['pipe','pipe','pipe'],env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'2',TOKENIZERS_PARALLELISM:'false'}})) as ChildProcessWithoutNullStreams;
    this.child=child;this.buffer='';let errors='';child.stdout.setEncoding('utf8');
    child.stdout.on('data',(text:string)=>{
      this.buffer+=text;if(this.buffer.length>4*1024*1024){this.close(new Error('Instantfind response too large'));return;}
      const end=this.buffer.indexOf('\n');if(end<0)return;
      const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
      try {
        const reply=JSON.parse(line),pending=this.pending;
        if(!pending||reply.id!==pending.id)throw new Error('Unexpected instantfind response');
        clearTimeout(pending.timer);this.pending=undefined;
        if(reply.error)pending.reject(new Error(reply.error));
        else if(!Array.isArray(reply.vectors)||reply.vectors.some((v:unknown)=>!Array.isArray(v)||v.length!==768||v.some(n=>typeof n!=='number'||!Number.isFinite(n))))pending.reject(new Error('Invalid embedding vectors'));
        else pending.resolve(reply as EmbeddingReply);
      }catch(error){this.close(error as Error);}
    });
    child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-1200);});
    child.on('error',error=>this.close(error));child.stdin.on('error',error=>this.close(error));
    child.on('exit',()=>{if(this.child===child)this.close(new Error(`Instantfind worker exited: ${errors}`));});
  }
  private perform(texts:string[],kind:'query'|'document'|'passage'):Promise<EmbeddingReply>{
    if(!texts.length||texts.length>4||texts.some(t=>!t.trim()||t.length>8000))return Promise.reject(new Error('Use 1–4 bounded texts'));
    if(!this.child)this.start();
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.close(new Error('Instantfind model exceeded 30 seconds')),30000);
      this.pending={id,resolve,reject,timer};this.child!.stdin.write(JSON.stringify({id,kind,texts})+'\n');
    });
  }
  close(error=new Error('Instantfind worker closed')){
    const child=this.child;this.child=undefined;
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=undefined;}
    if(child&&child.exitCode===null){try{child.kill('SIGTERM');}catch{}}
  }
}
export const instantEncoder=new InstantFindWorker();
