import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {INDEX_DIR} from './engine';
import {validateName} from './catalog';

export type ExactCounts={total:number;known:number;matched:number;properties?:boolean};
export const countCachePath=(index:string)=>path.join(INDEX_DIR,`counts-${validateName(index)}.sqlite`);
export const countCacheKey=(identity:unknown,query:unknown)=>createHash('sha256').update(JSON.stringify([1,identity,query])).digest('hex');
function valid(value:ExactCounts):boolean{return ['total','known','matched'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0)&&value.known<=value.total&&value.matched<=value.total;}
function open(index:string,write=false):Database|undefined{
  const file=countCachePath(index);
  if(!fs.existsSync(file)){if(!write)return;const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);}
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||process.getuid&&stat.uid!==process.getuid())return;
  const db=new Database(file,{readonly:!write});
  try{db.exec('PRAGMA busy_timeout=50; PRAGMA cache_size=-256;');if(write)db.exec('PRAGMA journal_mode=PERSIST; PRAGMA journal_size_limit=1048576; PRAGMA max_page_count=512; CREATE TABLE IF NOT EXISTS counts(key TEXT PRIMARY KEY,body TEXT NOT NULL,at INTEGER NOT NULL);');return db;}
  catch{db.close();return;}
}
/** Disposable exact counts, keyed by the physical and logical snapshot; no paths stored. */
export function readExactCounts(index:string,key:string):ExactCounts|undefined{
  let db:Database|undefined;
  try{db=open(index);if(!db)return;const row=db.query('SELECT body FROM counts WHERE key=?').get(key) as {body:string}|null;if(!row)return;const value=JSON.parse(row.body);if(valid(value))return value;}
  catch{}finally{db?.close();}
}
export function writeExactCounts(index:string,key:string,value:ExactCounts):void{
  if(!valid(value))return;let db:Database|undefined;
  try{db=open(index,true);if(!db)return;db.transaction(()=>{db!.query('INSERT OR REPLACE INTO counts VALUES (?,?,?)').run(key,JSON.stringify(value),Date.now());db!.exec('DELETE FROM counts WHERE key NOT IN (SELECT key FROM counts ORDER BY at DESC,key LIMIT 128)');})();}
  catch{}finally{db?.close();}
}
