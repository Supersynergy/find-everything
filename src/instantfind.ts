import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {INDEX_DIR,ParsedQuery,compareSearchProperties,parseQuery} from './engine';
import {validateName,acquireLock} from './catalog';
import {readCachedContent,contentSnapshotId,matchesCachedContent,meaningPassages,CachedContentRecord} from './content-search';
import {instantEncoder,instantRuntimeStatus,INSTANT_MODEL,DocumentEncoder,EmbeddingReply} from './instantfind-worker';

const DIMENSIONS=768;
export const meaningPath=(index:string)=>path.join(INDEX_DIR,`meaning-${validateName(index)}.sqlite`);
type Chunk={path:string;position:number;hash:string;vector:Float32Array};
type Stored={snapshot:string;revision:string;limited:boolean;sourceComplete:boolean;documents:Map<string,CachedContentRecord>;chunks:Chunk[]};
let cached:{file:string;stamp:string;value:Stored}|undefined;
const queries=new Map<string,EmbeddingReply>();
function open(file:string,readonly=true){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||process.getuid&&stat.uid!==process.getuid())throw new Error('Unsafe instantfind index');
  const db=new Database(file,{readonly,create:false});db.exec('PRAGMA cache_size=-256');return db;
}
const digest=(text:string)=>createHash('sha256').update(INSTANT_MODEL).update(text).digest('hex');
export function documentChunks(row:CachedContentRecord):string[]{
  const text=row.text.replace(/\s+/g,' ').trim(),title=path.basename(row.path);
  const chunks:string[]=[];
  for(let start=0;start<text.length&&chunks.length<6;start+=800)chunks.push(`title: ${title} | text: ${text.slice(start,start+900)}`);
  return chunks;
}
function readIndex(index:string,pending=false):Stored {
  const file=meaningPath(index)+(pending?'.pending':''),s=fs.lstatSync(file),stamp=`${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||process.getuid&&s.uid!==process.getuid())throw new Error('Unsafe instantfind index');
  if(cached?.file===file&&cached.stamp===stamp)return cached.value;
  const db=open(file);
  try {
    const meta=Object.fromEntries((db.query('SELECT key,value FROM meta').all() as {key:string;value:string}[]).map(r=>[r.key,r.value]));
    if(meta.model!==INSTANT_MODEL)throw new Error('Instantfind model/index mismatch; rebuild the index');
    const files=db.query('SELECT record FROM files ORDER BY path').all() as {record:string}[];
    if(files.length>10000)throw new Error('Instantfind document limit exceeded');
    const documents=new Map<string,CachedContentRecord>();
    for(const row of files){const record=JSON.parse(row.record) as CachedContentRecord;documents.set(record.path,record);}
    const chunks:Chunk[]=[];
    for(const row of db.query('SELECT path,position,hash,vector FROM chunks ORDER BY path,position').iterate() as Iterable<{path:string;position:number;hash:string;vector:Uint8Array}>){
      if(chunks.length>=60000)throw new Error('Instantfind chunk limit exceeded');
      if(!documents.has(row.path)||row.vector.byteLength!==DIMENSIONS*4)throw new Error('Invalid instantfind index row');
      const vector=new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength));
      if(!vector.every(Number.isFinite))throw new Error('Invalid instantfind vector');
      chunks.push({path:row.path,position:row.position,hash:row.hash,vector});
    }
    const value={snapshot:meta.snapshot,revision:stamp,limited:meta.limited==='true',sourceComplete:meta.complete==='true',documents,chunks};
    cached={file,stamp,value};return value;
  }finally{db.close();}
}
export function meaningStatus(index:string){
  const file=meaningPath(index);
  if(!fs.existsSync(file))return {ready:false,index,documents:0,chunks:0,pending:fs.existsSync(file+'.pending'),runtime:instantRuntimeStatus()};
  const data=readIndex(index);
  return {ready:data.snapshot===contentSnapshotId(index),index,documents:data.documents.size,chunks:data.chunks.length,pending:fs.existsSync(file+'.pending'),limited:data.limited,model:INSTANT_MODEL,bytes:fs.statSync(file).size,runtime:instantRuntimeStatus()};
}
export async function indexMeaning(index:string,maxFiles=500,seconds=60,encoder:DocumentEncoder=instantEncoder){
  if(!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>10000||!Number.isFinite(seconds)||seconds<=0||seconds>300)throw new Error('Use 1–10000 files and 1–300 seconds');
  const snapshot=readCachedContent(index,maxFiles),start=performance.now(),deadline=start+seconds*1000;
  const file=meaningPath(index);fs.mkdirSync(INDEX_DIR,{recursive:true,mode:0o700});const unlock=acquireLock(file+'.lock');
  const temporary=file+'.'+randomUUID();let db:Database|undefined;let reused=0,encoded=0,skipped=0,pending=false;
  try {
    const previous=fs.existsSync(file)?new Map(readIndex(index).chunks.map(c=>[c.hash,c.vector])):new Map<string,Float32Array>();
    if(fs.existsSync(file+'.pending'))for(const chunk of readIndex(index,true).chunks)previous.set(chunk.hash,chunk.vector);
    const fd=fs.openSync(temporary,'wx',0o600);fs.closeSync(fd);db=new Database(temporary);
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE files(path TEXT PRIMARY KEY,record TEXT); CREATE TABLE chunks(path TEXT,position INTEGER,text TEXT,hash TEXT,vector BLOB); CREATE INDEX chunk_location ON chunks(path,position); BEGIN IMMEDIATE;');
    const addFile=db.query('INSERT INTO files VALUES (?,?)'),addChunk=db.query('INSERT INTO chunks VALUES (?,?,?,?,?)');
    let documents=0;
    for(const record of snapshot.records){
      if(performance.now()>deadline){pending=true;break;}
      if(!matchesCachedContent(record,parseQuery(''))){skipped++;continue;}
      const texts=documentChunks(record),vectors:Float32Array[]=[];
      if(!texts.length){skipped++;continue;}
      for(let offset=0;offset<texts.length;offset+=4){
        const batch=texts.slice(offset,offset+4),missing=batch.filter(text=>!previous.has(digest(text)));
        if(missing.length){const result=await encoder.encode(missing,'document');if(result.vectors.length!==missing.length||result.vectors.some(v=>v.length!==DIMENSIONS||!v.every(Number.isFinite)))throw new Error('Invalid embedding batch');missing.forEach((text,i)=>previous.set(digest(text),Float32Array.from(result.vectors[i])));encoded+=missing.length;}
        for(const text of batch){vectors.push(previous.get(digest(text))!);reused++;}
      }
      if(!matchesCachedContent(record,parseQuery(''))){skipped++;continue;}
      addFile.run(record.path,JSON.stringify({...record,text:''}));documents++;
      texts.forEach((text,i)=>addChunk.run(record.path,i,text,digest(text),Buffer.from(vectors[i].buffer)));
    }
    if(contentSnapshotId(index)!==snapshot.snapshot)throw new Error('Document cache changed during indexing; previous index retained');
    const meta=db.query('INSERT INTO meta VALUES (?,?)');
    for(const [key,value] of Object.entries({model:INSTANT_MODEL,snapshot:snapshot.snapshot,limited:String(snapshot.limited),complete:String(snapshot.complete),created:new Date().toISOString()}))meta.run(key,value);
    db.exec('COMMIT');db.close();db=undefined;
    const destination=pending?file+'.pending':file;
    fs.renameSync(temporary,destination);cached=undefined;
    if(!pending)fs.rmSync(file+'.pending',{force:true});
    return {index,documents,chunks:reused,encoded,reused:reused-encoded,skipped,pending,limited:snapshot.limited,elapsedMs:performance.now()-start,bytes:fs.statSync(destination).size,model:INSTANT_MODEL};
  }finally{db?.close();fs.rmSync(temporary,{force:true});unlock();}
}
export function clearMeaning(index:string){const release=acquireLock(meaningPath(index)+'.lock');try{fs.rmSync(meaningPath(index),{force:true});fs.rmSync(meaningPath(index)+'.pending',{force:true});cached=undefined;return {index,cleared:true};}finally{release();}}
export async function searchMeaning(index:string,pq:ParsedQuery,limit:number,offset:number,encoder:DocumentEncoder=instantEncoder){
  const empty=(warning:string)=>({paths:[] as string[],complete:false,instantfind:true,snapshot:true,offset,nextOffset:null,warnings:[warning],coverage:{indexed:0,matched:0}});
  if(!pq.meaning?.trim())throw new Error('meaning: requires a document description');
  if(pq.content!==undefined||pq.semantic||pq.mediaFilters.length)throw new Error('meaning: cannot be combined with content: or audio/media filters');
  if(!fs.existsSync(meaningPath(index)))return empty('Prepare document meaning first: fe content index --index NAME, then fe instantfind index --index NAME');
  const data=readIndex(index);
  if(contentSnapshotId(index)!==data.snapshot)return empty('Instantfind index is stale; refresh document contents and meaning explicitly');
  if(encoder===instantEncoder&&!instantRuntimeStatus().ready)return empty('Instantfind runtime is unavailable; run fe instantfind setup --model PATH --python PATH');
  const documents=new Map([...data.documents].filter(([,row])=>matchesCachedContent(row,pq)));
  const key=INSTANT_MODEL+'\n'+pq.meaning;
  let encoded=encoder===instantEncoder?queries.get(key):undefined;
  if(!encoded){encoded=await encoder.encode([pq.meaning],'query');if(encoder===instantEncoder){if(queries.size>=128)queries.delete(queries.keys().next().value!);queries.set(key,encoded);}}
  const vector=encoded.vectors[0];if(vector.length!==DIMENSIONS)throw new Error('Invalid query embedding');
  const best=new Map<string,{path:string;score:number;rankScore:number;position:number;exact:boolean;passage?:string}>();
  for(const chunk of data.chunks){
    if(!documents.has(chunk.path))continue;
    let score=0;for(let i=0;i<DIMENSIONS;i++)score+=vector[i]*chunk.vector[i];
    const name=path.basename(chunk.path).toLowerCase(),term=pq.meaning.toLowerCase();
    const exact=term===name||term===name.slice(0,name.length-path.extname(name).length);
    if(!best.has(chunk.path)||score>best.get(chunk.path)!.score)best.set(chunk.path,{path:chunk.path,score,rankScore:score,position:chunk.position,exact});
  }
  let peakRssMiB=encoded.peakRssMiB;
  const {passages,lexical}=meaningPassages(index,pq.meaning,new Set(best.keys()));
  for(const passage of passages){
    const embedded=await encoder.encode([passage.text],'passage');
    peakRssMiB=Math.max(peakRssMiB,embedded.peakRssMiB);
    const v=embedded.vectors[0];if(v.length!==DIMENSIONS||!v.every(Number.isFinite))throw new Error('Invalid passage embedding');
    let score=0;for(let i=0;i<DIMENSIONS;i++)score+=vector[i]*v[i];
    const row=best.get(passage.path)!;const refined=0.7*score+0.3*row.score;
    if(refined>row.rankScore){row.rankScore=refined;row.passage=passage.text;}
  }
  const ranked=[...best.values()].sort((a,b)=>pq.sort&&pq.sort!=='relevance'?compareSearchProperties(documents.get(a.path)!,documents.get(b.path)!,pq.sort):Number(b.exact)-Number(a.exact)||b.rankScore-a.rankScore||(lexical.get(b.path)||0)-(lexical.get(a.path)||0)||a.path.localeCompare(b.path));
  const currentMatches=ranked.filter(row=>matchesCachedContent(documents.get(row.path)!,pq));
  const selected=currentMatches.slice(offset,offset+limit);
  const snippetsDb=open(meaningPath(index));
  let snippets:{path:string;text:string}[];
  try {const text=snippetsDb.query('SELECT substr(text,1,700) AS text FROM chunks WHERE path=? AND position=?');snippets=selected.map(row=>({path:row.path,text:row.passage||(text.get(row.path,row.position) as {text:string}|null)?.text||''}));}finally{snippetsDb.close();}
  const current=fs.statSync(meaningPath(index));
  if(contentSnapshotId(index)!==data.snapshot||`${current.ino}:${current.size}:${current.mtimeMs}:${current.ctimeMs}`!==data.revision)return empty('Document cache changed during search; retry after refreshing');
  return {paths:selected.map(r=>r.path),scores:selected.map(({path,score})=>({path,similarity:score})),snippets,
    properties:selected.map(r=>({path:r.path,size:documents.get(r.path)!.size,mtime:documents.get(r.path)!.mtime,dir:0})),
    complete:false,instantfind:true,snapshot:true,snapshotId:data.snapshot+':'+INSTANT_MODEL+':'+data.revision,offset,nextOffset:offset+selected.length<currentMatches.length?offset+selected.length:null,
    coverage:{indexed:data.documents.size,eligible:documents.size,matched:currentMatches.length,limited:data.limited},runtime:{pid:encoded.pid,setupMs:encoded.setupMs,peakRssMiB,refinedPassages:passages.length},
    warnings:['Approximate meaning search over cached document excerpts; not exhaustive. Changed or filtered files are excluded.',...(data.limited?['Document preparation limit reached; narrow the index or increase its explicit budget.']:[])]};
}
