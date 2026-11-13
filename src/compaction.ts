import fs from 'node:fs';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {acquireLock} from './catalog';
import {INDEX_DIR,INDEX_FREE_RESERVE_BYTES,indexPathFor,indexStatus,rebuildIndex} from './engine';
import {baseStamp,liveRevisionFor,liveStatus,openLive} from './delta';
import {searchIndexPath} from './path-search';
import {compactionDirectory,recoverPublishedCompaction,saveCompactionState,syncDirectory,fileIdentity,validateCompactionState,type CompactionState} from './compaction-recovery';

export function compactionStatus(index:string){const dir=compactionDirectory(indexPathFor(index));recoverPublishedCompaction(indexPathFor(index));return fs.existsSync(path.join(dir,'state.json'))?JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')):null;}
/** Export a pinned prepared snapshot in bounded batches; live changes after its watermark survive. */
export async function compactIndex(index:string,seconds=30,maxRows=1000000){
  if(!Number.isFinite(seconds)||seconds<=0||seconds>300||!Number.isSafeInteger(maxRows)||maxRows<1)throw new Error('Invalid compaction budget');
  const file=indexPathFor(index),dir=compactionDirectory(file);recoverPublishedCompaction(file);
  const release=acquireLock(file+'.lock');let searchRelease:(()=>void)|undefined,db:Database|undefined;
  try{
    searchRelease=acquireLock(searchIndexPath(index)+'.lock');
    const source=baseStamp(index),stateFile=path.join(dir,'state.json');let state:CompactionState|undefined=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):undefined;
    const journal=openLive();try{journal.query('INSERT OR IGNORE INTO scopes(name,stamp) VALUES (?,?)').run(index,source);}finally{journal.close();}
    if(state)validateCompactionState(state);
    if(state?.phase==='done'){
      if(state.publishedStamp===source&&liveRevisionFor(index)===state.watermark)return {...state,resumable:false,reused:true,live:liveStatus(index)};
      fs.renameSync(dir,dir+'.backup-'+Date.now());state=undefined;
    }
    if(state&&state.source!==source)throw new Error('Source changed; preserve the unfinished compaction and start from the current snapshot explicitly');
    const disk=fs.statfsSync(INDEX_DIR),remaining=Math.max(0,fs.statSync(file).size-(state?.bytes??0));
    if(disk.bavail*disk.bsize<INDEX_FREE_RESERVE_BYTES+remaining)throw new Error(`Compaction needs at least ${remaining+INDEX_FREE_RESERVE_BYTES} free bytes for staging and the 2 GiB reserve`);
    if(!state){
      const input=new Database(searchIndexPath(index),{readonly:true});
      try{
        input.exec('PRAGMA busy_timeout=1000; BEGIN');
        const get=(key:string)=>input.query('SELECT value FROM meta WHERE key=?').get(key)?.value;
        if(get('source')!==source||get('ready')!=='1')throw new Error('Prepare the current saved snapshot before compacting');
        const watermark=Number(get('liveRevision'));if(!Number.isSafeInteger(watermark)||watermark<0)throw new Error('Invalid prepared watermark');
        if(watermark>liveRevisionFor(index))throw new Error('Journal history precedes this prepared snapshot; reconcile explicitly before compacting');
        if(input.query('PRAGMA journal_mode').get().journal_mode!=='delete')throw new Error('Compaction requires a checkpointed lookup');
        fs.mkdirSync(dir,{recursive:true,mode:0o700});
        const target=path.join(dir,'lookup.sqlite');
        try{fs.copyFileSync(searchIndexPath(index),target,fs.constants.COPYFILE_FICLONE_FORCE);}catch(error){if(!['ENOTSUP','ENOSYS','EXDEV','EINVAL'].includes(error.code))throw error;if(disk.bavail*disk.bsize<fs.statSync(searchIndexPath(index)).size+fs.statSync(file).size+INDEX_FREE_RESERVE_BYTES)throw new Error('Not enough space for a non-cloned compaction');fs.copyFileSync(searchIndexPath(index),target);}
        fs.chmodSync(target,0o600);
        const staged=new Database(target);try{staged.exec('DROP TABLE IF EXISTS compact_specials; CREATE TABLE compact_specials(path TEXT PRIMARY KEY)');}finally{staged.close();}
        fs.writeFileSync(path.join(dir,'paths.txt'),'',{mode:0o600});
        state={version:1,source,watermark,lastId:0,rows:0,bytes:0,special:0,phase:'export'};saveCompactionState(dir,state);
      }finally{input.close();}
    }
    if(!fs.existsSync(path.join(dir,'lookup.sqlite'))||!fs.existsSync(path.join(dir,'paths.txt'))||fs.statSync(path.join(dir,'paths.txt')).size<state.bytes)throw new Error('Incomplete compaction checkpoint; files preserved');
    db=new Database(path.join(dir,'lookup.sqlite'));db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; CREATE TABLE IF NOT EXISTS compact_specials(path TEXT PRIMARY KEY)');
    const output=fs.openSync(path.join(dir,'paths.txt'),'r+');fs.ftruncateSync(output,state.bytes);
    const deadline=performance.now()+seconds*1000;let processed=0,done=false;
    try{
      while(processed<maxRows&&performance.now()<deadline){
        const batch=db.query("SELECT f.id,d.path || f.name || CASE WHEN f.slash=1 THEN '/' ELSE '' END AS path FROM files f JOIN directories d ON d.id=f.parent WHERE f.id>? ORDER BY f.id LIMIT ?").all(state.lastId,Math.min(4096,maxRows-processed)) as {id:number;path:string}[];
        if(!batch.length){done=true;break;}
        let text='';for(const row of batch){if(/[\r\n]/.test(row.path)){db.query('INSERT OR IGNORE INTO compact_specials VALUES (?)').run(row.path);state.special++;}else{text+=row.path+'\n';state.rows++;}state.lastId=row.id;processed++;}
        const bytes=Buffer.from(text);let offset=0;while(offset<bytes.length)offset+=fs.writeSync(output,bytes,offset,bytes.length-offset,state.bytes+offset);state.bytes+=bytes.length;
        fs.fsyncSync(output);saveCompactionState(dir,state);
        if(fs.statfsSync(INDEX_DIR).bavail*disk.bsize<=INDEX_FREE_RESERVE_BYTES)throw new Error('Compaction reached disk reserve; resume after freeing space');
        await new Promise<void>(r=>setImmediate(r));
      }
    }finally{fs.closeSync(output);}
    if(!done)return {...state,processed,resumable:true};
    if(baseStamp(index)!==state.source)throw new Error('Snapshot changed while compacting');
    const stat=fs.statSync(path.join(dir,'paths.txt'));state.publishedStamp=`${stat.mtimeMs}:${stat.size}`;
    db.query('UPDATE meta SET value=? WHERE key=\'source\'').run(state.publishedStamp);db.close();db=undefined;
    const old=indexStatus().find(s=>s.name===index)!;
    const metadataFile=path.join(INDEX_DIR,`index-${index}.json`),meta=JSON.parse(fs.readFileSync(metadataFile,'utf8'));
    meta.count=state.rows;meta.bytes=state.bytes;meta.compactedAt=new Date().toISOString();meta.compactedThrough=state.watermark;
    meta.provenanceWarnings=(meta.provenanceWarnings||[]).filter((warning:string)=>!/^\d+ CR\/LF paths remain in the live overlay\.$/.test(warning));
    if(state.special)meta.provenanceWarnings.push(`${state.special} CR/LF paths remain in the live overlay.`);
    fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify(meta),{mode:0o600});
    // Preserve original scan time, exclusions and gap provenance. Compaction is not reconciliation.
    state.targets={paths:fileIdentity(file),lookup:fileIdentity(searchIndexPath(index)),metadata:fileIdentity(metadataFile)};
    state.staged={paths:fileIdentity(path.join(dir,'paths.txt')),lookup:fileIdentity(path.join(dir,'lookup.sqlite')),metadata:fileIdentity(path.join(dir,'metadata.json'))};
    for(const name of ['paths.txt','lookup.sqlite','metadata.json']){const fd=fs.openSync(path.join(dir,name),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    state.phase='ready';saveCompactionState(dir,state);
    const intent=path.join(dir,'publish.json'),temporary=path.join(dir,'publish.tmp');fs.copyFileSync(path.join(dir,'state.json'),temporary);const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,intent);syncDirectory(dir);
    recoverPublishedCompaction(file);
    return {...state,phase:'done',processed,resumable:false,live:liveStatus(index),filesystemScan:false};
  }finally{db?.close();searchRelease?.();release();}
}
export async function reconcileIndex(index:string){await rebuildIndex(index,{});return {index,reconciled:true,filesystemScan:true,live:liveStatus(index)};}
