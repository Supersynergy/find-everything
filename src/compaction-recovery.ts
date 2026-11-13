import fs from 'node:fs';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {acquireLock} from './catalog';

export type CompactionState={version:1;source:string;watermark:number;lastId:number;rows:number;bytes:number;special:number;phase:'export'|'ready'|'done';publishedStamp?:string};
export const compactionDirectory=(file:string)=>file+'.compacting';
export function syncDirectory(dir:string){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function saveCompactionState(dir:string,state:CompactionState){
  const tmp=path.join(dir,'state.tmp'),file=path.join(dir,'state.json');
  fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);syncDirectory(dir);
}
/** Complete a durable publication intent before any watcher compares source stamps. */
export function recoverPublishedCompaction(file:string):void{
  const dir=compactionDirectory(file),intent=path.join(dir,'publish.json');if(!fs.existsSync(intent))return;
  const release=acquireLock(intent+'.lock');let live:Database|undefined;
  try{
    if(!fs.existsSync(intent))return;
    const state=JSON.parse(fs.readFileSync(intent,'utf8')) as CompactionState;
    if(state.version!==1||state.phase!=='ready'||!Number.isSafeInteger(state.watermark)||state.watermark<0||!state.publishedStamp)throw new Error('Invalid compaction publication intent');
    const base=path.basename(file),name=base.replace(/^index-/,'').replace(/\.txt$/,'');
    if(base!==`index-${name}.txt`||!/^[a-zA-Z0-9_-]+$/.test(name))throw new Error('Invalid compaction index');
    const lookup=path.join(path.dirname(file),`search-${name}.sqlite`),metadata=path.join(path.dirname(file),`index-${name}.json`);
    live=new Database(path.join(path.dirname(file),'live.sqlite'));live.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
    const scope=live.query('SELECT stamp,revision FROM scopes WHERE name=?').get(name) as {stamp:string;revision:number}|null;
    if(!scope||![state.source,state.publishedStamp].includes(scope.stamp)||scope.revision<state.watermark)throw new Error('Journal identity changed during compaction; previous files are preserved');
    const swap=(staged:string,target:string,previous:string)=>{
      if(!fs.existsSync(staged))return;
      if(fs.existsSync(target)&&!fs.existsSync(previous))fs.renameSync(target,previous);
      fs.renameSync(staged,target);
    };
    swap(path.join(dir,'paths.txt'),file,path.join(dir,'previous.paths'));
    swap(path.join(dir,'lookup.sqlite'),lookup,path.join(dir,'previous.sqlite'));
    swap(path.join(dir,'metadata.json'),metadata,path.join(dir,'previous.metadata.json'));
    syncDirectory(dir);syncDirectory(path.dirname(file));
    const now=fs.statSync(file);if(`${now.mtimeMs}:${now.size}`!==state.publishedStamp)throw new Error('Compaction target changed during recovery');
    live.query('DELETE FROM changes WHERE scope=? AND revision<=?').run(name,state.watermark);
    // Line-delimited snapshots cannot encode CR/LF paths; retain them in the overlay.
    const prepared=new Database(lookup,{readonly:true});
    try{for(const row of prepared.query('SELECT path FROM compact_specials').iterate())live.query('INSERT OR IGNORE INTO changes(scope,path,present,tree,revision) VALUES (?,?,1,0,?)').run(name,row.path,state.watermark);}
    finally{prepared.close();}
    live.query('UPDATE scopes SET stamp=? WHERE name=? AND stamp IN (?,?)').run(state.publishedStamp,name,state.source,state.publishedStamp);
    live.exec('COMMIT');
    state.phase='done';saveCompactionState(dir,state);fs.unlinkSync(intent);syncDirectory(dir);
  }catch(error){if(live?.inTransaction)live.exec('ROLLBACK');throw error;}
  finally{live?.close();release();}
}
