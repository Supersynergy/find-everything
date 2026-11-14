import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CloudScanDiagnostics} from './scan-diagnostics';
import {promisify} from 'node:util';
import {execFile, type ChildProcess} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {searchIndexPath} from './path-search';
import {FD,HOME,INDEX_DIR,indexStatus,track} from './engine';
import {baseStamp,LIVE_PATH_LIMIT,liveMergeThreshold,openLive} from './delta';

type Scope=ReturnType<typeof indexStatus>[number];
const execute=promisify(execFile);
const cloudRoot=path.join(HOME,'Library','CloudStorage');
const below=(p:string,root:string)=>p===root||p.startsWith(root.endsWith('/')?root:root+'/');
const cap=65536;
const page=256;
const providerFor=(p:string)=>below(p,cloudRoot)?p.slice(cloudRoot.length+1).split('/')[0]:'';
export function eligibleDirectory(scope:Scope,p:string) {
  if(!p||path.resolve(p)!==p||p.includes('\0')||p==='/'||p===cloudRoot)return false;
  const root=scope.paths.find(r=>below(p,r));if(!root)return false;
  if(root===p&&!providerFor(p))return false;
  const rel=path.relative(root,p),parts=rel.split('/');
  if(!scope.options.includeHidden&&parts.some(x=>x.startsWith('.')))return false;
  return !scope.exclusions.some(e=>e.startsWith('/')?below(rel,e.slice(1)):new Bun.Glob(e).match(rel)||parts.some(x=>new Bun.Glob(e).match(x)));
}
export function initDirectoryRetries(db:Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS directory_retries(scope TEXT,path TEXT,stamp TEXT,source TEXT,provider TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,attempts INTEGER NOT NULL DEFAULT 0,retryAt INTEGER NOT NULL DEFAULT 0,cursor TEXT NOT NULL DEFAULT '',problem TEXT,PRIMARY KEY(scope,path));
    CREATE INDEX IF NOT EXISTS directory_retries_due ON directory_retries(scope,retryAt);
    CREATE TABLE IF NOT EXISTS directory_retry_providers(scope TEXT,provider TEXT,failures INTEGER,retryAt INTEGER,PRIMARY KEY(scope,provider));
    CREATE TABLE IF NOT EXISTS directory_retry_seeds(scope TEXT,stamp TEXT,source TEXT,PRIMARY KEY(scope,stamp,source))`);
}
export function queueDirectory(db:Database,scope:Scope,p:string,stamp:string,source:string) {
  if(!eligibleDirectory(scope,p))return false;
  if(source==='event'){
    db.query(`INSERT INTO directory_retries(scope,path,stamp,source,provider) VALUES (?,?,?,?,?)
      ON CONFLICT(scope,path) DO UPDATE SET generation=generation+1, cursor='', stamp=excluded.stamp`).run(scope.name,p,stamp,source,providerFor(p));
    return true;
  }
  db.query('INSERT OR IGNORE INTO directory_retries(scope,path,stamp,source,provider) VALUES (?,?,?,?,?)').run(scope.name,p,stamp,source,providerFor(p));
  return db.query('SELECT changes() AS n').get().n===1;
}
export function seedScanDirectories(db:Database,scope:Scope,stamp:string,source:string,paths:string[]) {
  if(!db.inTransaction)throw Error('Seed must share the generation transaction');
  if(db.query('SELECT 1 FROM directory_retry_seeds WHERE scope=? AND stamp=? AND source=?').get(scope.name,stamp,source))return 0;
  if(paths.length>20000)throw Error('Directory diagnostic list exceeds 20000 entries');
  let added=0;
  for(const p of new Set(paths))if(typeof p==='string'&&below(p,cloudRoot)&&p!==cloudRoot&&queueDirectory(db,scope,p,stamp,source))added++;
  db.query('INSERT INTO directory_retry_seeds VALUES (?,?,?)').run(scope.name,stamp,source);
  return added;
}
export function retryCommand(name:string,args:string[]) {
  const scope=indexStatus().find(s=>s.name===name&&s.exists&&!s.configurationChanged);
  if(!scope)throw Error('No current configured snapshot for directory recovery');
  if(args.length&&!(args[0]==='import'&&args.length===2))throw Error('Usage: fe retries [import FD-DIAGNOSTICS] --index NAME');
  const db=openLive();try{
    initDirectoryRetries(db);
    let imported=0;
    if(args.length){
      const input=fs.openSync(args[1],'r');
      let text:string;
      try{const st=fs.fstatSync(input);if(!st.isFile()||st.size>8*1024*1024)throw Error('Expected a diagnostic file of at most 8 MiB');text=fs.readFileSync(input,'utf8');}finally{fs.closeSync(input);}
      const diagnostics=new CloudScanDiagnostics(scope.paths,cloudRoot);
      diagnostics.push(text);
      const parsed=diagnostics.finish();
      if(parsed.retryDirectoriesTruncated)throw Error('Import exceeds diagnostic directory budget');
      const rows=parsed.retryDirectories;
      db.exec('BEGIN IMMEDIATE');try{
        const stamp=baseStamp(scope.name);
        if(db.query('SELECT stamp FROM scopes WHERE name=?').get(name)?.stamp!==stamp)throw Error('Start the watcher for this index before importing diagnostics');
        imported=seedScanDirectories(db,scope,stamp,'import:'+createHash('sha256').update(text).digest('hex'),rows);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    }
    const summary=db.query(`SELECT count(*) AS pending,min(max(r.retryAt,coalesce(t.retryAt,0))) AS nextRetryAt,
      max(r.attempts) AS maxAttempts,count(distinct CASE WHEN t.retryAt>? THEN r.provider END) AS pausedProviders
      FROM directory_retries r LEFT JOIN directory_retry_providers t ON t.scope=r.scope AND t.provider=r.provider
      WHERE r.scope=?`).get(Date.now(),name);
    return {index:name,imported,...summary};
  }finally{db.close();}
}
type Listing={paths:string[];directories:Set<string>;kind:'directory'|'absent'|'file'};
// All provider-facing stats and enumeration run in a killable subprocess. A
// blocked FileProvider syscall must never hold the live worker's single retry lane.
export async function directoryListingChild(payload:string) {
  const {p,scope}=JSON.parse(payload) as {p:string;scope:Scope};
  const empty=(kind:Listing['kind'])=>console.log(JSON.stringify({paths:[],directories:[],kind}));
  let before:fs.Stats;
  try{before=fs.lstatSync(p);}catch(e){
    // A missing/offline provider mount must retain previously known files.
    if(!below(p,cloudRoot)&&['ENOENT','ENOTDIR'].includes(e.code))return empty('absent');
    throw e;
  }
  if(fs.realpathSync(path.dirname(p))!==path.dirname(p))throw Error('Directory has a symbolic-link ancestor');
  if(!before.isDirectory()){
    if(providerFor(p)&&path.dirname(p)===cloudRoot)throw Error('Cloud provider root unavailable');
    return empty('file');
  }
  if(fs.realpathSync(p)!==p)throw Error('Directory has a symbolic-link ancestor');
  let paths:string[],directories:string[];
  if(scope.options.includeIgnored){
    paths=[];directories=[];
    const dir=fs.opendirSync(p);
    try{
      for(let entry=dir.readSync();entry;entry=dir.readSync()){
        if(paths.length>=cap)throw Error('Directory exceeds '+cap+' direct entries');
        if(entry.name.includes('\uFFFD'))throw Error('Directory contains ambiguous UTF-8 name');
        const name=path.join(p,entry.name);
        if(!eligibleDirectory(scope,name))continue;
        paths.push(name);if(entry.isDirectory())directories.push(name);
      }
    }finally{dir.closeSync();}
  }else{
    const args=['--absolute-path','--color=never','--print0','--show-errors','--threads','1','--max-depth','1','--max-results',String(cap+1)];
    if(scope.options.includeHidden)args.push('--hidden');
    for(const ex of scope.exclusions)args.push('--exclude',ex);
    const run=async (folder:string)=>{
      const t=execute(FD,[...args,'--','',folder],{encoding:'buffer',timeout:1400,maxBuffer:8*1024*1024,killSignal:'SIGKILL'});
      const r=await t;if(r.stderr.length)throw Error('Incomplete directory listing: '+r.stderr.toString().slice(-180));
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(r.stdout).split('\0');
      if(raw.pop()!==''||raw.length>cap)throw Error('Directory listing exceeded its budget');
      return raw;
    };
    if(!(await run(path.dirname(p))).includes(p+'/'))throw Error('Directory not confirmed by ignore rules');
    const raw=await run(p);paths=raw.map(x=>x.replace(/\/$/, '')).filter(x=>eligibleDirectory(scope,x));
    directories=raw.filter(x=>x.endsWith('/')).map(x=>x.slice(0,-1)).filter(x=>eligibleDirectory(scope,x));
  }
  const after=fs.lstatSync(p);
  if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw Error('Directory changed during enumeration');
  console.log(JSON.stringify({paths,directories,kind:'directory'}));
}
declare const Bun:{Glob:new(pattern:string)=>{match(value:string):boolean};main:string};
const activeHelpers=new Set<ChildProcess>();
async function listDirectory(p:string,scope:Scope):Promise<Listing>{
  if(activeHelpers.size>=2)throw Error('Previous provider helpers still exiting');
  const args=Bun.main.includes('$bunfs')?[]:[path.join(__dirname,'cli.ts')];
  const task=execute(process.execPath,[...args,'_directory-list',JSON.stringify({p,scope:{paths:scope.paths,options:scope.options,exclusions:scope.exclusions}})],{timeout:3500,maxBuffer:16*1024*1024,killSignal:'SIGKILL'});
  track(task.child);activeHelpers.add(task.child);task.child.once('close',()=>activeHelpers.delete(task.child));
  // execFile normally waits for the killed process to exit. Stop waiting for a
  // kernel-blocked mount, but keep at most two unreaped helper processes.
  let timer:ReturnType<typeof setTimeout>;
  try{
    const result=await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Directory provider timed out')),3700);})]);
    const row=JSON.parse(result.stdout);
    return {...row,directories:new Set<string>(row.directories)};
  }catch(error){
    // execFile's wrapper includes the entire command line. Persist the helper's
    // filesystem diagnostic, including the cause reported by the provider.
    const reason=String(error.stderr??'').trim();
    throw Error(reason || (error.signal ? 'Directory listing stopped: '+error.signal : error.message));
  }finally{clearTimeout(timer);}
}
function conflictingEvent(db:Database,name:string,p:string,rev:number){
  for(const table of ['changes','merged_changes','tree_barriers']){
    const query=db.query('SELECT 1 FROM '+table+' WHERE scope=? AND path>=? AND path<? AND revision>? LIMIT 1');
    if(query.get(name,p+'/',p+'0',rev))return true;
    const ancestor=db.query('SELECT 1 FROM '+table+' WHERE scope=? AND path=? AND revision>?'+(table==='tree_barriers'?'':' AND (tree=1 OR path=?)')+' LIMIT 1');
    for(let a=p;;a=path.dirname(a)){
      if(ancestor.get(...(table==='tree_barriers'?[name,a,rev]:[name,a,rev,p])))return true;
      if(a==='/')break;
    }
  }return false;
}
/** Only completed directory listings produce membership differences. Pages and
 * their continuation cursor commit together. Newer overlapping events win. */
export async function recoverDirectory(db:Database,scope:Scope,listing=listDirectory,now=Date.now()) {
  const job=db.query(`SELECT r.* FROM directory_retries r WHERE r.scope=? AND r.retryAt<=?
    AND NOT EXISTS(SELECT 1 FROM directory_retry_providers t WHERE t.scope=r.scope AND t.provider=r.provider AND t.retryAt>?)
    ORDER BY r.retryAt,r.path LIMIT 1`).get(scope.name,now,now);
  if(!job)return false;
  const stamp=baseStamp(scope.name);
  if(scope.configurationChanged)return false;
  if(job.stamp!==stamp||!eligibleDirectory(scope,job.path)){
    db.query('DELETE FROM directory_retries WHERE scope=? AND path=? AND stamp=? AND generation=?').run(scope.name,job.path,job.stamp,job.generation);
    return true;
  }
  const state=db.query('SELECT revision FROM scopes WHERE name=? AND stamp=?').get(scope.name,stamp);
  if(!state)return false;
  const p:string=job.path;
  let enumerated=false;
  try{
    const listingResult=await listing(p,scope);
    enumerated=true;
    db.exec('BEGIN IMMEDIATE');
    try{
      const scopeRow=db.query('SELECT stamp,revision FROM scopes WHERE name=?').get(scope.name);
      if(scopeRow?.stamp!==stamp||baseStamp(scope.name)!==stamp||
        db.query('SELECT generation FROM directory_retries WHERE scope=? AND path=?').get(scope.name,p)?.generation!==job.generation||
        conflictingEvent(db,scope.name,p,state.revision))throw Error('Directory recovery superseded by filesystem changes');
      const prefix=p+'/',current=new Map<string,boolean>();
      for(const child of listingResult.paths){
        if(path.dirname(child)!==p)throw Error('Invalid direct child in directory listing');
        current.set(child,listingResult.directories.has(child));
      }
      const lookup=new Database(searchIndexPath(scope.name),{readonly:true});
      const known=new Map<string,boolean>(),seen=new Set<string>();
      let prepared:number, parentKnown:boolean,parentDirectory:boolean;
      try{
        lookup.exec('PRAGMA busy_timeout=250; BEGIN');
        const meta=Object.fromEntries(lookup.query("SELECT key,value FROM meta WHERE key IN ('ready','source','liveRevision','syncPartialRevision')").all().map(x=>[x.key,x.value]));
        if(meta.ready!=='1'||meta.source!==stamp||Number(meta.syncPartialRevision)>0)throw Error('Current prepared lookup required');
        prepared=Number(meta.liveRevision);
        const rows=lookup.query('SELECT name,dir,slash FROM files WHERE parent=(SELECT id FROM directories WHERE path=?) AND name>? ORDER BY name LIMIT ?').all(prefix,job.cursor,page+1);
        for(const row of rows){seen.add(prefix+row.name);known.set(prefix+row.name,Boolean(row.dir||row.slash));}
        const parentRow=lookup.query('SELECT dir,slash FROM files WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=?').get(path.dirname(p).replace(/\/$/,'')+'/',path.basename(p));
        parentKnown=!!parentRow;parentDirectory=Boolean(parentRow?.dir||parentRow?.slash);
      }finally{lookup.close();}
      // Pending direct-child changes use the primary path index. Skip entire
      // descendants by seeking to the byte immediately after their slash prefix.
      const over=new Map<string,{present:number;revision:number;tree:number}>();
      for(const table of ['changes','merged_changes']){
        const seek=db.query('SELECT path,present,tree,revision FROM '+table+' WHERE scope=? AND path>=? AND path<? ORDER BY path LIMIT 1');
        let low=job.cursor?prefix+job.cursor+'\u0001':prefix;
        let last='';
        for(let i=0;i<(page+2)*2;i++){
          const row=seek.get(scope.name,low,p+'0');if(!row)break;
          const rest=row.path.slice(prefix.length),slash=rest.indexOf('/');
          const direct=slash===-1?row.path:prefix+rest.slice(0,slash);
          if(direct!==last&&Buffer.compare(Buffer.from(direct),Buffer.from(prefix+job.cursor))>0)seen.add(direct);
          last=direct;
          // The immediate next byte value after slash is '0'. The inclusive
          // seek preserves a legitimate sibling named '<child>0'.
          low=slash===-1?row.path+'\u0001':direct+'0';
          if(slash===-1&&row.revision>prepared&&row.revision>(over.get(row.path)?.revision??-1))over.set(row.path,row);
        }
      }
      let cutoff=0,ancestorCutoff=0;
      for(let a=p;;a=path.dirname(a)){
        for(const t of ['changes','merged_changes','tree_barriers']){
          const x=db.query('SELECT revision FROM '+t+' WHERE scope=? AND path=?'+(t==='tree_barriers'?'':' AND tree=1')).get(scope.name,a);
          cutoff=Math.max(cutoff,x?.revision??0);if(a!==p)ancestorCutoff=Math.max(ancestorCutoff,x?.revision??0);
        }
        if(a==='/')break;
      }
      if(cutoff>prepared)known.clear();
      for(const [key,e] of over){if(e.present&&e.revision>=cutoff)known.set(key,Boolean(e.tree));else known.delete(key);}
      let parentRevision=prepared;
      for(const t of ['merged_changes','changes']){
        const r=db.query('SELECT present,revision FROM '+t+' WHERE scope=? AND path=?').get(scope.name,p);
        if(r&&r.revision>parentRevision){parentKnown=!!r.present;parentRevision=r.revision;}
      }
      if(ancestorCutoff>parentRevision)parentKnown=false;
      const cursor=Buffer.from(prefix+job.cursor);
      const keys=[...new Set([...seen,...current.keys()])].filter(k=>Buffer.compare(Buffer.from(k),cursor)>0).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
      const more=keys.length>page;
      const differences:{p:string;present:number;tree:number}[]=[];
      const present=listingResult.kind!=='absent';
      if(!scope.paths.includes(p)&&!job.cursor&&(parentKnown!==present||listingResult.kind==='file'&&parentDirectory))
        differences.push({p,present:Number(present),tree:Number(listingResult.kind!=='directory')});
      for(const item of keys.slice(0,page)){
        const exists=current.has(item),isDirectory=current.get(item)===true;
        if(isDirectory)queueDirectory(db,scope,item,stamp,'child');
        if(known.has(item)!==exists||(!isDirectory&&known.get(item)===true))
          differences.push({p:item,present:Number(exists),tree:Number(!exists||known.get(item)===true&&!isDirectory)});
      }
      if(differences.length){
        const revision=scopeRow.revision+1;
        const count=db.query('SELECT count(*) AS n FROM changes WHERE scope=?').get(scope.name).n;
        const table=count+differences.length<=LIVE_PATH_LIMIT?'changes':'merged_changes';
        const put=db.query('INSERT INTO '+table+' VALUES (?,?,?,?,?) ON CONFLICT(scope,path) DO UPDATE SET present=excluded.present,tree=excluded.tree,revision=excluded.revision');
        const barrier=db.query('INSERT INTO tree_barriers VALUES (?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=max(revision,excluded.revision)');
        const media=!job.provider&&fs.existsSync(path.join(INDEX_DIR,'media-'+scope.name+'.sqlite'));
        for(const e of differences){
          const hot=db.query('SELECT tree,revision FROM changes WHERE scope=? AND path=?').get(scope.name,e.p);
          if(hot?.tree)barrier.run(scope.name,e.p,hot.revision);
          if(table==='merged_changes')db.query('DELETE FROM changes WHERE scope=? AND path=?').run(scope.name,e.p);
          put.run(scope.name,e.p,e.present,e.tree,revision);
          if(e.tree)barrier.run(scope.name,e.p,revision);
          if(media&&/\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|png|jpe?g|webp)$/i.test(e.p))db.query('INSERT OR IGNORE INTO jobs(scope,path) VALUES (?,?)').run(scope.name,e.p);
        }
        if(count+differences.length>=liveMergeThreshold())db.query('INSERT OR IGNORE INTO merge_queue VALUES (?,?)').run(scope.name,revision);
        db.query('UPDATE scopes SET revision=?,lastChange=? WHERE name=?').run(revision,new Date(now).toISOString(),scope.name);
      }
      if(job.provider)db.query('DELETE FROM directory_retry_providers WHERE scope=? AND provider=?').run(scope.name,job.provider);
      if(more)db.query('UPDATE directory_retries SET cursor=?,attempts=0,retryAt=0,problem=NULL WHERE scope=? AND path=?').run(path.basename(keys[page-1]),scope.name,p);
      else db.query('DELETE FROM directory_retries WHERE scope=? AND path=?').run(scope.name,p);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }catch(e){
    // A failed provider listing may surface as EIO, an empty child error
    // or a translated message. Bound retries across sibling paths in all cases.
    if(job.provider && !enumerated){
      const failures=1+(db.query('SELECT failures FROM directory_retry_providers WHERE scope=? AND provider=?').get(scope.name,job.provider)?.failures??0);
      const until=now+Math.min(3600000,30000*2**Math.min(7,failures-1));
      db.query('INSERT INTO directory_retry_providers VALUES (?,?,?,?) ON CONFLICT(scope,provider) DO UPDATE SET failures=excluded.failures,retryAt=excluded.retryAt').run(scope.name,job.provider,failures,until);
    }
    const seconds=Math.min(6*3600,30*2**Math.min(job.attempts,10));
    db.query('UPDATE directory_retries SET attempts=attempts+1,retryAt=?,problem=? WHERE scope=? AND path=? AND stamp=? AND generation=?')
      .run(now+seconds*1000,String(e.message).slice(0,240),scope.name,p,stamp,job.generation);
  }
  return true;
}
