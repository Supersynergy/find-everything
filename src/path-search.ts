import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { acquireLock, validateName } from './catalog';
import { INDEX_DIR, indexPathFor, ParsedQuery } from './engine';
import { baseStamp, deltaFor, livePath } from './delta';
import {omissionRules,omitted,NOISE_NAMES,NOISE_SUFFIXES} from './file-filters';
import {relevanceOrder,relevanceScore} from './search-ranking';

export const searchIndexPath = (index:string) => path.join(INDEX_DIR,`search-${validateName(index)}.sqlite`);
const VERSION='2';
const FULL="d.path || f.name || CASE WHEN f.slash=1 THEN '/' ELSE '' END";
type RowSet={table:string;count:number};
const connections=new Map<string,{db:Database;stamp:string;revision:string;directoryCounts:Map<string,number>;counts:Map<string,{total:number;known:number;matched:number}>;sets:Map<string,RowSet|null>;seeds:Map<string,boolean>;sequence:number;directories:number;rows:number}>();
let propertyConnection:{index:string;stamp:string;db:Database}|undefined;
const getMeta=(db:Database,key:string)=>db.query('SELECT value FROM meta WHERE key=?').get(key)?.value;
const directChanges=(db:Database):number=>db.query('SELECT changes() AS n').get().n;
const setMeta=(db:Database,key:string,value:string|number)=>db.query('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key,String(value));
function tune(db:Database) {db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY; PRAGMA threads=1;');}
// Readers keep the whole accelerator reachable through one mapping instead of
// copying every trigram page through read(2); the page cache grows to 64 MiB so
// repeated keystrokes stop re-reading the same B-tree and FTS pages.
function tuneReader(db:Database) {db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY; PRAGMA threads=1; PRAGMA mmap_size=2147483648;');}
function closeCached(index:string) {const c=connections.get(index);if(c){c.db.close();connections.delete(index);}}
function closeProperties(index:string){if(propertyConnection?.index===index){propertyConnection.db.close();propertyConnection=undefined;}}
function openProperties(index:string):Database|undefined {
  const file=searchIndexPath(index);if(!fs.existsSync(file))return;
  const stat=fs.statSync(file),source=baseStamp(index),stamp=`${stat.mtimeMs}:${stat.size}:${source}`;
  if(propertyConnection?.index===index&&propertyConnection.stamp===stamp)return propertyConnection.db;
  if(propertyConnection)closeProperties(propertyConnection.index);
  const db=new Database(file,{readonly:true});
  try {
    tune(db);db.exec('PRAGMA cache_size=-1024');
    if(getMeta(db,'version')!==VERSION||getMeta(db,'source')!==source||getMeta(db,'ready')!=='1'){db.close();return;}
    propertyConnection={index,stamp,db};return db;
  }catch(e){db.close();throw e;}
}
const damagedCache=(e:any)=>['SQLITE_CORRUPT','SQLITE_NOTADB'].includes(e.code)||/not a database|database disk image is malformed|no such table: (meta|files|directories)/i.test(String(e.message));
function splitPath(p:string) {const clean=p.replace(/\/$/,'')||'/';return {parent:path.dirname(clean).replace(/\/$/,'')+'/',name:path.basename(clean),slash:p.endsWith('/')&&p!=='/'?1:0};}
function openReady(index:string):Database|undefined {
  const file=searchIndexPath(index);if(!fs.existsSync(file))return;
  const s=fs.statSync(file),stamp=`${s.mtimeMs}:${s.size}:${baseStamp(index)}`;
  const previous=connections.get(index);if(previous?.stamp===stamp){connections.delete(index);connections.set(index,previous);return previous.db;}
  closeCached(index);
  const db=new Database(file,{readonly:true});
  try {
    tuneReader(db);
    if(getMeta(db,'version')!==VERSION||getMeta(db,'source')!==baseStamp(index)||getMeta(db,'ready')!=='1'){db.close();return;}
    while(connections.size>=3)closeCached(connections.keys().next().value!);
    const stored=getMeta(db,'indexedRows'),valid=getMeta(db,'rowCountVersion')==='1'&&/^\d+$/.test(stored??'')&&Number.isSafeInteger(Number(stored));
    const context={db,stamp,revision:'',directoryCounts:new Map<string,number>(),counts:new Map<string,{total:number;known:number;matched:number}>(),sets:new Map<string,RowSet|null>(),seeds:new Map<string,boolean>(),sequence:0,directories:-1,rows:valid?Number(stored):db.query('SELECT count(*) AS n FROM files').get().n};
    connections.set(index,context);return db;
  } catch(e){db.close();throw e;}
}
function schema(db:Database,source:string) {
  tune(db);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE directories(id INTEGER PRIMARY KEY,path TEXT UNIQUE,pathKey TEXT NOT NULL);
    CREATE TABLE files(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL,name TEXT NOT NULL,nameKey TEXT NOT NULL,slash INTEGER DEFAULT 0,size INTEGER,mtime REAL,dir INTEGER,UNIQUE(parent,name));
    CREATE INDEX file_names ON files(nameKey,id);
    CREATE INDEX file_size ON files(size,id);
    CREATE INDEX file_modified ON files(mtime,id);
    CREATE VIRTUAL TABLE names_fts USING fts5(nameKey,content=files,content_rowid=id,tokenize=trigram,columnsize=0);
    CREATE VIRTUAL TABLE directories_fts USING fts5(pathKey,content=directories,content_rowid=id,tokenize=trigram,columnsize=0);
    CREATE TRIGGER directory_added AFTER INSERT ON directories BEGIN INSERT INTO directories_fts(rowid,pathKey) VALUES(new.id,new.pathKey); END;
    CREATE TRIGGER file_added AFTER INSERT ON files BEGIN INSERT INTO names_fts(rowid,nameKey) VALUES(new.id,new.nameKey); END;
    CREATE TRIGGER file_removed AFTER DELETE ON files BEGIN INSERT INTO names_fts(names_fts,rowid,nameKey) VALUES('delete',old.id,old.nameKey); END;`);
  db.transaction(()=>{for(const [key,value] of Object.entries({version:VERSION,source,offset:'0',rows:'0',ready:'0',liveRevision:'0',propertiesRevision:'0'}))setMeta(db,key,value);})();
}
function inserter(db:Database) {
  const parents=new Map<string,number>(), addParent=db.query('INSERT OR IGNORE INTO directories(path,pathKey) VALUES (?,?)'),findParent=db.query('SELECT id FROM directories WHERE path=?');
  const add=db.query('INSERT OR IGNORE INTO files(parent,name,nameKey,slash) VALUES (?,?,?,?)');
  return (p:string)=>{
    const s=splitPath(p);let id=parents.get(s.parent);
    if(id===undefined){addParent.run(s.parent,s.parent.toLowerCase());id=findParent.get(s.parent).id;if(parents.size>=8192)parents.delete(parents.keys().next().value!);parents.set(s.parent,id!);}
    add.run(id,s.name,s.name.toLowerCase(),s.slash);return directChanges(db);
  };
}

function orderedIndexes(db:Database) {
  db.exec('CREATE INDEX IF NOT EXISTS directory_names ON directories(pathKey,id); CREATE INDEX IF NOT EXISTS parent_names ON files(parent,nameKey,id);');
  setMeta(db,'ordered',1);
  if(getMeta(db,'rowCountVersion')!=='1'){setMeta(db,'indexedRows',db.query('SELECT count(*) AS n FROM files').get().n);setMeta(db,'rowCountVersion',1);}
}

function reuseMediaProperties(index:string,db:Database) {
  const file=path.join(INDEX_DIR,`media-${validateName(index)}.sqlite`);if(!fs.existsSync(file))return;
  const media=new Database(file,{readonly:true});
  try {
    if(getMeta(media,'indexStamp')!==baseStamp(index))return;
    const update=db.query('UPDATE files SET size=?,mtime=?,dir=? WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=? AND size IS NULL AND mtime IS NULL');
    let reused=0;
    db.transaction(()=>{
      for(const r of media.query('SELECT path,size,mtime,status FROM files WHERE size IS NOT NULL AND mtime IS NOT NULL LIMIT 100000').iterate()){
        const s=splitPath(r.path);reused+=update.run(r.size,r.mtime,r.status==='ok'?0:null,s.parent,s.name).changes;
      }
      if(reused)setMeta(db,'propertiesRevision',Number(getMeta(db,'propertiesRevision'))+1);
    })();
  }finally{media.close();}
}

export async function prepareSearch(index:string,seconds=60,maxRows=10000000) {
  const result=await prepareSnapshot(index,seconds,maxRows);
  if(result.ready){syncSearch(index);return {...result,...searchIndexStatus(index)};}
  return result;
}

async function prepareSnapshot(index:string,seconds:number,maxRows:number) {
  const file=searchIndexPath(index),source=baseStamp(index);
  let ready:Database|undefined;
  try{ready=openReady(index);}catch(e){if(!damagedCache(e))throw e;}
  if(ready){
    if(getMeta(ready,'ordered')!=='1'||getMeta(ready,'rowCountVersion')!=='1'){const release=acquireLock(file+'.lock');closeCached(index);const db=new Database(file);tune(db);try{orderedIndexes(db);}finally{db.close();release();}}
    return {...searchIndexStatus(index),reused:true};
  }
  const release=acquireLock(file+'.lock'),stage=file+'.building';let db:Database|undefined;
  const started=performance.now(),deadline=started+seconds*1000;
  try {
    if(fs.existsSync(stage)) {
      try {db=new Database(stage);if(getMeta(db,'source')!==source||getMeta(db,'version')!==VERSION){db.close();db=undefined;}}
      catch(e){db?.close();db=undefined;if(!damagedCache(e))throw e;}
      if(!db)for(const suffix of ['', '-wal','-shm'])fs.rmSync(stage+suffix,{force:true});
    }
    if(!db){db=new Database(stage,{create:true});schema(db,source);}else tune(db);
    let offset=Number(getMeta(db,'offset')),rows=Number(getMeta(db,'rows')),processed=0;
    const stream=fs.createReadStream(indexPathFor(index),{start:offset,highWaterMark:256*1024}),lines=createInterface({input:stream,crlfDelay:Infinity});
    const add=inserter(db),batch:string[]=[];
    const commit=()=>{if(!batch.length)return;db!.transaction(()=>{for(const p of batch)add(p);setMeta(db!,'offset',offset);setMeta(db!,'rows',rows);})();batch.length=0;};
    let finished=true;
    try {
      for await(const p of lines) {
        if(p.length>1024*1024)throw new Error('Indexed path exceeds 1 MiB');
        offset+=Buffer.byteLength(p)+1;if(p){batch.push(p);rows++;processed++;}
        if(batch.length>=1024){commit();if(fs.statSync(stage).size>6*1024**3)throw new Error('Search accelerator exceeds 6 GiB; use a narrower profile');await new Promise<void>(r=>setImmediate(r));}
        if(processed>=maxRows||performance.now()>=deadline){finished=false;break;}
      }
      commit();
    } finally {lines.close();stream.destroy();}
    if(baseStamp(index)!==source)throw new Error('Path snapshot changed during preparation; retry to use the new snapshot');
    if(finished||offset>=fs.statSync(indexPathFor(index)).size) {
      reuseMediaProperties(index,db);orderedIndexes(db);setMeta(db,'ready',1);db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');db.close();db=undefined;closeCached(index);fs.renameSync(stage,file);
      return {...searchIndexStatus(index),processed,elapsedMs:Math.round(performance.now()-started)};
    }
    return {ready:false,index,processed,rows,bytesRead:offset,totalBytes:fs.statSync(indexPathFor(index)).size,elapsedMs:Math.round(performance.now()-started),resumable:true};
  } finally {db?.close();release();}
}

export function searchIndexStatus(index:string) {
  const db=openReady(index);if(!db)return {index,ready:false};
  return {index,ready:true,rows:connections.get(index)!.rows,
    propertiesKnown:db.query('SELECT count(*) AS n FROM files WHERE size IS NOT NULL AND mtime IS NOT NULL').get().n,
    bytes:fs.statSync(searchIndexPath(index)).size,liveRevision:Number(getMeta(db,'liveRevision')),propertiesRevision:Number(getMeta(db,'propertiesRevision'))};
}

export function cachedFileProperties(index:string,p:string) {
  const db=openProperties(index);if(!db)return;
  const s=splitPath(p);
  return db.query('SELECT size,mtime,dir FROM files WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=?').get(s.parent,s.name);
}

export function syncSearch(index:string) {
  const current=openProperties(index);if(!current||!fs.existsSync(livePath()))return;
  const source=baseStamp(index),after=Number(getMeta(current,'liveRevision'));
  const live=new Database(livePath(),{readonly:true});let changes:any[],revision:number;
  try {
    live.exec('BEGIN');
    const state=live.query('SELECT revision FROM scopes WHERE name=? AND stamp=?').get(index,source);
    if(!state||state.revision===after)return;
    revision=state.revision;
    changes=live.query('SELECT path,present,tree,revision FROM changes WHERE scope=? AND revision>? ORDER BY revision,path').all(index,after);
  } finally {live.close();}
  if(changes.length>100000)throw new Error('Search accelerator has over 100000 pending changes; prepare it again explicitly');
  const file=searchIndexPath(index),release=acquireLock(file+'.lock');let db:Database|undefined;
  try {
    closeCached(index);closeProperties(index);db=new Database(file);tune(db);
    if(getMeta(db,'source')!==source)return;
    const committed=Number(getMeta(db,'liveRevision'));if(committed>=revision)return;
    let rowCount=getMeta(db,'rowCountVersion')==='1'?Number(getMeta(db,'indexedRows')):db.query('SELECT count(*) AS n FROM files').get().n;
    const add=inserter(db),remove=db.query('DELETE FROM files WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=?');
    const metadata=db.query('UPDATE files SET size=?,mtime=?,dir=?,slash=CASE WHEN ?=0 THEN 0 ELSE slash END WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=?');
    db.transaction(()=>{
      for(const c of changes){if(c.revision<=committed)continue;const s=splitPath(c.path);
        if(c.tree){const prefix=c.path.replace(/\/$/,'')+'/';db.query('DELETE FROM files WHERE parent IN (SELECT id FROM directories WHERE path=? OR substr(path,1,?)=?)').run(prefix,prefix.length,prefix);rowCount-=directChanges(db);}
        if(!c.present){remove.run(s.parent,s.name);rowCount-=directChanges(db);}
        else {rowCount+=add(c.path);try{const stat=fs.statSync(c.path),directory=Number(stat.isDirectory());metadata.run(stat.size,stat.mtimeMs,directory,directory,s.parent,s.name);}catch(e){if(!['ENOENT','ENOTDIR','EACCES','EPERM'].includes(e.code))throw e;}}
      }
      setMeta(db,'liveRevision',revision);setMeta(db,'propertiesRevision',Number(getMeta(db,'propertiesRevision'))+1);
      setMeta(db,'indexedRows',rowCount);
      setMeta(db,'rowCountVersion',1);
    })();
  } finally {db?.close();release();}
}

export async function indexProperties(index:string,maxFiles=10000,seconds=60) {
  if(!openReady(index)){const result=await prepareSearch(index,seconds);if(!result.ready)return {...result,propertiesPending:true};}
  syncSearch(index);
  const file=searchIndexPath(index),release=acquireLock(file+'.lock');closeCached(index);const db=new Database(file);tune(db);
  const start=performance.now();let inspected=0,failed=0;
  try {
    const rows=db.query(`SELECT f.id,${FULL} AS path FROM files f JOIN directories d ON d.id=f.parent WHERE f.size IS NULL AND f.mtime IS NULL AND f.dir IS NULL LIMIT ?`).all(maxFiles);
    const update=db.query('UPDATE files SET size=?,mtime=?,dir=? WHERE id=?');
    const pending:{id:number;size:number|null;mtime:number|null;dir:number}[]=[];
    const commit=()=>{if(!pending.length)return;db.transaction(()=>{for(const r of pending)update.run(r.size,r.mtime,r.dir,r.id);setMeta(db,'propertiesRevision',Number(getMeta(db,'propertiesRevision'))+1);})();pending.length=0;};
    for(const r of rows){if(performance.now()-start>seconds*1000)break;
      try {const stat=fs.statSync(r.path);pending.push({id:r.id,size:stat.size,mtime:stat.mtimeMs,dir:Number(stat.isDirectory())});}
      catch(e){if(!['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(e.code))throw e;failed++;pending.push({id:r.id,size:null,mtime:null,dir:-1});}
      inspected++;if(pending.length>=128){commit();await new Promise<void>(r=>setImmediate(r));}
    }
    commit();
    const unknown=db.query('SELECT count(*) AS n FROM files WHERE size IS NULL OR mtime IS NULL').get().n;
    const remaining=db.query('SELECT count(*) AS n FROM files WHERE size IS NULL AND mtime IS NULL AND dir IS NULL').get().n;
    return {index,inspected,failed,unknown,pending:remaining,elapsedMs:Math.round(performance.now()-start)};
  } finally {db.close();release();}
}

function termGroups(pq:ParsedQuery) {return pq.fuzzy.map(t=>t.startsWith("'")?[t.slice(1)]:t.split('|').filter(Boolean));}
function matcher(pq:ParsedQuery) {
  const constraints=pq.constraints.map(c=>({re:new RegExp(c.pattern,'i'),negate:c.negate})),groups=termGroups(pq);
  const favorites=pq.favorites?new Set(pq.favorites):null;
  return (p:string)=>(!favorites||favorites.has(p))&&!omitted(p,pq.omit)&&constraints.every(c=>c.re.test(p)!==c.negate)&&groups.every(g=>g.some(t=>/[A-Z]/.test(t)?p.includes(t):p.toLowerCase().includes(t.toLowerCase())));
}

// TEMP lives only in RAM. Keep at most two million integer IDs per connection;
// reserve one million before building, and never evict a set used by this query.
function cachedSet(index:string,sql:string,args:any[],active:Set<string>):RowSet|undefined {
  const c=connections.get(index)!,key=JSON.stringify([sql,args]);
  if(c.sets.has(key)){
    const hit=c.sets.get(key);c.sets.delete(key);c.sets.set(key,hit!);
    if(hit){active.add(hit.table);return hit;}return;
  }
  const rows=()=>[...c.sets.values()].reduce((n,s)=>n+(s?.count||0),0);
  for(const [k,s] of c.sets){
    if(rows()<=1000000&&c.sets.size<64)break;
    if(s&&active.has(s.table))continue;
    if(s)c.db.exec('DROP TABLE temp.'+s.table);c.sets.delete(k);
  }
  if(rows()>1000000||c.sets.size>=64)return;
  const table='fe_rows_'+(++c.sequence);
  c.db.exec('CREATE TEMP TABLE '+table+'(id INTEGER PRIMARY KEY)');
  try {
    c.db.query('INSERT INTO temp.'+table+' '+sql+' LIMIT 1000001').run(...args);
    const count=directChanges(c.db);
    if(count>1000000){c.db.exec('DROP TABLE temp.'+table);c.sets.set(key,null);return;}
    const value={table,count};c.sets.set(key,value);active.add(table);return value;
  }catch(e){c.db.exec('DROP TABLE IF EXISTS temp.'+table);throw e;}
}

function sqlPredicate(pq:ParsedQuery,db:Database,index:string,preview=false) {
  const args:any[]=[],parts:string[]=[],active=new Set<string>();
  let omittedSet:RowSet|undefined,baseTotal:number|undefined,baseCounter:(()=>number)|undefined;
  const context=connections.get(index)!;
  const seed=(table:'names_fts'|'directories_fts',quoted:string)=>{
    const key=table+quoted;let use=context.seeds.get(key);
    const cap=Math.min(100000,Math.max(10000,Math.floor(context.rows/100)));
    if(use===undefined){use=db.query(`SELECT count(*) AS n FROM (SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT ?)`).get(quoted,cap+1).n<=cap;if(context.seeds.size>=64)context.seeds.delete(context.seeds.keys().next().value!);context.seeds.set(key,use!);}
    return use;
  };
  if(pq.favorites){
    if(!pq.favorites.length)parts.push('0');
    else {
      args.push(JSON.stringify(pq.favorites.map(p=>{const s=splitPath(p);return {parent:s.parent,name:s.name};})));
      parts.push("f.id IN (SELECT fav.id FROM json_each(?) saved JOIN directories folder ON folder.path=json_extract(saved.value,'$.parent') JOIN files fav ON fav.parent=folder.id AND fav.name=json_extract(saved.value,'$.name'))");
    }
  }
  const rules=omissionRules(pq.omit||[]);
  const exclusions:string[]=[],excludeArgs:any[]=[];
  if(rules.length){
    excludeArgs.push([...new Set(rules.map(r=>'"'+r.term+'"'))].join(' OR '),...rules.map(r=>r.glob));
    exclusions.push('f.parent IN (SELECT id FROM directories WHERE id IN (SELECT rowid FROM directories_fts WHERE directories_fts MATCH ?) AND ('+rules.map(()=> 'pathKey GLOB ?').join(' OR ')+'))');
  }
  if(pq.omit?.includes('noise')){
    // Apply filename artifacts to the matched rows, never build a global
    // noise-ID set by scanning millions of unrelated indexed filenames.
    parts.push('NOT ('+[...NOISE_NAMES,...NOISE_SUFFIXES].map(()=> 'f.nameKey GLOB ?').join(' OR ')+')');
    args.push(...NOISE_NAMES,...NOISE_SUFFIXES.map(s=>'*'+s.toLowerCase()));
  }
  if(pq.omit?.includes('hidden'))exclusions.push("(f.nameKey GLOB '.*' OR f.parent IN (SELECT id FROM directories WHERE pathKey GLOB '*/.*'))");
  const literal=(text:string,exact=/[A-Z]/.test(text)):string=>{
    const folded=text.toLowerCase(),field=exact?'d.path || f.name':'d.pathKey || f.nameKey';
    if(preview){
      const term=folded.split('/').filter(s=>[...s].length>=3).sort((a,b)=>b.length-a.length)[0];
      let pre='';
      if(term){const quoted='"'+term.replace(/"/g,'""')+'"';if(seed('names_fts',quoted)&&seed('directories_fts',quoted)){args.push(quoted,quoted);pre='(f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) OR f.parent IN (SELECT rowid FROM directories_fts WHERE directories_fts MATCH ?)) AND ';}}
      args.push(exact?text:folded);return pre+`instr(${field},?)>0`;
    }
    if(!text.includes('/')) {
      const needle=exact?text:folded,nameField=exact?'f.name':'f.nameKey',parentField=exact?'path':'pathKey';
      const quoted='"'+folded.replace(/"/g,'""')+'"',useFts=[...folded].length>=3;
      const directoryFts=useFts&&seed('directories_fts',quoted);
      const directorySql=`SELECT id FROM directories WHERE ${directoryFts?'id IN (SELECT rowid FROM directories_fts WHERE directories_fts MATCH ?) AND ':''}instr(${parentField},?)>0`;
      const directoryArgs=directoryFts?[quoted,needle]:[needle];
      const cacheKey=JSON.stringify([text,exact]);let directories=context.directoryCounts.get(cacheKey);
      if(directories===undefined){
        if(!directoryFts&&!exact){const r=db.query('SELECT count(*) AS total,coalesce(sum(instr(pathKey,?)>0),0) AS n FROM directories INDEXED BY directory_names').get(needle);directories=r.n;context.directories=r.total;}
        else directories=db.query(`SELECT count(*) AS n FROM (${directorySql})`).get(...directoryArgs).n;
        if(context.directoryCounts.size>=64)context.directoryCounts.delete(context.directoryCounts.keys().next().value!);context.directoryCounts.set(cacheKey,directories!);
      }
      const single=pq.fuzzy.length===1&&termGroups(pq)[0].length===1&&!pq.constraints.length&&pq.favorites===undefined&&!pq.omit?.includes('noise');
      if(directories===context.directories&&directories>0){if(single)baseTotal=context.rows;return '1';}
      if(!exact&&context.directories>0&&directories>context.directories/2&&(context.directories-directories)*context.rows/context.directories<=1000000){
        const missing=cachedSet(index,'SELECT f.id FROM directories v CROSS JOIN files f INDEXED BY parent_names ON f.parent=v.id WHERE instr(v.pathKey,?)=0 AND instr(f.nameKey,?)=0',[needle,needle],active);
        if(missing){if(single)baseTotal=context.rows-missing.count;return 'f.id NOT IN (SELECT id FROM temp.'+missing.table+')';}
      }
      if(single&&!exact&&context.directories>0&&directories>context.directories/10){
        baseCounter=()=>context.rows-db.query('SELECT count(*) AS n FROM directories v CROSS JOIN files f INDEXED BY parent_names ON f.parent=v.id WHERE instr(v.pathKey,?)=0 AND instr(f.nameKey,?)=0').get(needle,needle).n;
      }
      const nameFts=useFts&&seed('names_fts',quoted);
      const nameSql=(nameFts?'f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) AND ':'')+`instr(${nameField},?)>0`;
      args.push(...(nameFts?[quoted,needle]:[needle]));
      if(!directories)return '('+nameSql+')';
      if(directories>10000){
        const inverse=context.directories>0&&directories>context.directories/2;
        const set=cachedSet(index,inverse?`SELECT id FROM directories WHERE instr(${parentField},?)=0`:directorySql,inverse?[needle]:directoryArgs,active);
        if(set)return '(('+nameSql+') OR f.parent '+(inverse?'NOT IN':'IN')+' (SELECT id FROM temp.'+set.table+'))';
      }
      args.push(...directoryArgs);return '(('+nameSql+') OR f.parent IN ('+directorySql+'))';
    }
    const ftsTerm=text.includes('/')?text.split('/').filter(s=>[...s].length>=3).sort((a,b)=>b.length-a.length)[0]:text;
    let pre='';
    if(ftsTerm&&[...ftsTerm].length>=3){const quoted='"'+ftsTerm.toLowerCase().replace(/"/g,'""')+'"';if(seed('names_fts',quoted)&&seed('directories_fts',quoted)){args.push(quoted,quoted);pre='(f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) OR f.parent IN (SELECT rowid FROM directories_fts WHERE directories_fts MATCH ?))';}}
    args.push(exact?text:folded);
    return (pre?pre+' AND ':'')+`instr(${field},?)>0`;
  };
  for(const group of termGroups(pq))parts.push('('+group.map(t=>'('+literal(t)+')').join(' OR ')+')');
  for(const c of pq.constraints){
    if(c.suffixes){const seeded=parts.some(p=>p.includes('names_fts')||p.includes('directories_fts'));const suffixes=c.suffixes.map(s=>{let pre='';const quoted='"'+s.replace(/"/g,'""')+'"';if(!seeded&&[...s].length>=3&&seed('names_fts',quoted)){args.push(quoted);pre='f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) AND ';}args.push('*'+s);return '('+pre+'f.nameKey GLOB ?)';});parts.push('('+suffixes.join(' OR ')+')');}
    else if(c.literal!==undefined){
      let test:string;
      if(c.field==='name'){
        const value=c.literal.toLowerCase(),useFts=[...value].length>=3&&seed('names_fts','"'+value.replace(/"/g,'""')+'"');
        if(useFts)args.push('"'+value.replace(/"/g,'""')+'"');
        args.push(value);test=(useFts?'f.id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?) AND ':'')+'instr(f.nameKey,?)>0';
      }else test=literal(c.literal,false);
      parts.push(c.negate?'NOT ('+test+')':'('+test+')');
    }
    else if(c.alternatives)parts.push('('+c.alternatives.map(t=>'('+literal(t,false)+')').join(' OR ')+')');
    else throw new Error('Unsupported indexed constraint');
  }
  const baseSql=parts.filter(p=>p.replace(/[()\s]/g,'')!=='1').join(' AND ')||'1',baseArgs=[...args];
  if(!pq.fuzzy.length&&!pq.constraints.length&&pq.favorites===undefined&&!pq.omit?.includes('noise'))baseTotal=context.rows;
  if(exclusions.length){
    const excluded=exclusions.join(' OR ');
    if(preview){
      if(rules.length){parts.push('NOT ('+rules.map(()=> 'd.pathKey GLOB ?').join(' OR ')+')');args.push(...rules.map(r=>r.glob));}
      if(pq.omit?.includes('hidden'))parts.push("NOT (f.nameKey GLOB '.*' OR d.pathKey GLOB '*/.*')");
    }else {
    omittedSet=cachedSet(index,'SELECT f.id FROM files f WHERE '+excluded,excludeArgs,active);
    if(omittedSet)parts.push('f.id NOT IN (SELECT id FROM temp.'+omittedSet.table+')');
    else {parts.push('NOT ('+excluded+')');args.push(...excludeArgs);baseTotal=undefined;baseCounter=undefined;}
    }
  }
  return {sql:parts.filter(p=>p.replace(/[()\s]/g,'')!=='1').join(' AND ')||'1',args,baseSql,baseArgs,baseTotal,baseCounter,omittedSet};
}

export function searchPrepared(index:string,pq:ParsedQuery,limit:number,offset:number,preview=false) {
  const db=openReady(index);if(!db)return;
  db.exec('BEGIN');
  try {
  const source=getMeta(db,'source');if(source!==baseStamp(index))return;
  const liveRevision=getMeta(db,'liveRevision'),propertiesRevision=getMeta(db,'propertiesRevision');
  const context=connections.get(index)!,revision=`${source}:${liveRevision}:${propertiesRevision}`;
  if(context.revision!==revision){
    const stored=getMeta(db,'indexedRows');
    context.rows=getMeta(db,'rowCountVersion')==='1'&&/^\d+$/.test(stored??'')?Number(stored):db.query('SELECT count(*) AS n FROM files').get().n;
    context.directories=-1;
    for(const set of context.sets.values())if(set)db.exec('DROP TABLE temp.'+set.table);
    context.directoryCounts.clear();context.counts.clear();context.sets.clear();context.seeds.clear();context.revision=revision;
  }
  preview=preview&&offset===0&&pq.favorites===undefined;
  const plan=sqlPredicate(pq,db,index,preview);
  const from=' FROM files f JOIN directories d ON d.id=f.parent WHERE '+plan.sql;
  const needsDirectories=/\bd\./.test(plan.sql),countFrom=needsDirectories?from:' FROM files f WHERE '+plan.sql;
  const usesSize=!!pq.sizeFilter||pq.sort==='big'||pq.sort==='small',usesDate=!!pq.dmFilter||pq.sort==='new'||pq.sort==='old';
  const known=[...(usesSize?['f.size IS NOT NULL']:[]),...(usesDate?['f.mtime IS NOT NULL']:[])].join(' AND ')||'1';
  const total=()=>{
    const base=plan.baseTotal??plan.baseCounter?.();
    if(base===undefined)return plan.sql==='1'?context.rows:db.query('SELECT count(*) AS n'+countFrom).get(...plan.args).n;
    if(!plan.omittedSet)return base;
    const excluded=plan.baseSql==='1'?plan.omittedSet.count:db.query(`SELECT count(*) AS n FROM temp.${plan.omittedSet.table} excluded CROSS JOIN files f ON f.id=excluded.id${/\bd\./.test(plan.baseSql)?' JOIN directories d ON d.id=f.parent':''} WHERE ${plan.baseSql}`).get(...plan.baseArgs).n;
    return base-excluded;
  };
  const filters:string[]=[],args=[...plan.args];
  if(pq.sizeFilter){
    const op=pq.sizeFilter.op;
    if(op==='range'){filters.push('f.size BETWEEN ? AND ?');args.push(pq.sizeFilter.bytes,pq.sizeFilter.maxBytes);}
    else {const sqlOp=({'<':'<','>':'>','<=':'<=','>=':'>=','=':'='} as Record<string,string>)[op];if(!sqlOp)throw new Error('Invalid size operator');filters.push(`f.size ${sqlOp} ?`);args.push(pq.sizeFilter.bytes);}
  }
  const timeBucket=pq.dmFilter?Math.floor(Date.now()/60000)*60000:0;
  if(pq.dmFilter){filters.push('f.mtime>=?');args.push(timeBucket-pq.dmFilter.days*86400000);}
  const filtered=from+(filters.length?' AND '+filters.join(' AND '):'');
  const countKey=JSON.stringify([plan.sql,plan.args,known,pq.sizeFilter,pq.dmFilter,timeBucket]);
  let coverage=context.counts.get(countKey);
  if(!coverage&&!preview){
    const value={total:total(),known:0};
    const knownFrom=value.total>10000?countFrom.replace(' FROM files f',` FROM files f INDEXED BY ${usesSize?'file_size':'file_modified'}`):countFrom;
    value.known=known==='1'?value.total:db.query(`SELECT count(*) AS n${knownFrom} AND ${known}`).get(...plan.args).n;
    coverage={...value,matched:filters.length?db.query('SELECT count(*) AS n'+filtered).get(...args).n:value.total};
    if(context.counts.size>=64)context.counts.delete(context.counts.keys().next().value!);
    context.counts.set(countKey,coverage!);
  }
  const matched=coverage?.matched??context.rows;
  const orders:Record<string,string>={name:'f.nameKey,f.id','name-desc':'f.nameKey DESC,f.id DESC',path:'d.pathKey,d.id,f.nameKey,f.id','path-desc':'d.pathKey DESC,d.id DESC,f.nameKey DESC,f.id DESC',new:'f.mtime DESC,f.id DESC',old:'f.mtime ASC NULLS LAST,f.id',big:'f.size DESC,f.id DESC',small:'f.size ASC NULLS LAST,f.id'};
  const reverseOrders:Record<string,string>={name:orders['name-desc'],'name-desc':orders.name,path:orders['path-desc'],'path-desc':orders.path,new:'f.mtime ASC,f.id',old:'f.mtime DESC NULLS FIRST,f.id DESC',big:'f.size ASC,f.id',small:'f.size DESC NULLS FIRST,f.id DESC'};
  const ranked=(!pq.sort&&pq.smart)||pq.sort==='relevance';
  const selections=ranked?(pq.learned||[]).flatMap(s=>{const p=splitPath(s.path),row=db.query('SELECT id FROM files WHERE parent=(SELECT id FROM directories WHERE path=?) AND name=?').get(p.parent,p.name);return row?[{id:row.id,boost:s.boost}]:[];}):[];
  const ranking=ranked?relevanceOrder(pq,selections):undefined;
  const reverse=!ranked&&offset>matched/2,sort=pq.sort||'name',order=ranking?ranking.sql+',f.nameKey,f.id':reverse?(reverseOrders[sort]||reverseOrders.name):(orders[sort]||orders.name);
  const pageLimit=Math.min(limit,Math.max(0,matched-offset)),pageOffset=reverse?Math.max(0,matched-offset-pageLimit):offset;
  const indexes:Record<string,string>={name:'file_names','name-desc':'file_names',big:'file_size',small:'file_size',new:'file_modified',old:'file_modified'};
  const pathOrder=pq.sort==='path'||pq.sort==='path-desc';
  let pageFrom=filtered;
  const broad=preview?!/names_fts|directories_fts/.test(plan.sql)&&!pq.sizeFilter&&!pq.dmFilter:matched>Math.max(10000,context.rows/20);
  if(pathOrder&&getMeta(db,'ordered')==='1'&&broad)pageFrom=filtered.replace(' FROM files f JOIN directories d ON d.id=f.parent',' FROM directories d INDEXED BY directory_names CROSS JOIN files f INDEXED BY parent_names ON f.parent=d.id');
  else if(broad){const indexName=indexes[pq.sort||'name'];if(indexName)pageFrom=filtered.replace(' FROM files f JOIN directories d ON d.id=f.parent',` FROM files f INDEXED BY ${indexName} CROSS JOIN directories d ON d.id=f.parent`);}
  let rows:any[];
  if(ranking&&!pq.fuzzy.length&&!pq.constraints.length&&!pq.favorites&&!pq.sizeFilter&&!pq.dmFilter){
    // Empty smart views can stop on the covering name index as soon as a
    // human-content bucket fills the page. No whole-index relevance sort.
    rows=[];let skip=pageOffset;
    const rankedFrom=filtered.replace(' FROM files f JOIN directories d ON d.id=f.parent',' FROM files f INDEXED BY file_names CROSS JOIN directories d ON d.id=f.parent')+` AND ${ranking.sql}=?`;
    for(const score of [0,10,20,25,40,50]){
      const parameters=[...args,...ranking.args,score];
      if(skip){const key='rank:'+countKey+':'+score;let count=context.counts.get(key)?.matched;if(count===undefined){count=db.query('SELECT count(*) AS n'+rankedFrom).get(...parameters).n;if(context.counts.size>=32)context.counts.delete(context.counts.keys().next().value!);context.counts.set(key,{total:count,known:count,matched:count});}if(skip>=count){skip-=count;continue;}}
      rows.push(...db.query(`SELECT ${FULL} AS path,f.size,f.mtime,f.dir${rankedFrom} ORDER BY f.nameKey,f.id LIMIT ? OFFSET ?`).all(...parameters,pageLimit-rows.length,skip));
      skip=0;if(rows.length>=pageLimit)break;
    }
  }
  else if(ranking){rows=db.query(`SELECT ${FULL} AS path,f.size,f.mtime,f.dir${filtered} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args,...ranking.args,pageLimit,pageOffset);}
  else if(!needsDirectories&&!pathOrder) {
    const filesOnly=pageFrom.replace(/ CROSS JOIN directories d ON d.id=f.parent| JOIN directories d ON d.id=f.parent/,'');
    const page=`SELECT f.id${filesOnly} ORDER BY ${order} LIMIT ? OFFSET ?`;
    rows=db.query(`SELECT ${FULL} AS path,f.size,f.mtime,f.dir FROM (${page}) page JOIN files f ON f.id=page.id JOIN directories d ON d.id=f.parent ORDER BY ${order}`).all(...args,pageLimit,pageOffset);
  } else rows=db.query(`SELECT ${FULL} AS path,f.size,f.mtime,f.dir${pageFrom} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args,pageLimit,pageOffset);
  if(reverse)rows.reverse();
  if(preview)return {paths:rows.map(r=>r.path),properties:rows,offset,nextOffset:null,
    snapshotId:`${source}:${liveRevision}:${propertiesRevision}:${timeBucket}`,snapshot:true,complete:false,provisional:true,
    coverage:{indexed:context.rows,matched:null,metadataUnknown:null},engine:'sqlite-trigram',warnings:['Exact match count is pending.','Configured exclusions and macOS permissions apply.']};
  const unknown=coverage!.total-coverage!.known;
  return {paths:rows.map(r=>r.path),properties:rows,offset,nextOffset:offset+rows.length<matched?offset+rows.length:null,
    snapshotId:`${source}:${liveRevision}:${propertiesRevision}:${timeBucket}`,snapshot:true,complete:unknown===0,
    coverage:{indexed:connections.get(index)!.rows,matched,metadataUnknown:unknown},engine:'sqlite-trigram',
    warnings:[...(unknown?[`${unknown} matching paths have unknown file properties; run fe properties --index ${index}.`]:[]),'Configured exclusions and macOS permissions apply.']};
  } catch(e) {
    try {if(db.inTransaction)db.exec('ROLLBACK');}finally{closeCached(index);}
    throw e;
  } finally {
    // The main database is read-only; commit only the bounded TEMP cache changes.
    if(connections.get(index)?.db===db&&db.inTransaction)db.exec('COMMIT');
  }
}

class PageHeap {
  values:{p:string;key:string;rank:number}[]=[];bytes=0;
  constructor(readonly capacity:number,readonly mode='name',readonly query?:ParsedQuery){}
  compare(a:{p:string;key:string;rank:number},b:{p:string;key:string;rank:number}){if(a.rank!==b.rank)return a.rank-b.rank;const c=a.key<b.key?-1:a.key>b.key?1:a.p<b.p?-1:a.p>b.p?1:0;return this.mode.endsWith('-desc')?-c:c;}
  worse(a:{p:string;key:string;rank:number},b:{p:string;key:string;rank:number}){return this.compare(a,b)>0;}
  add(p:string){const file=p.replace(/\/$/,''),key=this.mode.startsWith('path')?path.dirname(file)+'/\0'+path.basename(file):path.basename(file);const value={p,key:key.toLowerCase(),rank:this.query?relevanceScore(p,this.query,this.query.learned?.find(s=>s.path===p)?.boost||0):0};
    if(this.values.length<this.capacity){this.values.push(value);this.bytes+=Buffer.byteLength(p)*2;let i=this.values.length-1;while(i){const parent=(i-1)>>1;if(!this.worse(this.values[i],this.values[parent]))break;[this.values[i],this.values[parent]]=[this.values[parent],this.values[i]];i=parent;}}
    else if(this.worse(this.values[0],value)){this.bytes+=Buffer.byteLength(p)*2-Buffer.byteLength(this.values[0].p)*2;this.values[0]=value;let i=0;while(2*i+1<this.values.length){let child=2*i+1;if(child+1<this.values.length&&this.worse(this.values[child+1],this.values[child]))child++;if(!this.worse(this.values[child],this.values[i]))break;[this.values[child],this.values[i]]=[this.values[i],this.values[child]];i=child;}}
    if(this.bytes>64*1024*1024)throw new Error('Result page exceeds 64 MiB; use an earlier page or narrower query');
  }
  page(offset:number){return this.values.sort((a,b)=>this.compare(a,b)).slice(offset).map(r=>r.p);}
}
export async function searchStreaming(index:string,pq:ParsedQuery,limit:number,offset:number) {
  const stamp=baseStamp(index),delta=deltaFor(index),matches=matcher(pq),heap=new PageHeap(offset+limit,pq.sort,(!pq.sort&&pq.smart)||pq.sort==='relevance'?pq:undefined),start=performance.now();let count=0;
  const properties=!!pq.sizeFilter||!!pq.dmFilter||['big','small','new','old'].includes(pq.sort||'');
  const take=(p:string)=>{if(!matches(p))return;count++;if(!pq.sizeFilter&&!pq.dmFilter)heap.add(p);};
  const input=fs.createReadStream(indexPathFor(index),{highWaterMark:256*1024}),lines=createInterface({input,crlfDelay:Infinity});
  try {let n=0;for await(const p of lines){if(++n%4096===0&&performance.now()-start>10000)throw new Error(`Complete search exceeded 10 seconds; run fe prepare --index ${index}`);if(p&&delta.visible(p,true))take(p);}for(const p of delta.additions)take(p);}
  finally{lines.close();input.destroy();}
  if(baseStamp(index)!==stamp||deltaFor(index).revision!==delta.revision)throw new Error('Index changed during search; restart pagination');
  const paths=heap.page(offset),matched=pq.sizeFilter||pq.dmFilter?0:count;
  return {paths,offset,nextOffset:offset+paths.length<matched?offset+paths.length:null,snapshotId:`${stamp}:${delta.revision}:stream`,snapshot:true,complete:!properties,
    coverage:{matched,metadataUnknown:properties?count:0},engine:'complete-stream',warnings:[`Prepare fast indexed lookup with fe prepare --index ${index}; this search reads the existing path snapshot only.`,...(properties?[`File properties are not indexed; run fe properties --index ${index}.`]:[]),'Configured exclusions and macOS permissions apply.']};
}
