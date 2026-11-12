import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {execFile} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {acquireLock,validateName} from './catalog';
import {INDEX_DIR,indexPathFor,findBin,track,matchesSize,compareSearchProperties,type ParsedQuery} from './engine';
import {deltaFor} from './delta';
import {omitted} from './file-filters';
import {relevanceScore} from './search-ranking';

// Contents are a separate, explicitly prepared local cache, never a search-time scan.
const TEXT_LIMIT=2*1024*1024;
const DOCUMENT_LIMIT=32*1024*1024;
const PDF_PAGE_LIMIT=1000;
const MATCH_LIMIT=100000;
const TEXT_EXTENSIONS=new Set('txt md mdx markdown rst org csv tsv json jsonl ndjson yaml yml toml ini xml html htm tex log ts tsx js jsx mjs cjs py rs go swift sh bash zsh fish rb java c h cpp cc hpp css scss sql vue svelte'.split(' '));
const OFFICE_EXTENSIONS=new Set(['rtf','doc','docx','odt','wordml']);
const REMEDY='Run fe content index --index NAME explicitly; search never reads source document bodies or scans folders.';
type ContentQuery=ParsedQuery & {content?:string};
type FileRow={path:string;size:number;mtime:number;ctime:number;ino:number;device:number;status:string;seen:string};
type MatchRow=FileRow & {text:string;rank:number};
export const contentPath=(index:string)=>path.join(INDEX_DIR,`content-${validateName(index)}.sqlite`);

function openCache(index:string,readonly=false):Database {
  const file=contentPath(index);
  if(!readonly) {
    fs.mkdirSync(INDEX_DIR,{recursive:true,mode:0o700});
    try {const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);} catch(error) {if(!(error instanceof Error)||!('code' in error)||error.code!=='EEXIST')throw error;}
  }
  const info=fs.lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077))throw new Error('Unsafe document-content cache: expected an owned private regular file');
  const db=new Database(file,{readonly,create:!readonly});
  db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096;');
  if(!readonly)db.exec(`PRAGMA secure_delete=ON; PRAGMA max_page_count=131072;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,size INTEGER,mtime REAL,ctime REAL,ino INTEGER,device INTEGER,status TEXT,seen TEXT);
    CREATE INDEX IF NOT EXISTS content_seen ON files(seen,status);
    CREATE VIRTUAL TABLE IF NOT EXISTS bodies USING fts5(path UNINDEXED,body,tokenize='unicode61 remove_diacritics 2');`);
  return db;
}
function getMeta(db:Database,key:string):string {return (db.query('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|null)?.value??'';}
function setMeta(db:Database,key:string,value:string|number) {db.query('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key,String(value));}
function transaction(db:Database,action:()=>void) {
  db.exec('BEGIN IMMEDIATE');
  try {action();setMeta(db,'revision',Number(getMeta(db,'revision')||0)+1);db.exec('COMMIT');}
  catch(error) {db.exec('ROLLBACK');throw error;}
}
function sourceState(index:string) {
  const stat=fs.statSync(indexPathFor(index)),delta=deltaFor(index);
  return {stat,delta,stamp:[stat.dev,stat.ino,stat.mtimeMs,stat.ctimeMs,stat.size,delta.revision].join(':')};
}
function sameFile(row:FileRow,stat:fs.Stats) {
  return stat.isFile()&&row.size===stat.size&&row.mtime===stat.mtimeMs&&row.ctime===stat.ctimeMs&&row.ino===stat.ino&&row.device===stat.dev;
}
function errorCode(error:unknown):string {return error instanceof Error&&'code' in error?String(error.code):'';}

async function converted(bytes:Buffer,command:string,args:string[],timeout:number,signal?:AbortSignal,env?:NodeJS.ProcessEnv):Promise<string> {
  return new Promise((resolve,reject)=>{
    const child=track(execFile(command,args,{encoding:'utf8',maxBuffer:TEXT_LIMIT,timeout,killSignal:'SIGKILL',signal,env},(error,stdout)=>{
      if(error)reject(new Error(errorCode(error)==='ENOENT'?'Document text extractor is unavailable':'Document extraction failed, timed out, or exceeded 2 MiB'));
      else resolve(stdout);
    }));
    child.stdin?.on('error',(error:NodeJS.ErrnoException)=>{if(error.code!=='EPIPE')reject(error);});
    child.stdin?.end(bytes);
  });
}
async function extract(file:string,deadline:number,signal?:AbortSignal):Promise<{status:string;text:string;stat?:fs.Stats}> {
  const ext=path.extname(file).slice(1).toLowerCase();
  const supported=TEXT_EXTENSIONS.has(ext)||ext==='pdf'||OFFICE_EXTENSIONS.has(ext);
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||!supported||/(?:^|\/)\.[^/]/.test(file))return {status:'unsupported',text:'',stat};
  if(stat.size>(TEXT_EXTENSIONS.has(ext)?TEXT_LIMIT:DOCUMENT_LIMIT))return {status:'too-large',text:'',stat};
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  let bytes:Buffer;
  try {
    const opened=fs.fstatSync(fd);
    if(!sameFile({path:file,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,ino:stat.ino,device:stat.dev,status:'',seen:''},opened))return {status:'changed',text:'',stat};
    bytes=Buffer.alloc(stat.size+1);let length=0;
    while(length<bytes.length) {const n=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}
    if(length!==stat.size)return {status:'changed',text:'',stat};
    bytes=bytes.subarray(0,length);
  } finally {fs.closeSync(fd);}
  signal?.throwIfAborted();
  let text:string;
  if(TEXT_EXTENSIONS.has(ext)) {
    try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {return {status:'unsupported-encoding',text:'',stat};}
    if(/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text))return {status:'binary',text:'',stat};
  } else {
    const timeout=Math.max(1,Math.min(5000,Math.floor(deadline-performance.now())));
    if(ext==='pdf') {
      const helper=process.env.FE_CONTENT_HELPER??[path.join(path.dirname(fs.realpathSync(process.execPath)),'fe-content-probe'),path.resolve(__dirname,'../app/.build/fe-content-probe')].find(p=>fs.existsSync(p));
      if(helper)text=await converted(bytes,helper,[],timeout,signal);
      else {
        // Probe the same bounded bytes; never silently truncate an oversized PDF.
        const tool=process.env.FE_PDFTOTEXT||findBin('pdftotext');
        const infoTool=process.env.FE_PDFINFO||(path.isAbsolute(tool)?path.join(path.dirname(tool),'pdfinfo'):findBin('pdfinfo'));
        const extractionDeadline=performance.now()+timeout;
        const remaining=()=>{
          const ms=Math.floor(extractionDeadline-performance.now());
          if(ms<=0)throw new Error('PDF extraction timed out');
          return ms;
        };
        const info=await converted(bytes,infoTool,['-enc','UTF-8','-'],remaining(),signal,{...process.env,LC_ALL:'C'});
        const counts=[...info.matchAll(/^Pages:[ \t]*(\d+)[ \t]*\r?$/gm)];
        const pages=counts.length===1?Number(counts[0]?.[1]):NaN;
        if(!Number.isSafeInteger(pages)||pages<1)return {status:'unverified-page-count',text:'',stat};
        if(pages>PDF_PAGE_LIMIT)return {status:'too-many-pages',text:'',stat};
        text=await converted(bytes,tool,['-q','-enc','UTF-8','-nopgbrk','-f','1','-l',String(PDF_PAGE_LIMIT),'-','-'],remaining(),signal);
      }
    }
    else if(process.platform==='darwin')text=await converted(bytes,'/usr/bin/textutil',['-convert','txt','-format',ext,'-stdin','-stdout','-encoding','UTF-8','-noload','-nostore'],timeout,signal);
    else return {status:'extractor-unavailable',text:'',stat};
    if(Buffer.byteLength(text)>TEXT_LIMIT)return {status:'too-large',text:'',stat};
    if(!text.trim())return {status:'no-extractable-text',text:'',stat};
  }
  const current=fs.lstatSync(file);
  if(!sameFile({path:file,size:stat.size,mtime:stat.mtimeMs,ctime:stat.ctimeMs,ino:stat.ino,device:stat.dev,status:'',seen:''},current))return {status:'changed',text:'',stat};
  return {status:'ok',text,stat};
}

export function contentStatus(index:string) {
  if(!fs.existsSync(contentPath(index)))return {exists:false,indexed:0,skipped:0,pending:0,complete:false};
  const db=openCache(index,true);
  try {
    const stamp=getMeta(db,'source');
    const counts=db.query("SELECT count(*) AS total,coalesce(sum(status='ok'),0) AS indexed FROM files WHERE seen=?").get(stamp) as {total:number;indexed:number};
    const current=!!stamp&&sourceState(index).stamp===stamp;
    const traversed=getMeta(db,'complete')==='1';
    return {exists:true,indexed:counts.indexed,skipped:counts.total-counts.indexed,pending:traversed?0:1,complete:current&&traversed&&counts.total===counts.indexed,snapshotCurrent:current};
  } finally {db.close();}
}

export async function indexContents(index:string,maxFiles=500,seconds=60,signal?:AbortSignal) {
  if(!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>10000||!Number.isFinite(seconds)||seconds<=0||seconds>300)throw new Error('Content indexing requires 1–10000 files and at most 300 seconds');
  signal?.throwIfAborted();
  const source=sourceState(index); // An existing path snapshot is mandatory. No implicit index or walk.
  fs.mkdirSync(INDEX_DIR,{recursive:true,mode:0o700});
  const release=acquireLock(contentPath(index)+'.lock');
  let db:Database|undefined;
  try {
    db=openCache(index);const store=db;
    if(getMeta(store,'source')!==source.stamp)transaction(store,()=>{setMeta(store,'source',source.stamp);setMeta(store,'cursor',0);setMeta(store,'addition',0);setMeta(store,'complete',0);});
    if(getMeta(store,'complete')==='1')transaction(store,()=>{setMeta(store,'cursor',0);setMeta(store,'addition',0);setMeta(store,'complete',0);});
    let cursor=Number(getMeta(store,'cursor')||0),addition=Number(getMeta(store,'addition')||0),processed=0,reused=0,skipped=0,stopped=false;
    const deadline=performance.now()+seconds*1000;
    const checkpoint=()=>{setMeta(store,'cursor',cursor);setMeta(store,'addition',addition);};
    const visit=async(file:string)=>{
      if(!file||file.endsWith('/')||!path.isAbsolute(file)||file.length>4096||/[\r\n\0]/.test(file)||!source.delta.visible(file))return;
      signal?.throwIfAborted();
      const cached=store.query('SELECT * FROM files WHERE path=?').get(file) as FileRow|null;
      try {
        const stat=fs.lstatSync(file);
        if(cached?.status==='ok'&&sameFile(cached,stat)) {
          reused++;if(cached.seen!==source.stamp)transaction(store,()=>{store.query('UPDATE files SET seen=? WHERE path=?').run(source.stamp,file);checkpoint();});return;
        }
      } catch(error) {if(!['ENOENT','EACCES','EPERM'].includes(errorCode(error)))throw error;}
      processed++;
      let result:{status:string;text:string;stat?:fs.Stats};
      try {result=await extract(file,deadline,signal);}
      catch(error) {signal?.throwIfAborted();result={status:errorCode(error)==='ENOENT'?'missing':'unreadable-or-extractor-failed',text:''};}
      if(result.status!=='ok')skipped++;
      transaction(store,()=>{
        const stat=result.stat;
        store.query('DELETE FROM bodies WHERE path=?').run(file);
        store.query('INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?,?)').run(file,stat?.size??0,stat?.mtimeMs??0,stat?.ctimeMs??0,stat?.ino??0,stat?.dev??0,result.status,source.stamp);
        if(result.status==='ok')store.query('INSERT INTO bodies(path,body) VALUES (?,?)').run(file,result.text);
        checkpoint();
      });
    };
    if(cursor<source.stat.size) {
      const input=fs.createReadStream(indexPathFor(index),{start:cursor,highWaterMark:65536});
      const lines=createInterface({input,crlfDelay:Infinity});
      try {
        for await(const file of lines) {
          if(processed>=maxFiles||performance.now()>=deadline){stopped=true;break;}
          cursor=Math.min(source.stat.size,cursor+Buffer.byteLength(file)+1);
          await visit(file);
        }
      } finally {lines.close();input.destroy();}
    }
    if(!stopped)for(;addition<source.delta.additions.length;) {
      if(processed>=maxFiles||performance.now()>=deadline){stopped=true;break;}
      const file=source.delta.additions[addition];addition++;
      await visit(file);
    }
    const current=sourceState(index).stamp===source.stamp;
    const done=!stopped&&current;
    transaction(store,()=>{
      checkpoint();setMeta(store,'complete',done?1:0);
      if(done) {
        store.query('DELETE FROM bodies WHERE path IN (SELECT path FROM files WHERE seen<>?)').run(source.stamp);
        store.query('DELETE FROM files WHERE seen<>?').run(source.stamp);
      }
    });
    const status=contentStatus(index);
    return {...status,processed,reused,skipped:status.skipped,pending:done?0:1,remainingUnknown:!done};
  } finally {db?.close();release();}
}

function fuzzyMatches(value:string,token:string) {
  if(token.startsWith("'"))return value.includes(token.slice(1).toLowerCase());
  return token.toLowerCase().split('|').some(term=>{let position=0;for(const c of term){position=value.indexOf(c,position);if(position<0)return false;position++;}return true;});
}
export async function searchContents(index:string,pq:ContentQuery,limit=300,offset=0) {
  const text=pq.content?.trim();
  if(!text||Buffer.byteLength(text)>512||!/[\p{L}\p{N}]/u.test(text)||/[\r\n\0]/.test(text))throw new Error('content: requires a literal word or phrase, at most 512 UTF-8 bytes');
  if(!Number.isInteger(limit)||limit<1||limit>1000||!Number.isInteger(offset)||offset<0||offset>100000000)throw new Error('Invalid content result page');
  if(pq.semantic||pq.mediaFilters.length)throw new Error('content: cannot be combined with audio similarity or media-property filters');
  const empty=(warning:string)=>({paths:[] as string[],snippets:[] as {path:string;text:string}[],complete:false,warnings:[warning],coverage:{matched:0},offset,nextOffset:null,snapshot:true,content:true});
  if(!fs.existsSync(contentPath(index)))return empty('Document content index has not been prepared. '+REMEDY);
  const source=sourceState(index),db=openCache(index,true);
  db.exec('BEGIN');
  try {
    if(getMeta(db,'source')!==source.stamp)return empty('Path snapshot changed; refresh document contents before searching them. '+REMEDY);
    const unknown=(db.query("SELECT count(*) AS n FROM files WHERE seen=? AND status<>'ok'").get(source.stamp) as {n:number}).n;
    // All FTS operators are escaped: the value is one literal phrase, never an FTS program.
    const phrase='"'+text.replaceAll('"','""')+'"';
    const candidates=db.query("SELECT f.*,snippet(bodies,1,'','',' … ',32) AS text,bm25(bodies) AS rank FROM bodies JOIN files f ON f.path=bodies.path WHERE bodies MATCH ? AND f.seen=? AND f.status='ok' ORDER BY bm25(bodies),f.path LIMIT ?").all(phrase,source.stamp,MATCH_LIMIT+1) as MatchRow[];
    const bounded=candidates.length>MATCH_LIMIT;
    const constraints=pq.constraints.map(c=>({pattern:new RegExp(c.pattern,'i'),negate:c.negate}));
    const favorites=pq.favorites?new Set(pq.favorites):undefined;
    const matches:MatchRow[]=[];let invalid=0;
    const deadline=performance.now()+8000;
    for(const row of candidates.slice(0,MATCH_LIMIT)) {
      if(performance.now()>deadline)throw new Error('Content search exceeded 8 seconds; narrow it with name:, in: or ext:');
      const normalized=row.path.normalize('NFC');
      if((favorites&&!favorites.has(row.path))||omitted(row.path,pq.omit)||!constraints.every(c=>c.pattern.test(normalized)!==c.negate)||!pq.fuzzy.every(t=>fuzzyMatches(normalized.toLowerCase(),t)))continue;
      if(!matchesSize(row.size,pq.sizeFilter)||(pq.dmFilter&&Date.now()-row.mtime>=pq.dmFilter.days*86400000))continue;
      try {if(!sameFile(row,fs.lstatSync(row.path))){invalid++;continue;}} catch {invalid++;continue;}
      matches.push(row);
    }
    if(pq.sort&&pq.sort!=='relevance')matches.sort((a,b)=>compareSearchProperties(a,b,pq.sort));
    else if(pq.smart||pq.sort==='relevance')matches.sort((a,b)=>relevanceScore(a.path,pq)-relevanceScore(b.path,pq)||a.rank-b.rank||compareSearchProperties(a,b,'name'));
    const selected=matches.slice(offset,offset+limit),traversed=getMeta(db,'complete')==='1';
    if(sourceState(index).stamp!==source.stamp)return empty('Path snapshot changed during document search. '+REMEDY);
    const warnings=['Cached document text only; refresh contents after edits. No OCR; hidden, binary, unsupported and oversized files are excluded. PDF text uses the bundled helper or pdftotext fallback; Office/RTF requires macOS. Cached text is not exhaustive proof of current filesystem contents.'];
    if(unknown||invalid||!traversed||bounded)warnings.push(`Content coverage: ${unknown} skipped/unreadable, ${invalid} changed/missing matches${!traversed?', preparation unfinished':''}${bounded?', first 100000 FTS matches only':''}. ${REMEDY}`);
    return {paths:selected.map(r=>r.path),snippets:selected.map(r=>({path:r.path,text:r.text})),properties:selected.map(r=>({path:r.path,size:r.size,mtime:r.mtime,dir:0})),
      complete:false,warnings,coverage:{cachedSnapshotComplete:!unknown&&!invalid&&traversed&&!bounded,matched:bounded?null:matches.length,indexed:(db.query("SELECT count(*) AS n FROM files WHERE seen=? AND status='ok'").get(source.stamp) as {n:number}).n,unknown,limited:bounded},
      offset,nextOffset:offset+selected.length<matches.length?offset+selected.length:null,snapshotId:`${source.stamp}:content:${getMeta(db,'revision')}`,snapshot:true,content:true};
  } finally {db.exec('ROLLBACK');db.close();}
}

export async function clearContents(index:string) {
  if(!fs.existsSync(contentPath(index)))return {cleared:true,indexed:0};
  const release=acquireLock(contentPath(index)+'.lock');
  let db:Database|undefined;
  try {
    db=openCache(index);const store=db;
    transaction(store,()=>{store.exec('DELETE FROM bodies; DELETE FROM files; DELETE FROM meta;');});
    store.exec('VACUUM');return {cleared:true,indexed:0};
  } finally {db?.close();release();}
}
