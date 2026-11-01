import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { acquireLock, validateName } from "./catalog";
import { INDEX_DIR, RG, findBin, indexPathFor, ParsedQuery, rerank, track, matchesSize, compareSearchProperties } from "./engine";
import { NativeProbe } from "./native-probe";
import { MEDIA_FIELDS } from "./smart-query";
import { deltaFor } from "./delta";
import {omitted} from './file-filters';
import {relevanceScore} from './search-ranking';

const exec = promisify(execFile);
const AUDIO = /\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma)$/i;
const VIDEO = /\.(mp4|m4v|mov|mkv|avi|webm|wmv|flv)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;
const MEDIA_PATTERN = "\\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|avi|webm|wmv|flv|png|jpe?g|gif|webp|heic|tiff?|bmp)$";
export const mediaPath = (index: string) => path.join(INDEX_DIR, `media-${validateName(index)}.sqlite`);
const stamp = (index: string) => { const s = fs.statSync(indexPathFor(index)); return `${s.mtimeMs}:${s.size}`; };
const kind = (p: string) => AUDIO.test(p) ? "audio" : VIDEO.test(p) ? "video" : IMAGE.test(p) ? "image" : "unknown";

function openStore(index: string, readonly = false): Database {
  const db = new Database(mediaPath(index), { readonly, create: !readonly });
  db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY;");
  if (!readonly) db.exec(`CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER, mtime REAL, status TEXT NOT NULL DEFAULT 'pending',
    duration REAL, codec TEXT, sampleRate INTEGER, channels INTEGER, bitrate REAL, width INTEGER, height INTEGER, source TEXT, error TEXT
  ); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  if (!readonly && !db.query("PRAGMA table_info(files)").all().some(c => c.name === "source")) db.exec("ALTER TABLE files ADD COLUMN source TEXT");
  return db;
}

async function probe(file: string, native: NativeProbe, remaining: number) {
  const t0 = performance.now();
  let metadata: any;
  try { metadata = await native.read(file, Math.min(1000, remaining / 2)); }
  catch (e) { console.error(`fe: native reader unavailable; using ffprobe: ${e.message}`); }
  if (metadata) return [metadata.duration, metadata.codec, metadata.sampleRate, metadata.channels, null, null, null, "native-frames"];
  const task = exec(findBin("ffprobe"), ["-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-probesize", "1048576", "-analyzeduration", "1000000", "-threads", "1",
    "-show_entries", "format=duration,bit_rate:stream=codec_type,codec_name,duration,sample_rate,channels,width,height", "-of", "json", "-i", file],
  { timeout: Math.max(1, Math.min(3000, remaining - (performance.now() - t0))), maxBuffer: 65536, killSignal: "SIGKILL", env: { ...process.env, OMP_NUM_THREADS: "1" } });
  track(task.child);
  const { stdout } = await task;
  const parsed = JSON.parse(stdout);
  const streams = parsed.streams || [];
  const stream = streams.find((s: any) => s.codec_type === (kind(file) === "audio" ? "audio" : "video")) || streams[0];
  if (!stream) throw new Error("No readable media stream");
  const number = (v: unknown) => { const n = Number(v); return v != null && Number.isFinite(n) && n >= 0 ? n : null; };
  if (kind(file) === "audio" && (!(number(parsed.format?.duration ?? stream.duration) > 0) || !(number(stream.sample_rate) > 0))) throw new Error("No valid audio duration/sample rate; container cannot be decoded reliably");
  return [number(parsed.format?.duration ?? stream.duration), stream.codec_name || null, number(stream.sample_rate), number(stream.channels), number(parsed.format?.bit_rate), number(stream.width), number(stream.height), "ffprobe-container"];
}

const READER_VERSION = "audio-metadata-v2";
function classify(file: string, size: number): string | undefined {
  if (!size) return "empty";
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); if (b.readUInt32BE(0) === 0x00051607) return "appledouble"; }
  finally { fs.closeSync(fd); }
}

// Explicit repair and event updates share a canonical, fingerprinted negative cache.
export async function repairMedia(index: string, maxFiles = 500, seconds = 60, changedPaths?: string[]) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000 || seconds < 1 || seconds > 300) throw new Error("Invalid repair budget");
  if (!fs.existsSync(mediaPath(index))) return { index, inspected: 0, recovered: 0, failed: 0, excluded: 0, reused: 0, pending: 0 };
  const release = acquireLock(mediaPath(index) + ".lock"), native = new NativeProbe();
  const db = openStore(index), deadline = performance.now() + seconds * 1000;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS attempts (canonical TEXT PRIMARY KEY,size INTEGER,mtime REAL,version TEXT,status TEXT,values_json TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS aliases (path TEXT PRIMARY KEY,canonical TEXT); CREATE INDEX IF NOT EXISTS aliases_target ON aliases(canonical);`);
    let paths: string[];
    if (changedPaths) {
      paths = [...new Set(changedPaths.flatMap(p => [p, ...db.query("SELECT path FROM aliases WHERE canonical=?").all(p).map(r => r.path)]))];
      const soundsFile = path.join(INDEX_DIR,`sound-${validateName(index)}.sqlite`);
      if (fs.existsSync(soundsFile)) {
        const sounds = new Database(soundsFile,{readonly:true});
        try { if (sounds.query("SELECT 1 FROM sqlite_master WHERE name='aliases'").get()) paths = [...new Set([...paths,...changedPaths.flatMap(p => sounds.query("SELECT path FROM aliases WHERE canonical=?").all(p).map(r=>r.path))])]; }
        finally { sounds.close(); }
      }
      db.transaction(() => {
        for (const p of paths) {
          if (!fs.existsSync(p)) { db.query("DELETE FROM files WHERE path=?").run(p); db.query("DELETE FROM aliases WHERE path=?").run(p); }
          else if (kind(p) !== "unknown" && fs.statSync(p).isFile()) db.query("INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)").run(p, kind(p));
        }
      })();
    } else paths = db.query("SELECT path FROM files WHERE kind='audio' AND status<>'excluded' AND (status<>'ok' OR duration IS NULL) ORDER BY path").all().map(r => r.path);
    const groups = new Map<string, string[]>();
    for (const p of paths) {
      if (!db.query("SELECT path FROM files WHERE path=?").get(p)) continue;
      let canonical: string;
      try { canonical = fs.realpathSync(p); } catch { canonical = p; }
      const group = groups.get(canonical) || []; group.push(p); groups.set(canonical, group);
    }
    let inspected = 0, recovered = 0, failed = 0, excluded = 0, reused = 0, pending = 0;
    const reasons: Record<string, number> = {};
    const update = db.query("UPDATE files SET size=?,mtime=?,status=?,duration=?,codec=?,sampleRate=?,channels=?,bitrate=?,width=?,height=?,source=?,error=? WHERE path=?");
    const writes: (() => void)[] = [];
    const flush = () => { if(writes.length) db.transaction(() => { for(const write of writes) write(); })(); writes.length=0; };
    for (const [canonical, aliases] of groups) {
      if (performance.now() >= deadline - 50) { pending += aliases.length; continue; }
      let stat: fs.Stats;
      try { stat = fs.statSync(canonical); if (!stat.isFile()) throw new Error("Not a file"); }
      catch { db.transaction(() => { for (const p of aliases) db.query("UPDATE files SET status='missing',duration=NULL,error='File missing' WHERE path=? AND status<>'missing'").run(p); })(); failed += aliases.length; continue; }
      const old = db.query("SELECT * FROM attempts WHERE canonical=?").get(canonical);
      if (changedPaths && !old && aliases.every(p => { const row=db.query("SELECT size,mtime,status,duration FROM files WHERE path=?").get(p); return row?.size===stat.size && row.mtime===stat.mtimeMs && row.status==='ok' && row.duration!=null; })) { reused+=aliases.length; continue; }
      if (old?.size === stat.size && old.mtime === stat.mtimeMs && old.version === READER_VERSION) {
        reused += aliases.length;
        // A newly created alias must inherit its target's cached result too.
        db.transaction(() => { for (const p of aliases) {
          const row = db.query("SELECT size,mtime,status,duration FROM files WHERE path=?").get(p);
          if (row.size !== stat.size || row.mtime !== stat.mtimeMs || row.status !== old.status || row.duration !== JSON.parse(old.values_json)[0]) update.run(stat.size,stat.mtimeMs,old.status,...JSON.parse(old.values_json),old.error,p);
        } })();
        continue;
      }
      if (inspected >= maxFiles) { pending += aliases.length; continue; }
      inspected++;
      let status = "ok", values: any[] = Array(8).fill(null), error: string | null = null;
      try {
        const special = classify(canonical, stat.size);
        if (special) { status = special === "appledouble" ? "excluded" : "failed"; error = special; }
        else values = await probe(canonical, native, deadline - performance.now());
        const after = fs.statSync(canonical);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) { pending += aliases.length; continue; }
      } catch (e) { if(e.code === "ENOENT") throw new Error("ffprobe or the audio file is unavailable; retry after resolving it"); status = "failed"; error = String(e.stderr || e.message).slice(-400); }
      writes.push(() => {
        db.query("INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?,?,?)").run(canonical, stat.size, stat.mtimeMs, READER_VERSION, status, JSON.stringify(values), error);
        for (const p of aliases) {
          update.run(stat.size, stat.mtimeMs, status, ...values, error, p);
          db.query("INSERT INTO aliases VALUES (?,?) ON CONFLICT(path) DO UPDATE SET canonical=excluded.canonical WHERE canonical<>excluded.canonical").run(p, canonical);
        }
      });
      if(writes.length>=64) flush();
      if (status === "ok") recovered += aliases.length;
      else if (status === "excluded") excluded += aliases.length;
      else failed += aliases.length;
      if (error) reasons[error] = (reasons[error] || 0) + aliases.length;
    }
    flush();
    return { index, paths: paths.length, unique: groups.size, inspected, recovered, failed, excluded, reused, pending, reasons, reader: READER_VERSION };
  } finally { native.close(); db.close(); release(); }
}

export async function enrichMedia(index: string, maxFiles = 500, seconds = 60, mediaKind = "audio") {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000 || !Number.isFinite(seconds) || seconds < 1 || seconds > 300 || !["audio", "video", "image", "media"].includes(mediaKind)) throw new Error("Invalid enrichment budget or kind");
  fs.mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
  const release = acquireLock(mediaPath(index) + ".lock");
  const deadline = performance.now() + seconds * 1000;
  const native = new NativeProbe();
  let db: Database;
  try {
    const currentStamp = stamp(index), delta = deltaFor(index);
    db = openStore(index);
    const oldStamp = db.query("SELECT value FROM meta WHERE key='indexStamp'").get()?.value;
    if (oldStamp !== currentStamp || (db.query("SELECT value FROM meta WHERE key='deltaRevision'").get()?.value || "0") !== String(delta.revision)) {
      let output = "";
      try { output = (await exec(RG, ["-i", "--no-filename", "--", MEDIA_PATTERN, indexPathFor(index)], { maxBuffer: 16 * 1024 * 1024, timeout: Math.min(30000, seconds * 1000), killSignal: "SIGKILL" })).stdout; }
      catch (e) { if (e.code !== 1) throw e; }
      const paths = [...new Set([...output.split("\n").filter(p => p && delta.visible(p)),...delta.additions.filter(p => kind(p) !== "unknown")])];
      if (paths.length > 100000) throw new Error("More than 100000 media paths; create a smaller folder index");
      if (stamp(index) !== currentStamp) throw new Error("Index changed during media discovery; retry");
      if (deltaFor(index).revision !== delta.revision) throw new Error("Incremental paths changed during media discovery; retry");
      db.exec("CREATE TEMP TABLE seen (path TEXT PRIMARY KEY)");
      const seen = db.query("INSERT INTO seen VALUES (?)");
      const add = db.query("INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)");
      db.transaction(() => {
        for (const p of paths) { seen.run(p); add.run(p, kind(p)); }
        db.exec("DELETE FROM files WHERE path NOT IN (SELECT path FROM seen)");
        db.query("INSERT OR REPLACE INTO meta VALUES ('indexStamp',?)").run(currentStamp);
        db.query("INSERT OR REPLACE INTO meta VALUES ('deltaRevision',?)").run(String(delta.revision));
      })();
      db.exec("DROP TABLE seen");
    }
    let probed = 0, reused = 0, failed = 0, pending = 0, changed = 0;
    const rows = db.query("SELECT path,size,mtime,status FROM files WHERE (?='media' OR kind=?) ORDER BY path").all(mediaKind, mediaKind);
    const updates: any[][] = [];
    const update = db.query("UPDATE files SET size=?,mtime=?,status=?,duration=?,codec=?,sampleRate=?,channels=?,bitrate=?,width=?,height=?,source=?,error=? WHERE path=?");
    const flush = () => { if (!updates.length) return; db.transaction(() => { for (const values of updates) update.run(...values); })(); updates.length = 0; };
    const queue = (values: any[]) => { updates.push(values); if (updates.length >= 64) flush(); };
    for (const row of rows) {
      if (performance.now() >= deadline) { pending++; continue; }
      let s: fs.Stats;
      try { s = fs.statSync(row.path); if (!s.isFile()) throw new Error("Not a file"); }
      catch { if (row.status === "missing") reused++; else queue([null, null, "missing", null, null, null, null, null, null, null, null, "File missing", row.path]); continue; }
      if (s.size === row.size && s.mtimeMs === row.mtime && row.status !== "pending") { reused++; continue; }
      if (probed >= maxFiles || deadline - performance.now() < 100) { pending++; continue; }
      probed++; changed++;
      try {
        const values = await probe(row.path, native, deadline - performance.now());
        const after = fs.statSync(row.path);
        if (s.size !== after.size || s.mtimeMs !== after.mtimeMs) throw new Error("File changed during extraction");
        queue([s.size, s.mtimeMs, "ok", ...values, null, row.path]);
      } catch (e) { if (e.code === "ENOENT") throw new Error("ffprobe is required for unsupported formats; install it and repeat enrichment"); failed++; queue([s.size, s.mtimeMs, "failed", null, null, null, null, null, null, null, null, String(e.message).slice(0, 300), row.path]); }
    }
    flush();
    const counts = db.query("SELECT status,count(*) AS count FROM files WHERE (?='media' OR kind=?) GROUP BY status").all(mediaKind, mediaKind);
    return { index, kind: mediaKind, total: rows.length, probed, native: native.used, fallback: probed - native.used, reused, failed, changed, pending, counts,
      complete: pending === 0 && counts.every(r => r.status === "ok"), database: mediaPath(index), snapshot: currentStamp };
  } finally { native.close(); db?.close(); release(); }
}

export function searchMedia(query: string, index: string, pq: ParsedQuery, limit: number, offset = 0) {
  const delta = deltaFor(index);
  if (pq.mediaFilters.some(f => !Object.values(MEDIA_FIELDS).includes(f.field) || !["<", ">", "<=", ">=", "="].includes(f.op) || !Number.isFinite(f.value))) throw new Error("Invalid media predicate");
  const remedy = `Run fe enrich --index ${index} --kind media (or --kind audio for sounds); repeat until pending is 0.`;
  if (!fs.existsSync(mediaPath(index))) return { paths: [] as string[], media: [], complete: false, warnings: ["Media metadata has not been indexed. " + remedy], coverage: { known: 0, unknown: null } };
  const db = openStore(index, true);
  db.exec("BEGIN");
  try {
    const snapshotCurrent = db.query("SELECT value FROM meta WHERE key='indexStamp'").get()?.value === stamp(index);
    const constraints = pq.constraints.map(c => ({ re: new RegExp(c.pattern, "i"), negate: c.negate }));
    const groups = pq.fuzzy.map(t => t.replace(/^'/, "").split("|").map(s => s.toLowerCase()));
    const favorites=pq.favorites?new Set(pq.favorites):null;
    const matchesPath = (p: string) => (!favorites||favorites.has(p))&&!omitted(p,pq.omit)&&constraints.every(c => c.re.test(p) !== c.negate) && groups.every(g => g.some(s => p.toLowerCase().includes(s)));
    const fields = [...new Set(pq.mediaFilters.map(f => f.field))];
    const baseSql = "SELECT path,status," + fields.join(",") + " FROM files WHERE status<>'excluded'";
    const baseRows = db.query(baseSql).all().filter(r => matchesPath(r.path) && delta.visible(r.path));
    const unknown = baseRows.filter(r => r.status !== "ok" || fields.some(f => r[f] === null)).length;
    const condition = pq.mediaFilters.map(f => `${f.field} ${f.op} ?`).join(" AND ");
    const selectSql = `SELECT * FROM files WHERE status='ok' AND ${condition}`;
    let rows = db.query(selectSql).all(...pq.mediaFilters.map(f => f.value)).filter(r => matchesPath(r.path) && delta.visible(r.path));
    if (pq.sizeFilter) rows = rows.filter(r => matchesSize(r.size,pq.sizeFilter));
    if (pq.dmFilter) rows = rows.filter(r => Date.now() - r.mtime < pq.dmFilter.days * 86400000);
    const sort = pq.sort;
    if (sort && sort!=='relevance') rows.sort((a,b)=>compareSearchProperties(a,b,sort));
    else if(pq.smart||sort==='relevance'){
      const boosts=new Map((pq.learned||[]).map(s=>[s.path,s.boost]));
      const scores=new Map(rows.map(r=>[r.path,relevanceScore(r.path,pq,boosts.get(r.path)||0)]));
      rows.sort((a,b)=>scores.get(a.path)!-scores.get(b.path)!||compareSearchProperties(a,b,'name'));
    }else {
      const order = new Map(rerank(rows.map(r => r.path), query).map((p, i) => [p, i]));
      rows.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
    }
    let invalid = 0;
    const selected = [];
    let consumed = offset;
    for (const row of rows.slice(offset)) {
      consumed++;
      try { const s = fs.statSync(row.path); if (s.size !== row.size || s.mtimeMs !== row.mtime) { invalid++; continue; } }
      catch { invalid++; continue; }
      selected.push(row); if (selected.length >= limit) break;
    }
    const warnings: string[] = [];
    if (unknown || !snapshotCurrent || invalid) warnings.push(`Media snapshot: ${unknown} unknown, ${invalid} changed/missing matches${snapshotCurrent ? "" : ", path index changed"}. ${remedy}`);
    return { paths: selected.map(r => r.path), media: selected.map(({ error: _error, status: _status, ...r }) => r), complete: unknown === 0 && snapshotCurrent && invalid === 0,
      warnings, coverage: { known: baseRows.length - unknown, unknown, snapshotCurrent, matched: rows.length, limited: rows.length > selected.length },
      offset, nextOffset: consumed < rows.length ? consumed : null, snapshotId: `${stamp(index)}:${fs.statSync(mediaPath(index)).mtimeMs}`, snapshot: true };
  } finally { db.exec("ROLLBACK"); db.close(); }
}
