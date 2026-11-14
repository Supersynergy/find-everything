import fs from 'node:fs';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {acquireLock} from './catalog';

export type CompactionState={version:1;source:string;watermark:number;lastId:number;rows:number;bytes:number;special:number;phase:'export'|'ready'|'done';publishedStamp?:string;targets?:Record<string,string>;staged?:Record<string,string>};
export function fileIdentity(file:string):string {const s=fs.statSync(file);return `${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`;}
export function validateCompactionState(value:unknown):asserts value is CompactionState {
  const s=value as CompactionState;
  if(!s||s.version!==1||!['export','ready','done'].includes(s.phase)||typeof s.source!=='string'||!/^\d+(?:\.\d+)?:\d+$/.test(s.source)||!['watermark','lastId','rows','bytes','special'].every(k=>Number.isSafeInteger(s[k])&&s[k]>=0))throw new Error('Invalid compaction checkpoint; files preserved');
  if(s.phase!=='export'&&(typeof s.publishedStamp!=='string'||!/^\d+(?:\.\d+)?:\d+$/.test(s.publishedStamp)))throw new Error('Invalid compaction publication stamp');
  for(const set of [s.targets,s.staged])if(set&&(!['paths','lookup','metadata'].every(k=>typeof set[k]==='string'&&/^\d+:\d+:\d+(?:\.\d+)?:\d+$/.test(set[k]))))throw new Error('Invalid compaction file identities');
}
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
    validateCompactionState(state);if(state.phase!=='ready')throw new Error('Invalid compaction publication intent');
    const base=path.basename(file),name=base.replace(/^index-/,'').replace(/\.txt$/,'');
    if(base!==`index-${name}.txt`||!/^[a-zA-Z0-9_-]+$/.test(name))throw new Error('Invalid compaction index');
    const lookup=path.join(path.dirname(file),`search-${name}.sqlite`),metadata=path.join(path.dirname(file),`index-${name}.json`);
    live=new Database(path.join(path.dirname(file),'live.sqlite'));live.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
    const scope=live.query('SELECT stamp,revision FROM scopes WHERE name=?').get(name) as {stamp:string;revision:number}|null;
    if(!scope||![state.source,state.publishedStamp].includes(scope.stamp)||scope.revision<state.watermark)throw new Error('Journal identity changed during compaction; previous files are preserved');
    const files=[
      {key:'paths',staged:path.join(dir,'paths.txt'),target:file,previous:path.join(dir,'previous.paths')},
      {key:'lookup',staged:path.join(dir,'lookup.sqlite'),target:lookup,previous:path.join(dir,'previous.sqlite')},
      {key:'metadata',staged:path.join(dir,'metadata.json'),target:metadata,previous:path.join(dir,'previous.metadata.json')},
    ];
    // Validate every component before the first rename. A missing stage is valid
    // only when its published target and original backup are both present.
    for(const f of files){
      const staged=fs.existsSync(f.staged),target=fs.existsSync(f.target),previous=fs.existsSync(f.previous);
      if(staged){
        if(previous?target:!target)throw new Error('Ambiguous compaction publication; files preserved');
        if(state.staged&&fileIdentity(f.staged)!==state.staged[f.key])throw new Error('Compaction stage changed; files preserved');
      }else if(!target||!previous)throw new Error('Missing compaction component; files preserved');
      const original=previous?f.previous:f.target,published=staged?f.staged:f.target;
      if(state.targets&&fileIdentity(original)!==state.targets[f.key])throw new Error('Compaction source changed; files preserved');
      if(!staged&&state.staged&&fileIdentity(published)!==state.staged[f.key])throw new Error('Compaction target changed; files preserved');
      if(f.key==='paths'){
        const a=fs.statSync(original),b=fs.statSync(published);
        if(`${a.mtimeMs}:${a.size}`!==state.source||`${b.mtimeMs}:${b.size}`!==state.publishedStamp)throw new Error('Compaction path identity changed; files preserved');
      }
    }
    const preparedFile=fs.existsSync(files[1].staged)?files[1].staged:lookup;
    const check=new Database(preparedFile,{readonly:true});
    try {if(check.query("SELECT value FROM meta WHERE key='source'").get()?.value!==state.publishedStamp||check.query("SELECT value FROM meta WHERE key='ready'").get()?.value!=='1')throw new Error('Invalid compaction lookup; files preserved');check.query('SELECT path FROM compact_specials LIMIT 1').get();}finally{check.close();}
    const meta=JSON.parse(fs.readFileSync(fs.existsSync(files[2].staged)?files[2].staged:metadata,'utf8'));
    if(meta.count!==state.rows||meta.bytes!==state.bytes)throw new Error('Invalid compaction metadata; files preserved');
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
    const merged=!!live.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='merged_changes'").get();
    for(const table of merged?['changes','merged_changes','tree_barriers']:['changes']){
      live.query('DELETE FROM '+table+' WHERE scope=? AND revision<=?').run(name,state.watermark);
    }
    // Line-delimited snapshots cannot encode CR/LF paths; retain them in the overlay.
    const prepared=new Database(lookup,{readonly:true});
    try{
      const retain=live.query('INSERT OR IGNORE INTO changes(scope,path,present,tree,revision) SELECT ?,?,1,0,?'+(merged?' WHERE NOT EXISTS (SELECT 1 FROM merged_changes WHERE scope=? AND path=?)':''));
      for(const row of prepared.query('SELECT path FROM compact_specials').iterate())retain.run(name,row.path,state.watermark,...(merged?[name,row.path]:[]));
    }
    finally{prepared.close();}
    live.query('UPDATE scopes SET stamp=? WHERE name=? AND stamp IN (?,?)').run(state.publishedStamp,name,state.source,state.publishedStamp);
    live.exec('COMMIT');
    state.phase='done';saveCompactionState(dir,state);fs.unlinkSync(intent);syncDirectory(dir);
  }catch(error){if(live?.inTransaction)live.exec('ROLLBACK');throw error;}
  finally{live?.close();release();}
}
