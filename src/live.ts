import * as fs from "fs";
import * as path from "path";
import {cachedFileProperties,searchIndexPath,syncSearch} from './path-search';
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { createInterface } from "readline";
import { Database } from "bun:sqlite";
import { acquireLock, CONFIG_DIR } from "./catalog";
import { scanExcludes, FD, HOME, INDEX_DIR, effectiveOptions, indexStatus, track } from "./engine";
import { baseStamp, openLive, livePath, LIVE_PATH_LIMIT } from "./delta";
import { repairMedia, mediaPath } from "./media";
import { refreshSounds } from "./semantic";
const exec = promisify(execFile);
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
function excluded(p:string,root:string,patterns:string[]) {
  const relative=path.relative(root,p),parts=relative.split(path.sep);
  return patterns.some(e=>e.startsWith('/') ? relative===e.slice(1)||relative.startsWith(e.slice(1)+'/') : new Bun.Glob(e).match(relative)||parts.some(part=>new Bun.Glob(e).match(part)));
}
declare const Bun: { Glob: new (pattern: string) => { match(path: string): boolean } };
const helper = () => process.env.FE_EVENTS_HELPER || path.join(HOME,"Applications/Find Everything.app/Contents/Helpers/fe-events");
type Event = { path: string; flags: number; scopes?:string[] };

export async function startLive(names?: string[], delay = 300,canSyncSearch:()=>boolean=()=>true) {
  fs.mkdirSync(INDEX_DIR,{recursive:true,mode:0o700});
  const binary = helper(); if (!binary || process.platform !== "darwin") throw new Error("macOS fe-events helper is required for persistent incremental indexing");
  const release = acquireLock(livePath()+".lock"), db = openLive();
  db.query("UPDATE jobs SET failures=0,retryAt=0 WHERE failures>0").run();
  let stopped = false, running = false, timer: ReturnType<typeof setTimeout>, jobsTimer: ReturnType<typeof setTimeout>;
  let child: ReturnType<typeof spawn>, lines: ReturnType<typeof createInterface>;
  let scopeList: ReturnType<typeof indexStatus> = [];
  const siblings = new Map<string,Set<string>>();
  const queue = new Map<string, { uuid?: string; cursor?: string; gap?: string; events: Event[] }>();
  const stop = () => { if (stopped) return; stopped = true; clearTimeout(timer); clearTimeout(jobsTimer); child?.kill("SIGKILL"); lines?.close(); catalogWatch?.close(); indexWatch?.close(); if (!running) { db.close(); release(); } };
  process.once("exit",stop);
  let catalogWatch: fs.FSWatcher, indexWatch: fs.FSWatcher;
  const problem = (name: string, text: string) => db.query("UPDATE scopes SET problem=? WHERE name=? AND (problem IS NULL OR problem<>?)").run(text,name,text);
  async function jobs() {
    if (stopped || running) return;
    running = true;
    try {
      const rows = db.query("SELECT scope,path FROM jobs WHERE failures<3 AND retryAt<=? LIMIT 8").all(Date.now());
      for (const scope of new Set(rows.map(r => r.scope))) {
        const paths = rows.filter(r => r.scope === scope).map(r => r.path);
        try {
          const r = await repairMedia(scope,8,4,paths);
          const sounds = !r.pending ? await refreshSounds(scope,paths) : undefined;
          if (!r.pending && !sounds?.pending) db.transaction(() => { for (const p of paths) db.query("DELETE FROM jobs WHERE scope=? AND path=?").run(scope,p); })();
        } catch (e) {
          db.transaction(() => { for(const p of paths) db.query("UPDATE jobs SET failures=failures+1,retryAt=? WHERE scope=? AND path=?").run(Date.now()+30000,scope,p); })();
          problem(scope, `Metadata update pending: ${e.message}`);
        }
        if (!db.query("SELECT 1 FROM jobs WHERE scope=? LIMIT 1").get(scope)) db.query("UPDATE scopes SET problem=NULL WHERE name=? AND problem LIKE 'Metadata update pending:%'").run(scope);
      }
    } finally { running = false; if (stopped) { db.close(); release(); } else if (db.query("SELECT 1 FROM jobs WHERE failures<3 LIMIT 1").get()) jobsTimer = setTimeout(() => void jobs(),1000); }
  }
  async function accepted(p: string, scope: typeof scopeList[number]): Promise<boolean> {
    const opts = effectiveOptions(scope.name), root = scope.paths.find(r => under(p,r));
    if (!root) return false;
    const relative = path.relative(root,p), parts = relative.split(path.sep);
    const exclusions = scanExcludes(scope.name,opts);
    if ((!opts.includeHidden && parts.some(s => s.startsWith("."))) || excluded(p,root,exclusions)) return false;
    if (opts.includeIgnored) return true;
    // fd evaluates the same inherited ignore rules; --max-depth prevents a subtree walk.
    const parent = path.dirname(p);
    const cacheKey = scope.name+":"+parent;
    if (siblings.has(cacheKey)) return siblings.get(cacheKey)!.has(p);
    try {
      const args = ["--absolute-path","--color=never","--print0","--threads","1","--max-depth","1","--hidden"];
      for (const e of exclusions) args.push("--exclude",e);
      const task = exec(FD,[...args,"--", "", parent],{timeout:2000,maxBuffer:2*1024*1024,killSignal:"SIGKILL"}); track(task.child);
      const allowed = new Set((await task).stdout.split("\0").map(x => x.replace(/\/$/,"")));
      siblings.set(cacheKey,allowed); return allowed.has(p);
    } catch (e) {
      try {fs.lstatSync(parent);} catch(statError) {if(statError.code==='ENOENT'||statError.code==='ENOTDIR')return false;}
      throw new Error(`Ignore check failed: ${e.message}`);
    }
  }
  async function subtree(p: string, scope: typeof scopeList[number]) {
    const opts = effectiveOptions(scope.name), args = ["--absolute-path","--color=never","--print0","--threads","1"];
    if (opts.includeHidden) args.push("--hidden"); if (opts.includeIgnored) args.push("--no-ignore");
    for (const e of scanExcludes(scope.name,opts)) args.push("--exclude",e);
    const task = exec(FD,[...args,"--","",p],{timeout:5000,maxBuffer:8*1024*1024,killSignal:"SIGKILL"}); track(task.child);
    const paths = (await task).stdout.split("\0").filter(Boolean).map(x => x.replace(/\/$/,""));
    if (paths.length > 20000) throw new Error("Changed subtree exceeds 20000 paths; explicit reconciliation required");
    return paths;
  }
  async function flush() {
    if (stopped) return;
    if (running) { timer = setTimeout(() => void flush(),delay); return; }
    running = true;
    siblings.clear();
    const batch = [...queue]; queue.clear();
    try {
      for (const [root, message] of batch) {
        const affected = scopeList.filter(s => s.paths.includes(root));
        const staged: {scope:typeof scopeList[number];changes:Map<string,{present:number;tree:number}>;gap?:string}[] = [];
        const unique = new Map<string,Event>();
        for (const event of message.events) { const previous=unique.get(event.path); unique.set(event.path,{...event,scopes:event.scopes && previous?.scopes ? [...new Set([...event.scopes,...previous.scopes])] : event.scopes,flags:event.flags | (previous?.flags || 0)}); }
        for (const scope of affected) {
          const deadline = performance.now()+5000;
          const changes = new Map<string,{present:number;tree:number}>();
          let gap = message.gap;
          for (const event of unique.values()) {
            if (event.scopes && !(event.flags & (1|2|4|8|16|32|64|128)) && !event.scopes.includes(scope.name)) continue;
            if (performance.now()>deadline) { gap="Event processing budget exceeded; explicit reconciliation required"; break; }
            const p = event.path.replace(/\/$/,"") || "/", flags = event.flags;
            if (!path.isAbsolute(p) || !under(p,root)) { gap = "Invalid event path"; continue; }
            if (flags & (2|4|8|32|64|128)) { gap = "Filesystem journal gap/root change; explicit reconciliation required"; continue; }
            // MustScanSubDirs only asks for a fresh scan of that directory. Rescanning it
            // keeps the scope exact; marking it as drifted made every reconcile end in a
            // gap marker that only another full rebuild could have cleared.
            if (flags & 1) {
              let directory = false;
              try { directory = fs.lstatSync(p).isDirectory(); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") gap = `Cannot read changed path: ${e.code}`; }
              if (directory) { try { for (const sub of await subtree(p,scope)) changes.set(sub,{present:1,tree:0}); } catch (e) { gap = e.message; } }
              continue;
            }
            if (flags & 16 || !scope.paths.some(r => under(p,r))) continue; // HistoryDone
            const relative = path.relative(scope.paths.find(r => under(p,r))!,p);
            const exclusions = scanExcludes(scope.name,scope.options);
            if ((!scope.options.includeHidden&&relative.split(path.sep).some(part=>part.startsWith('.'))) || excluded(p,scope.paths.find(r=>under(p,r))!,exclusions)) continue;
            if ([".gitignore",".ignore",".fdignore"].includes(path.basename(p))) {
              if (scope.options.includeIgnored) continue;
              const baseline = scope.scanStartedAt ? Date.parse(scope.scanStartedAt) : Date.parse(scope.indexedAt || "")-120000;
              if (!fs.existsSync(p) || fs.statSync(p).mtimeMs >= baseline) gap = "Ignore rules changed; explicit reconciliation required";
              continue;
            }
            const media = /\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|png|jpe?g|webp)$/i.test(p);
            const propertyChange=!!(flags & (1024|4096))&&fs.existsSync(searchIndexPath(scope.name));
            if (!(flags & (256|512|2048)) && !media && !propertyChange) continue;
            let stat: fs.Stats | undefined;
            try { stat = fs.lstatSync(p); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") { gap = `Cannot read changed path: ${e.code}`; continue; } }
            if (!stat) { changes.set(p,{present:0,tree:flags & 131072 ? 1 : 0}); continue; }
            const prior = db.query("SELECT present FROM changes WHERE scope=? AND path=?").get(scope.name,p);
            if(propertyChange&&!(flags & (256|512|2048))){
              try {const old=cachedFileProperties(scope.name,p);const current=stat.isSymbolicLink()?fs.statSync(p):stat;if(old?.size===current.size&&old?.mtime===current.mtimeMs&&old?.dir===Number(current.isDirectory()))continue;}
              catch(e){gap=`File property cache pending: ${String(e.message).slice(0,300)}`;}
            }
            if (!stat.isDirectory() && !media && prior?.present === 1 && !propertyChange) continue;
            let included=false;
            try {included=await accepted(p,scope);} catch(e) {gap=`Ignore check failed for ${scope.name}: ${String(e.message).slice(0,500)}`;continue;}
            if(!included){
              try {fs.lstatSync(p);} catch(e) {if(e.code==='ENOENT'||e.code==='ENOTDIR')changes.set(p,{present:0,tree:stat.isDirectory()?1:0});else gap=`Cannot confirm changed path: ${e.code}`;}
              continue;
            }
            if (stat.isDirectory() && !(flags & (256|2048))) continue;
            if (stat.isDirectory() && scope.paths.includes(p)) { gap="Root directory replaced; explicit reconciliation required"; continue; }
            changes.set(p,{present:1,tree:0});
            if (stat.isDirectory()) {
              try { for (const sub of await subtree(p,scope)) changes.set(sub,{present:1,tree:0}); }
              catch (e) { gap = e.message; }
            }
          }
          const count = db.query("SELECT count(*) AS n FROM changes WHERE scope=?").get(scope.name).n;
          let newPaths=0;
          for(const p of changes.keys())if(!db.query('SELECT 1 FROM changes WHERE scope=? AND path=?').get(scope.name,p))newPaths++;
          if (count + newPaths > LIVE_PATH_LIMIT) { gap = `Incremental overlay exceeds ${LIVE_PATH_LIMIT} paths; explicit compaction required`; changes.clear(); }
          staged.push({scope,changes,gap});
        }
        // Path deltas, durable metadata jobs and the shared root cursor commit together.
        db.transaction(() => {
          for (const {scope,changes,gap} of staged) {
            const revision = db.query("SELECT revision FROM scopes WHERE name=?").get(scope.name).revision + 1;
            for (const [p,c] of changes) {
              db.query("INSERT INTO changes VALUES (?,?,?,?,?) ON CONFLICT(scope,path) DO UPDATE SET present=excluded.present,tree=excluded.tree,revision=excluded.revision").run(scope.name,p,c.present,c.tree,revision);
              if (fs.existsSync(mediaPath(scope.name))) {
                if (c.tree && !c.present) {
                  const media = new Database(mediaPath(scope.name),{readonly:true});
                  try { for (const r of media.query("SELECT path FROM files WHERE substr(path,1,?)=?").all(p.length+1,p+"/")) db.query("INSERT OR IGNORE INTO jobs(scope,path) VALUES (?,?)").run(scope.name,r.path); } finally { media.close(); }
                }
                if (/\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|png|jpe?g|webp)$/i.test(p)) db.query("INSERT INTO jobs(scope,path) VALUES (?,?) ON CONFLICT(scope,path) DO UPDATE SET failures=0,retryAt=0").run(scope.name,p);
              }
            }
            if (changes.size) db.query("UPDATE scopes SET revision=?,lastChange=? WHERE name=?").run(revision,new Date().toISOString(),scope.name);
            if (gap) problem(scope.name,gap);
          }
          if ((staged.some(s => s.changes.size || s.gap) || message.events.some(e => e.flags & 16)) && message.cursor && message.uuid) db.query("INSERT INTO streams VALUES (?,?,?) ON CONFLICT(root) DO UPDATE SET uuid=excluded.uuid,cursor=excluded.cursor WHERE cursor<>excluded.cursor OR uuid<>excluded.uuid").run(root,message.uuid,message.cursor);
        })();
        for (const {scope,changes} of staged) {
          if (changes.size) {
            try {if(canSyncSearch())syncSearch(scope.name);}catch(e){console.error(`fe: fast lookup will catch up on query: ${String(e.message).slice(0,300)}`);}
            console.error(`fe: refreshed ${scope.name} incrementally (${changes.size} paths)`);
          }
        }
      }
    } catch (e) { for (const s of scopeList) problem(s.name,`Incremental update failed: ${e.message}`); }
    finally { running = false; if (stopped) { db.close(); release(); } else { if (queue.size) timer = setTimeout(() => void flush(),delay); jobsTimer = setTimeout(() => void jobs(),delay); } }
  }
  function configure() {
    child?.kill("SIGKILL"); lines?.close();
    scopeList = indexStatus().filter(s => s.exists && (!names || names.includes(s.name)));
    const roots = [...new Set(scopeList.flatMap(s => s.paths))];
    if (roots.length > 64) throw new Error("At most 64 independent live roots supported");
    db.transaction(() => { for (const s of scopeList) {
      const stamp = baseStamp(s.name), old = db.query("SELECT stamp FROM scopes WHERE name=?").get(s.name);
      if (old?.stamp !== stamp) {
        db.query("DELETE FROM changes WHERE scope=?").run(s.name); db.query("DELETE FROM jobs WHERE scope=?").run(s.name);
        for (const root of s.paths) db.query("DELETE FROM streams WHERE root=?").run(root);
      }
      db.query("INSERT INTO scopes(name,stamp,pid) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET stamp=excluded.stamp,pid=excluded.pid,problem=CASE WHEN stamp<>excluded.stamp THEN NULL ELSE problem END").run(s.name,stamp,process.pid);
      if (s.options.includeIgnored) db.query("UPDATE scopes SET problem=NULL WHERE name=? AND problem='Ignore rules changed; explicit reconciliation required'").run(s.name);
    } })();
    if (!roots.length) return;
    const config = roots.map(root => {
      const old = db.query("SELECT uuid,cursor FROM streams WHERE root=?").get(root);
      const targets=scopeList.filter(s=>s.paths.includes(root)).map(s=>({name:s.name,paths:s.paths,since:s.scanStartedAt ? Date.parse(s.scanStartedAt)/1000 : Date.parse(s.indexedAt || new Date().toISOString())/1000-120}));
      const since = Math.min(...targets.map(t=>t.since));
      // A shared watcher may suppress only exclusions common to every target.
      // Root/path-specific rules remain in the per-index event filter.
      const exclusions=scopeList.filter(s=>s.paths.includes(root)).map(s=>scanExcludes(s.name,s.options));
      const common=exclusions[0].filter(e=>!e.includes('/')&&exclusions.every(rules=>rules.includes(e)));
      return { path:root,since,...old,targets,excludes:common };
    });
    child = track(spawn(binary,[],{stdio:["pipe","pipe","pipe"]}));
    child.stdin.end(JSON.stringify({roots:config}));
    lines = createInterface({input:child.stdout}); let log = "";
    child.stderr.on("data",d => log=(log+d).slice(-1000));
    child.on("error",e => { for (const s of scopeList) problem(s.name,e.message); });
    const current = child;
    child.on("close",code => { if (!stopped && child === current) for (const s of scopeList) problem(s.name,`Event stream stopped (${code}): ${log}`); });
    lines.on("line",line => {
      try {
        if (line.length > 1024*1024) throw new Error("Event batch too large");
        const m = JSON.parse(line); if (!roots.includes(m.root)) throw new Error("Unexpected event root");
        if (m.ready) {
          console.error(`fe: watching ${m.root} using persistent FSEvents`);
          // A restart of the service is not lost data: drop only the marker the
          // previous helper left behind, keep gap/overlay problems.
          for (const s of scopeList) if (s.paths.includes(m.root)) db.query("UPDATE scopes SET problem=NULL WHERE name=? AND problem LIKE 'Event stream stopped (%'").run(s.name);
        }
        const previous = queue.get(m.root), events = [...(previous?.events || []),...(m.events || [])];
        if (events.length > 20000) { events.length=0; m.gap="Event backlog exceeds budget; explicit reconciliation required"; }
        queue.set(m.root,{uuid:m.uuid,cursor:m.cursor || previous?.cursor,gap:m.gap || previous?.gap,events});
        // Schedule from the first event; continuous filesystem activity must not starve commits.
        if (!previous) timer=setTimeout(() => void flush(),delay);
      } catch (e) { for (const s of scopeList) problem(s.name,e.message); }
    });
    jobsTimer = setTimeout(() => void jobs(),delay);
  }
  let configTimer: ReturnType<typeof setTimeout>;
  const reconfigure = () => { clearTimeout(configTimer); configTimer=setTimeout(() => { if (running) { reconfigure(); return; } try { configure(); } catch(e) { for(const s of scopeList) problem(s.name,e.message); } },500); };
  try {
    configure();
    if (fs.existsSync(CONFIG_DIR)) catalogWatch = fs.watch(CONFIG_DIR,(_e,file) => { if (file === "indexes.json") reconfigure(); });
    indexWatch = fs.watch(INDEX_DIR,(_e,file) => { if (/^index-.+\.json$/.test(String(file))) reconfigure(); });
  } catch(e) { stop(); throw e; }
  return () => { clearTimeout(configTimer); stop(); };
}
