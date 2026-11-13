import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import { INDEX_DIR, indexPathFor } from "./engine";

export const livePath = () => path.join(INDEX_DIR, "live.sqlite");
// A full-disk snapshot can accumulate more than 100k changed paths while its
// lookup is being prepared. Keep a finite, shared bound for writer and reader.
export const LIVE_PATH_LIMIT = 1000000;
export function baseStamp(index: string): string { const s = fs.statSync(indexPathFor(index)); return `${s.mtimeMs}:${s.size}`; }
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
  db.exec(`PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096;
    CREATE TABLE IF NOT EXISTS scopes (name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER DEFAULT 0,problem TEXT,pid INTEGER,lastChange TEXT);
    CREATE TABLE IF NOT EXISTS changes (scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path));
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
      const row = db.query("SELECT revision FROM scopes WHERE name=? AND stamp=?").get(index, baseStamp(index));
      if (row) {
        revision = row.revision;
        for (const r of db.query("SELECT path,present,tree,revision FROM changes WHERE scope=?").all(index)) {
          exact.set(r.path, r); if (r.tree) trees.set(r.path.replace(/\/$/, ""), r.revision);
        }
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
