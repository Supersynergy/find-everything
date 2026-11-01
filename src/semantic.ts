import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import { acquireLock, validateName } from "./catalog";
import { INDEX_DIR, indexPathFor, ParsedQuery, parseQuery, matchesSize, compareSearchProperties } from "./engine";
import { mediaPath } from "./media";
import { MODEL_ID, SemanticWorker, semanticStatus } from "./semantic-worker";
import { soundPlan } from "./smart-query";
import { deltaFor } from "./delta";
import {omitted} from './file-filters';

export const semanticPath = (index: string) => path.join(INDEX_DIR, `sound-${validateName(index)}.sqlite`);
const worker = new SemanticWorker();
export const closeSoundWorker = () => worker.close();
const textCache = new Map<string, number[]>();

function store(index: string, readonly = false) {
  const db = new Database(semanticPath(index), { readonly, create: !readonly });
  db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY;");
  if (!readonly) db.exec("CREATE TABLE IF NOT EXISTS vectors(path TEXT PRIMARY KEY, size INTEGER, mtime REAL, model TEXT NOT NULL, vector BLOB, error TEXT); CREATE TABLE IF NOT EXISTS aliases(path TEXT PRIMARY KEY,canonical TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)");
  return db;
}
function candidates(index: string, pq: ParsedQuery, onlyPaths?: string[]): { rows: any[]; stamp: string; mediaStamp: number; current: boolean; metadataUnknown: number } {
  if (!fs.existsSync(mediaPath(index))) throw new Error(`Audio metadata is missing. Run fe enrich --index ${index}`);
  const db = new Database(mediaPath(index), { readonly: true });
  const mediaStamp = fs.statSync(mediaPath(index)).mtimeMs;
  db.exec("BEGIN");
  try {
    const s = fs.statSync(indexPathFor(index)), stamp = `${s.mtimeMs}:${s.size}`;
    const known = new Set(["duration", "sampleRate", "channels", "bitrate", "width", "height"]);
    if (pq.mediaFilters.some(f => !known.has(f.field) || !["<", ">", "<=", ">=", "="].includes(f.op) || !Number.isFinite(f.value))) throw new Error("Invalid sound predicate");
    const delta = deltaFor(index);
    let rows = onlyPaths ? db.query("SELECT * FROM files WHERE kind='audio' AND status<>'excluded' AND path IN (SELECT value FROM json_each(?)) ORDER BY path").all(JSON.stringify(onlyPaths)) : db.query("SELECT * FROM files WHERE kind='audio' AND status<>'excluded' ORDER BY path").all();
    const favorites=pq.favorites?new Set(pq.favorites):null;
    rows = rows.filter(r => delta.visible(r.path)&&(!favorites||favorites.has(r.path))&&!omitted(r.path,pq.omit));
    const constraints = pq.constraints.map(c => ({ re: new RegExp(c.pattern, "i"), negate: c.negate }));
    rows = rows.filter(r => constraints.every(c => c.re.test(r.path) !== c.negate) && pq.fuzzy.every(t => t.replace(/^'/, "").split("|").some(w => r.path.toLowerCase().includes(w.toLowerCase()))));
    if (pq.sizeFilter) rows = rows.filter(r => matchesSize(r.size,pq.sizeFilter));
    if (pq.dmFilter) rows = rows.filter(r => Date.now() - r.mtime < pq.dmFilter.days * 86400000);
    if (rows.length > 100000) throw new Error("Sound scope exceeds 100000 candidates; select a smaller folder or duration range");
    const metadataUnknown = rows.filter(r => pq.mediaFilters.some(f => r[f.field] == null)).length;
    rows = rows.filter(r => pq.mediaFilters.every(f => r[f.field] != null && (f.op === "<" ? r[f.field] < f.value : f.op === ">" ? r[f.field] > f.value : f.op === "<=" ? r[f.field] <= f.value : f.op === ">=" ? r[f.field] >= f.value : r[f.field] === f.value)));
    if (fs.statSync(mediaPath(index)).mtimeMs !== mediaStamp) throw new Error("Audio metadata changed during search; retry");
    return { rows, stamp, mediaStamp, metadataUnknown, current: db.query("SELECT value FROM meta WHERE key='indexStamp'").get()?.value === stamp };
  } finally { db.exec("ROLLBACK"); db.close(); }
}
export async function indexSounds(index: string, query: string, maxFiles: number, seconds: number, onlyPaths?: string[]) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000 || seconds < 1 || seconds > 300) throw new Error("Invalid sound indexing budget");
  const deadline = performance.now() + seconds * 1000;
  if (!semanticStatus().ready) throw new Error("Run fe semantic setup first");
  const pq = parseQuery(query), { rows: paths, stamp } = candidates(index, pq, onlyPaths);
  const aliases: [string, string][] = [], unique = new Map<string, any>();
  for (const row of paths) {
    try { const canonical = fs.realpathSync(row.path); aliases.push([row.path, canonical]); if (!unique.has(canonical)) unique.set(canonical, { ...row, path: canonical }); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const rows = [...unique.values()];
  const hints = (pq.semantic || "").split(/\s+/).filter(w => w.length > 3 && !["sound", "effect", "effects"].includes(w));
  const priority = (r: any) => hints.filter(h => path.basename(r.path).toLowerCase().includes(h)).length;
  rows.sort((a, b) => priority(b) - priority(a));
  fs.mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
  const release = acquireLock(semanticPath(index) + ".lock");
  let db: Database;
  let analyzed = 0, reused = 0, failed = 0, pending = paths.length - aliases.length;
  const updates: any[][] = [];
  const flush = () => { if (!updates.length) return; db.transaction(() => { const put = db.query("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?)"); for (const u of updates) put.run(...u); })(); updates.length = 0; };
  try {
    db = store(index);
    if (!onlyPaths) db.query("INSERT INTO settings VALUES ('query',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(query);
    const alias = db.query("INSERT INTO aliases VALUES(?,?) ON CONFLICT(path) DO UPDATE SET canonical=excluded.canonical WHERE canonical<>excluded.canonical");
    const migrate = db.query("INSERT OR IGNORE INTO vectors SELECT ?,size,mtime,model,vector,error FROM vectors WHERE path=?");
    const remove = db.query("DELETE FROM vectors WHERE path=?");
    db.transaction(() => {
      for (const [p, canonical] of aliases) {
        alias.run(p, canonical);
        if (p !== canonical) { migrate.run(canonical, p); remove.run(p); }
      }
    })();
    for (const row of rows) {
      if (performance.now() >= deadline) { pending++; continue; }
      let stat: fs.Stats;
      try { stat = fs.statSync(row.path); if (!stat.isFile()) { pending++; continue; } }
      catch { pending++; continue; }
      const old = db.query("SELECT size,mtime,model FROM vectors WHERE path=?").get(row.path);
      if (old?.model === MODEL_ID && old.size === stat.size && old.mtime === stat.mtimeMs) { reused++; continue; }
      if (analyzed >= maxFiles || deadline - performance.now() < 1000) { pending++; continue; }
      analyzed++;
      try {
        const vector = await worker.embed("audio", row.path, Math.min(20000, deadline - performance.now()));
        const after = fs.statSync(row.path);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) { pending++; continue; }
        updates.push([row.path, stat.size, stat.mtimeMs, MODEL_ID, Buffer.from(new Float32Array(vector).buffer), null]);
      } catch (e) {
        if (e.code !== "AUDIO_DECODE") { flush(); throw e; }
        failed++; updates.push([row.path, stat.size, stat.mtimeMs, MODEL_ID, null, String(e.message).slice(0, 400)]);
      }
      if (updates.length >= 16) flush();
    }
    flush();
    return { index, model: MODEL_ID, analyzed, reused, failed, pending, candidates: rows.length, candidatePaths: paths.length, aliases: aliases.length - rows.length, missingPaths: paths.length - aliases.length, snapshot: stamp, database: semanticPath(index), sampleSeconds: 10 };
  } finally { if (!onlyPaths) worker.close(); db?.close(); release(); }
}

export async function refreshSounds(index: string, paths: string[]) {
  if (!fs.existsSync(semanticPath(index)) || !semanticStatus().ready) return;
  const db = store(index,true);
  let query: string | undefined;
  try { if (db.query("SELECT 1 FROM sqlite_master WHERE name='settings'").get()) query = db.query("SELECT value FROM settings WHERE key='query'").get()?.value; }
  finally { db.close(); }
  if (query !== undefined) return indexSounds(index,query,8,8,paths);
}

export async function searchSounds(index: string, pq: ParsedQuery, limit: number, offset: number) {
  const empty = { paths: [] as string[], complete: false, nextOffset: null, semantic: true };
  if (!fs.existsSync(mediaPath(index))) return { ...empty, warnings: [`Media metadata has not been indexed. Run fe enrich --index ${index}`], coverage: { known: 0, unknown: null } };
  if (!fs.existsSync(semanticPath(index))) return { ...empty, warnings: [`Sound embeddings have not been indexed. Run fe semantic setup, then fe semantic index --index ${index} --query '(kurze Lasersounds)'`], coverage: { known: 0, unknown: null } };
  const { rows, stamp, mediaStamp, current, metadataUnknown } = candidates(index, pq);
  const soundStamp = fs.statSync(semanticPath(index)).mtimeMs;
  const db = store(index, true);
  let saved: any[], aliases: any[], failures: any[];
  try {
    saved = db.query("SELECT path,size,mtime,vector FROM vectors WHERE model=? AND vector IS NOT NULL").all(MODEL_ID);
    failures = db.query("SELECT path,size,mtime FROM vectors WHERE model=? AND vector IS NULL").all(MODEL_ID);
    aliases = db.query("PRAGMA table_info(aliases)").all().length ? db.query("SELECT path,canonical FROM aliases").all() : [];
  }
  finally { db.close(); }
  if (fs.statSync(semanticPath(index)).mtimeMs !== soundStamp) throw new Error("Sound index changed during search; retry");
  const byPath = new Map(saved.map(r => [r.path, r]));
  const byAlias = new Map(aliases.map(r => [r.path, r.canonical]));
  const unique = new Map<string, any>();
  for (const row of rows) {
    const canonical = byAlias.get(row.path) || row.path, old = unique.get(canonical);
    if (!old || row.path === canonical || (old.path !== canonical && row.path.length < old.path.length)) unique.set(canonical, { ...row, canonical });
  }
  const eligible = [...unique.values()].filter(r => { const v = byPath.get(r.canonical); return v && v.size === r.size && v.mtime === r.mtime; });
  const byFailure = new Map(failures.map(r => [r.path, r]));
  const failed = [...unique.values()].filter(r => { const f = byFailure.get(r.canonical); return f && f.size === r.size && f.mtime === r.mtime; }).length;
  if (!eligible.length) return { ...empty, warnings: [`No cached sound vectors match these filters. Run fe semantic index --index ${index} --query '${pq.semantic}' with the intended filters.`], coverage: { known: 0, unknown: rows.length } };
  const plan = soundPlan(pq.semantic!);
  const textVector = async (text: string) => {
    let vector = textCache.get(text);
    if (vector) return vector;
    vector = await worker.embed("text", text);
    if (textCache.size >= 128) textCache.delete(textCache.keys().next().value);
    textCache.set(text, vector); return vector;
  };
  const descriptionVector = await textVector(plan.description);
  const anchorVector = plan.anchorWeight ? await textVector(plan.anchor) : descriptionVector;
  const vector = descriptionVector.map((v, i) => v * (1 - plan.anchorWeight) + anchorVector[i] * plan.anchorWeight);
  const ranked = eligible.map(row => {
    const b = byPath.get(row.canonical).vector;
    const v = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    if (v.length !== 512) throw new Error("Invalid cached sound vector; rebuild this sound index");
    let score = 0; for (let i = 0; i < 512; i++) score += v[i] * vector![i];
    return { ...row, score };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if(pq.sort&&pq.sort!=='relevance')ranked.sort((a,b)=>compareSearchProperties(a,b,pq.sort!));
  const selected: any[] = []; let consumed = offset, changed = 0;
  for (const row of ranked.slice(offset)) {
    consumed++;
    try { const s = fs.statSync(row.path); if (s.size !== row.size || s.mtimeMs !== row.mtime) { changed++; continue; } }
    catch { changed++; continue; }
    selected.push(row); if (selected.length === limit) break;
  }
  const unknown = unique.size - eligible.length;
  return { paths: selected.map(r => r.path), scores: selected.map(r => ({ path: r.path, similarity: r.score })), semantic: true, semanticPlan: plan, model: MODEL_ID,
    complete: false, snapshot: true, snapshotId: `${stamp}:${mediaStamp}:${soundStamp}`, nextOffset: consumed < ranked.length ? consumed : null, offset,
    coverage: { known: eligible.length, unknown, failed, metadataUnknown, matched: ranked.length, changed, aliases: rows.length - unique.size, snapshotCurrent: current },
    warnings: [`Approximate acoustic ranking of ${eligible.length} unique cached sounds; ${unknown > failed ? `${unknown - failed} unanalyzed, ` : ""}${failed} cached decode failures, ${metadataUnknown} paths with unknown metadata, ${changed} changed/missing matches. First 10 seconds per file. Semantic recall is not exhaustive.${plan.anchorWeight ? ` Anchor: ${plan.anchor} (80%).` : ""}${current ? "" : " Path snapshot changed; enrich metadata explicitly."}`] };
}
