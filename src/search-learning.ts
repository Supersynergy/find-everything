import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {acquireLock} from './catalog';

type Selection={key:string;path:string;weight:number;at:number};
type Learning={version:1;enabled:boolean;selections:Selection[]};
const HALF_LIFE=30*86400000,MAX_ENTRIES=512;
export const learningFile=()=>process.env.FE_LEARNING_FILE||path.join(process.env.FE_DATA_DIR||path.join(os.homedir(),'Library/Application Support/FindEverything'),'search-learning.json');
export function queryKey(query:string,index:string){return createHash('sha256').update(JSON.stringify([index,query])).digest('hex');}
export function decayedWeight(weight:number,at:number,now=Date.now()){return weight*Math.pow(2,-Math.max(0,now-at)/HALF_LIFE);}
function readLearning():Learning {
  try {
    const file=learningFile();if(fs.statSync(file).size>512*1024)throw new Error('Search learning exceeds 512 KiB');
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(value.version!==1||typeof value.enabled!=='boolean'||!Array.isArray(value.selections)||value.selections.length>MAX_ENTRIES||value.selections.some((s:any)=>!s||!/^[a-f0-9]{64}$/.test(s.key)||typeof s.path!=='string'||!path.isAbsolute(s.path)||s.path.length>4096||/[\r\n\0]/.test(s.path)||!Number.isFinite(s.weight)||s.weight<0||s.weight>1000||!Number.isFinite(s.at)||s.at<0))throw new Error('Invalid search learning file');
    return value;
  }catch(e){if(e.code==='ENOENT')return {version:1,enabled:true,selections:[]};throw e;}
}
export function learnedSelections(query:string,index:string,now=Date.now()) {
  const data=readLearning();if(!data.enabled)return [];
  const key=queryKey(query,index);
  return data.selections.filter(s=>s.key===key).map(s=>({path:s.path,boost:Math.min(48,16*Math.log2(1+decayedWeight(s.weight,s.at,now)))})).filter(s=>s.boost>=1).sort((a,b)=>b.boost-a.boost||a.path.localeCompare(b.path)).slice(0,32);
}
export function updateLearning(action:string,query='',index='',selected='') {
  if(!['status','open','reset','enable','disable'].includes(action))throw new Error('Use learn status|open|reset|enable|disable');
  if(typeof query!=='string'||query.length>4096||typeof index!=='string'||index.length>128)throw new Error('Invalid learning context');
  if(action==='status'){const data=readLearning();return {enabled:data.enabled,entries:data.selections.length};}
  if(action==='open'&&(!path.isAbsolute(selected)||selected.length>4096||/[\r\n\0]/.test(selected)||!fs.existsSync(selected)))throw new Error('Learning requires an existing absolute path');
  const file=learningFile();fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const release=acquireLock(file+'.lock');
  try {
    // A corrupt profile can be reset, but recovery stays opted out.
    let data:Learning;try{data=readLearning();}catch(e){if(action!=='reset')throw e;data={version:1,enabled:false,selections:[]};}
    if(action==='reset')data.selections=[];
    if(action==='enable'||action==='disable')data.enabled=action==='enable';
    if(action==='open'){
      if(!data.enabled||!query.trim())return {enabled:data.enabled,entries:data.selections.length};
      const key=queryKey(query,index),now=Date.now(),previous=data.selections.find(s=>s.key===key&&s.path===selected);
      const entry={key,path:selected,weight:Math.min(1000,1+(previous?decayedWeight(previous.weight,previous.at,now):0)),at:now};
      data.selections=[entry,...data.selections.filter(s=>s!==previous)].sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key)).slice(0,MAX_ENTRIES);
    }
    let body=JSON.stringify(data);while(Buffer.byteLength(body)>512*1024&&data.selections.length){data.selections.pop();body=JSON.stringify(data);}
    if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===body)return {enabled:data.enabled,entries:data.selections.length};
    const temporary=file+'.'+randomUUID();try{fs.writeFileSync(temporary,body,{mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
    return {enabled:data.enabled,entries:data.selections.length};
  }finally{release();}
}
