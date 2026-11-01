import {Database} from 'bun:sqlite';
import * as fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {prepareSearch,searchIndexPath,searchIndexStatus} from './path-search';
import {indexStatus,indexPathFor,INDEX_DIR,snapshotDescription} from './engine';
import {acquireLock,canonicalPaths,profiles,saveProfile,validateName,BUILTIN_SCOPES} from './catalog';
import {mediaPath} from './media';
import {semanticPath} from './semantic';

function cloneSnapshot(source:string,destination:string) {
  const db=new Database(source,{readonly:true});
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN');db.query('SELECT name FROM sqlite_master LIMIT 1').get();
    if(db.query('PRAGMA journal_mode').get().journal_mode!=='delete')throw new Error('Snapshot cloning requires a checkpointed source');
    try{fs.copyFileSync(source,destination,fs.constants.COPYFILE_FICLONE_FORCE);}
    catch(e){if(!['ENOTSUP','ENOSYS','EXDEV','EINVAL'].includes(e.code))throw e;fs.copyFileSync(source,destination);}
    db.exec('COMMIT');
  }finally{db.close();}
}

function combineStores(sources:string[],destination:string,tables:string[]) {
  const donors=sources.filter(fs.existsSync).sort((a,b)=>fs.statSync(b).size-fs.statSync(a).size);if(!donors.length)return;
  const stage=destination+'.combine';for(const suffix of ['', '-wal','-shm'])fs.rmSync(stage+suffix,{force:true});
  cloneSnapshot(donors[0],stage);const db=new Database(stage);
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192;');
    for(const donor of donors.slice(1)){
      db.query('ATTACH DATABASE ? AS incoming').run(donor);
      try {for(const table of tables){
        const target=db.query(`PRAGMA main.table_info(${table})`).all(),source=db.query(`PRAGMA incoming.table_info(${table})`).all();
        const columns=target.filter(t=>source.some(s=>s.name===t.name)).map(t=>'"'+t.name.replace(/"/g,'""')+'"');
        if(columns.length)db.exec(`INSERT OR IGNORE INTO main.${table}(${columns.join(',')}) SELECT ${columns.join(',')} FROM incoming.${table}`);
      }}finally{db.exec('DETACH DATABASE incoming');}
    }
  }finally{db.close();}
  fs.renameSync(stage,destination);
}

export async function combineIndexes(name:string,sourceNames:string[]=[],replace=false,seconds=300) {
  validateName(name);
  if(BUILTIN_SCOPES.includes(name))throw new Error('Choose a named combined index, such as everything');
  const old=profiles().find(p=>p.name===name);
  if(old&&!replace)throw new Error('Combined index already exists; use --replace to rebuild it from saved snapshots');
  const sources=indexStatus().filter(s=>s.exists&&s.name!==name&&(!sourceNames.length||sourceNames.includes(s.name)));
  if(!sources.length||sources.length>64)throw new Error('Combine 1–64 existing indexes');
  if(sourceNames.some(n=>!sources.some(s=>s.name===n)))throw new Error('A source index is missing');
  const deadline=performance.now()+seconds*1000;
  const sizes=new Map<string,number>();
  for(const source of sources){const prepared=await prepareSearch(source.name,Math.min(20,seconds));if(!prepared.ready)throw new Error(`Continue fe prepare --index ${source.name} first`);sizes.set(source.name,fs.statSync(searchIndexPath(source.name)).size);}
  sources.sort((a,b)=>sizes.get(b.name)!-sizes.get(a.name)!);
  const profile={name,paths:canonicalPaths(sources.flatMap(s=>s.paths)),includeHidden:true,includeIgnored:true,indexMaxAgeMinutes:'60'};
  const file=indexPathFor(name),lookup=searchIndexPath(name),stage=lookup+'.combine',flat=file+'.combine',metadata=path.join(INDEX_DIR,`index-${name}.json`);
  const release=acquireLock(file+'.lock');let db:Database|undefined,output:fs.WriteStream|undefined,publishRelease:(()=>void)|undefined;
  const modified=(file:string)=>fs.existsSync(file)?fs.statSync(file).mtimeMs:null;
  try {
    const descriptor=sources.map(s=>({name:s.name,mtime:modified(searchIndexPath(s.name)),size:fs.statSync(searchIndexPath(s.name)).size,media:modified(mediaPath(s.name)),sound:modified(semanticPath(s.name))}));
    if(old&&fs.existsSync(metadata)&&JSON.stringify(JSON.parse(fs.readFileSync(metadata,'utf8')).combinedSources)===JSON.stringify(descriptor)&&searchIndexStatus(name).ready)return {...searchIndexStatus(name),reused:true,filesystemScan:false};
    for(const suffix of ['', '-wal','-shm'])fs.rmSync(stage+suffix,{force:true});
    cloneSnapshot(searchIndexPath(sources[0].name),stage);
    db=new Database(stage);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384; PRAGMA temp_store=MEMORY;');
    for(const source of sources.slice(1)) {
      if(performance.now()>deadline)throw new Error('Combination budget reached; source indexes and the previous combined view are preserved');
      db.query('ATTACH DATABASE ? AS incoming').run(searchIndexPath(source.name));
      try {
        db.transaction(()=>{
          db!.exec(`INSERT OR IGNORE INTO directories(path,pathKey) SELECT path,pathKey FROM incoming.directories;
            INSERT OR IGNORE INTO files(parent,name,nameKey,slash,size,mtime,dir)
            SELECT target.id,f.name,f.nameKey,f.slash,f.size,f.mtime,f.dir FROM incoming.files f
            JOIN incoming.directories source ON source.id=f.parent JOIN main.directories target ON target.path=source.path;`);
          const update=db!.query('UPDATE main.files SET size=?,mtime=?,dir=coalesce(dir,?) WHERE parent=(SELECT id FROM main.directories WHERE path=?) AND name=? AND size IS NULL AND mtime IS NULL');
          for(const r of db!.query('SELECT d.path AS parent,f.name,f.size,f.mtime,f.dir FROM incoming.files f JOIN incoming.directories d ON d.id=f.parent WHERE f.size IS NOT NULL AND f.mtime IS NOT NULL').iterate())update.run(r.size,r.mtime,r.dir,r.parent,r.name);
        })();
      }finally{db.exec('DETACH DATABASE incoming');}
      if(fs.statSync(stage).size>6*1024**3)throw new Error('Combined accelerator exceeds 6 GiB; select fewer source indexes');
      console.error(`fe: combined saved index ${source.name}`);
      await new Promise<void>(r=>setImmediate(r));
    }
    let bytes=0,count=0,chunk='';
    output=fs.createWriteStream(flat,{mode:0o600});const written=once(output,'finish');
    for(const r of db.query("SELECT d.path || f.name || CASE WHEN f.slash=1 THEN '/' ELSE '' END AS path FROM files f JOIN directories d ON d.id=f.parent ORDER BY f.id").iterate()){
      chunk+=r.path+'\n';count++;
      if(chunk.length>=128*1024){bytes+=Buffer.byteLength(chunk);if(!output.write(chunk))await once(output,'drain');chunk='';if(performance.now()>deadline)throw new Error('Combined snapshot publication budget reached');}
    }
    if(chunk){bytes+=Buffer.byteLength(chunk);output.write(chunk);}output.end();await written;output=undefined;
    const fd=fs.openSync(flat,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    publishRelease=acquireLock(lookup+'.lock');fs.renameSync(flat,file);const stat=fs.statSync(file);
    const put=db.query('INSERT OR REPLACE INTO meta VALUES (?,?)');
    db.transaction(()=>{for(const [key,value] of Object.entries({source:`${stat.mtimeMs}:${stat.size}`,ready:'1',liveRevision:'0',propertiesRevision:'1',indexedRows:String(count),rowCountVersion:'1',combinedSources:JSON.stringify(descriptor)}))put.run(key,value);})();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');db.close();db=undefined;
    fs.renameSync(stage,lookup);
    combineStores(sources.map(s=>mediaPath(s.name)),mediaPath(name),['files']);
    combineStores(sources.map(s=>semanticPath(s.name)),semanticPath(name),['vectors','aliases']);
    const warnings=['Combined saved indexes: source coverage gaps and excluded locations remain; no filesystem traversal was performed.'];
    const data=snapshotDescription(name,profile,count,bytes,warnings);
    fs.writeFileSync(metadata+'.tmp',JSON.stringify({...data,combinedSources:descriptor}),{mode:0o600});fs.renameSync(metadata+'.tmp',metadata);
    saveProfile(profile,replace);
    return {index:name,ready:true,rows:count,bytes,sources:descriptor.map(s=>s.name),roots:profile.paths,filesystemScan:false};
  }finally{output?.destroy();db?.close();publishRelease?.();release();fs.rmSync(flat,{force:true});}
}
