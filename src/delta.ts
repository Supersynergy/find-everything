import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import { INDEX_DIR, INDEX_FREE_RESERVE_BYTES, indexPathFor } from "./engine";
import {recoverPublishedCompaction} from './compaction-recovery';

export const livePath = () => path.join(INDEX_DIR, "live.sqlite");
// The recent journal stays bounded even when a scope has no prepared lookup.
export const LIVE_PATH_LIMIT = 1000000;
export const LIVE_MERGE_BATCH = 2048;
export function liveMergeThreshold() {
  const threshold=Number(process.env.FE_LIVE_MERGE_THRESHOLD);
  return Number.isSafeInteger(threshold)&&threshold>=2&&threshold<LIVE_PATH_LIMIT ? threshold : 750000;
}
export function hasMergedChanges(db:Database):boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='merged_changes'").get();
}
/** A barrier is a subtree replacement, independent of later exact-path changes. */
export function journalChanges(db:Database,scope:string,after:number) {
  const exact='SELECT path,present,tree,revision FROM ';
  const range=' WHERE scope=? AND revision>?';
  const queries=[exact+'changes'+range];
  if(hasMergedChanges(db)) queries.push(exact+'merged_changes'+range,'SELECT path,NULL AS present,1 AS tree,revision FROM tree_barriers'+range);
  return db.query(queries.join(' UNION ALL ')+' ORDER BY revision,path').iterate(...queries.flatMap(()=>[scope,after]));
}
/** A single durable, restartable batch. Rows and checkpoint commit together. */
export function mergeLiveBatch(db:Database,scope:string) {
  const checkSpace=()=>{
    const stat=fs.statfsSync(INDEX_DIR);
    if(stat.bavail*stat.bsize<=INDEX_FREE_RESERVE_BYTES)throw new Error('Live merge paused to keep 2 GiB free');
  };
  checkSpace();
  db.exec('BEGIN IMMEDIATE');
  try {
    const pending=db.query('SELECT watermark FROM merge_queue WHERE scope=?').get(scope);
    if(!pending){db.exec('COMMIT');return 0;}
    const rows=db.query('SELECT rowid,path,present,tree,revision FROM changes WHERE scope=? AND revision<=? ORDER BY revision LIMIT ?').all(scope,pending.watermark,LIVE_MERGE_BATCH);
    const merge=db.query('INSERT INTO merged_changes(scope,path,present,tree,revision) VALUES (?,?,?,?,?) ON CONFLICT(scope,path) DO UPDATE SET present=excluded.present,tree=excluded.tree,revision=excluded.revision WHERE excluded.revision>=merged_changes.revision');
    const barrier=db.query('INSERT INTO tree_barriers VALUES (?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=max(revision,excluded.revision)');
    const remove=db.query('DELETE FROM changes WHERE rowid=?');
    for(const row of rows) {
      if(row.tree)barrier.run(scope,row.path,row.revision);
      merge.run(scope,row.path,row.present,row.tree,row.revision);
      remove.run(row.rowid);
    }
    if(rows.length<LIVE_MERGE_BATCH){
      // Writes beyond this watermark may have filled another generation.
      // Renew its checkpoint under the same lock as retiring the first one.
      const remaining=db.query('SELECT count(*) AS n FROM changes WHERE scope=?').get(scope).n;
      if(remaining>=liveMergeThreshold())db.query('UPDATE merge_queue SET watermark=(SELECT revision FROM scopes WHERE name=?) WHERE scope=?').run(scope,scope);
      else db.query('DELETE FROM merge_queue WHERE scope=?').run(scope);
    }
    checkSpace();
    db.exec('COMMIT');return rows.length;
  }catch(error){if(db.inTransaction)db.exec('ROLLBACK');throw error;}
}
export function baseStamp(index: string): string { const file=indexPathFor(index);recoverPublishedCompaction(file);const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; }
/** Scope-local clock; unrelated journal writes must not invalidate search bodies. */
export function liveRevisionFor(index: string): number {
  if (!fs.existsSync(livePath())) return 0;
  const db = new Database(livePath(), { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-1024;');
    return db.query('SELECT revision FROM scopes WHERE name=? AND stamp=?').get(index, baseStamp(index))?.revision ?? 0;
  } finally { db.close(); }
}
export function openLive(): Database {
  const db = new Database(livePath(), { create: true });
  db.exec(`PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS scopes (name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER DEFAULT 0,problem TEXT,pid INTEGER,lastChange TEXT);
    CREATE TABLE IF NOT EXISTS changes (scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path));
    CREATE INDEX IF NOT EXISTS changes_revision ON changes(scope,revision);
    CREATE TABLE IF NOT EXISTS merged_changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS merged_changes_revision ON merged_changes(scope,revision);
    CREATE TABLE IF NOT EXISTS tree_barriers(scope TEXT,path TEXT,revision INTEGER,PRIMARY KEY(scope,path)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS tree_barriers_revision ON tree_barriers(scope,revision);
    CREATE TABLE IF NOT EXISTS merge_queue(scope TEXT PRIMARY KEY,watermark INTEGER);
    CREATE TABLE IF NOT EXISTS streams (root TEXT PRIMARY KEY,uuid TEXT,cursor TEXT);
    CREATE TABLE IF NOT EXISTS jobs (scope TEXT,path TEXT,failures INTEGER DEFAULT 0,retryAt REAL DEFAULT 0,PRIMARY KEY(scope,path));`);
  if (!db.query("PRAGMA table_info(jobs)").all().some(c => c.name === "failures")) db.exec("ALTER TABLE jobs ADD COLUMN failures INTEGER DEFAULT 0; ALTER TABLE jobs ADD COLUMN retryAt REAL DEFAULT 0;");
  return db;
}
export function liveStatus(index: string) {
  if (!fs.existsSync(livePath())) return { watching: false, revision: 0, problem: null };
  const db = new Database(livePath(), { readonly: true });
  db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096;');
  try {
    const row = db.query("SELECT * FROM scopes WHERE name=? AND stamp=?").get(index, baseStamp(index));
    if (!row) return { watching: false, revision: 0, problem: null };
    let watching = false, statusUnknown = false;
    try { if(Number.isInteger(row.pid)&&row.pid>0){process.kill(row.pid, 0); watching = true;}else statusUnknown=true; }
    catch (e) { if (e.code === "EPERM") statusUnknown = true; else if (e.code !== "ESRCH") throw e; }
    return { watching, statusUnknown, revision: row.revision, problem: row.problem, lastChange: row.lastChange,
      pending: db.query("SELECT count(*) AS n FROM jobs WHERE scope=?").get(index).n };
  } finally { db.close(); }
}
export function deltaFor(index: string) {
  const exact = new Map<string, { present: number; revision: number }>(), trees = new Map<string, number>();
  let revision = 0;
  if (fs.existsSync(livePath())) {
    const db = new Database(livePath(), { readonly: true });
    db.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096;');
    try {
      // A publisher holds the journal write lock across the file swap and stamp
      // update. Retry if its rename straddles the two independent snapshot reads.
      for(let attempt=0;;attempt++){
        const stamp=baseStamp(index);
        db.exec('BEGIN');
        const row=db.query('SELECT stamp,revision FROM scopes WHERE name=?').get(index);
        if(baseStamp(index)!==stamp){
          db.exec('ROLLBACK');
          if(attempt>=2)throw new Error('Index changed during overlay read; retry');
          continue;
        }
        if(row?.stamp===stamp){
          revision=row.revision;
          for(const r of journalChanges(db,index,-1)){
            if(r.present!==null)exact.set(r.path,{present:r.present,revision:r.revision});
            if(r.tree)trees.set(r.path.replace(/\/$/,'')||'/',r.revision);
          }
        }
        break;
      }
    } finally { db.close(); }
  }
  const visible = (p: string, base = false) => {
    p = p.replace(/\/$/, "") || "/";
    const own = exact.get(p);
    if (base && own) return false;
    let current = p;
    while (current !== path.dirname(current)) { current = path.dirname(current); if ((trees.get(current) || 0) > (own?.revision || 0)) return false; }
    return own ? !!own.present : true;
  };
  return { revision, visible, additions: [...exact].filter(([p,r]) => r.present && visible(p)).map(([p]) => p).sort() };
}
