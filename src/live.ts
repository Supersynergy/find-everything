import * as fs from "fs";
import * as path from "path";
import {cachedFileProperties,searchIndexPath,syncSearch} from './path-search';
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { createInterface } from "readline";
import { Database } from "bun:sqlite";
import { acquireLock, CONFIG_DIR } from "./catalog";
import { FD, HOME, INDEX_DIR, indexStatus, track } from "./engine";
import { openLive, livePath, LIVE_PATH_LIMIT, liveMergeThreshold, mergeLiveBatch } from "./delta";
import { repairMedia, mediaPath } from "./media";
import { refreshSounds } from "./semantic";
import {recoverPublishedCompaction} from './compaction-recovery';
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
  let stopped = false, running = false, timer: ReturnType<typeof setTimeout> | undefined, jobsTimer: ReturnType<typeof setTimeout>;
  let child: ReturnType<typeof spawn>, lines: ReturnType<typeof createInterface>;
  let scopeList: ReturnType<typeof indexStatus> = [];
  const siblings = new Map<string,Set<string>>();
  const overlayCounts = new Map<string,number>();
  let countsVersion = -1;
  const cursorSavedAt = new Map<string,number>();
  const threshold=liveMergeThreshold();
  let maintenance:ReturnType<typeof setTimeout>|undefined;
  const mergeScopes=new Set<string>();
  function scheduleMerge(wait=25){
    if(stopped||maintenance||!mergeScopes.size)return;
    maintenance=setTimeout(()=>{
      maintenance=undefined;
      const name=mergeScopes.values().next().value;
      if(!name)return;
      mergeScopes.delete(name);
      try{
        const removed=mergeLiveBatch(db,name);
        const cached=overlayCounts.get(name);
        if(cached!==undefined)overlayCounts.set(name,Math.max(0,cached-removed));
        if(db.query('SELECT 1 FROM merge_queue WHERE scope=?').get(name))mergeScopes.add(name);

      }catch(e){
        mergeScopes.add(name);
        console.error('fe: '+String(e.message).slice(0,300));
        scheduleMerge(30000);return;
      }
      scheduleMerge();
    },wait);
  }
  // Repairs can enqueue a watermark through another connection while this watcher
  // is idle. A primary-key probe for each configured scope needs no journal write.
  const discovery=setInterval(()=>{
    if(stopped)return;
    try{
      for(const scope of scopeList)if(db.query('SELECT 1 FROM merge_queue WHERE scope=?').get(scope.name))mergeScopes.add(scope.name);
      scheduleMerge();
    }catch(e){console.error('fe: could not read pending live merges: '+String(e.message).slice(0,300));}
  },5000);discovery.unref();
  const markMerge=(name:string,revision:number)=>{
    db.query('INSERT OR IGNORE INTO merge_queue VALUES (?,?)').run(name,revision);
    mergeScopes.add(name);
  };
  const priorChange = db.query('SELECT present,revision,tree FROM changes WHERE scope=? AND path=?');
  const mergedChange=db.query('SELECT present,revision,tree FROM merged_changes WHERE scope=? AND path=?');
  const newestBarrier=db.query('SELECT revision FROM tree_barriers WHERE scope=? AND path=? UNION ALL SELECT revision FROM changes WHERE scope=? AND path=? AND tree=1 ORDER BY revision DESC LIMIT 1');
  function alreadyPresent(scope:string,p:string) {
    const prior=priorChange.get(scope,p)??mergedChange.get(scope,p);
    if(!prior?.present)return false;
    for(let parent=path.dirname(p);;parent=path.dirname(parent)){
      if((newestBarrier.get(scope,parent,scope,parent)?.revision??-1)>prior.revision)return false;
      if(parent===path.dirname(parent))return true;
    }
  }
  const queue = new Map<string, { uuid?: string; cursor?: string; gap?: string; events: Map<string,Event> }>();
  const stop = () => { if (stopped) return; stopped = true; clearTimeout(timer); clearTimeout(jobsTimer); clearTimeout(maintenance); clearInterval(discovery); child?.kill("SIGKILL"); lines?.close(); catalogWatch?.close(); indexWatch?.close(); if (!running) { db.close(); release(); } };
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
    } finally {
      running = false;
      if (stopped) { db.close(); release(); }
      else {
        scheduleFlush();
        if (db.query("SELECT 1 FROM jobs WHERE failures<3 LIMIT 1").get()) jobsTimer = setTimeout(() => void jobs(),1000);
      }
    }
  }
  async function accepted(p: string, scope: typeof scopeList[number]): Promise<boolean> {
    const opts = scope.options, root = scope.paths.find(r => under(p,r));
    if (!root) return false;
    const relative = path.relative(root,p), parts = relative.split(path.sep);
    const exclusions = scope.exclusions;
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
    const opts = scope.options, args = ["--absolute-path","--color=never","--print0","--threads","1"];
    if (opts.includeHidden) args.push("--hidden"); if (opts.includeIgnored) args.push("--no-ignore");
    for (const e of scope.exclusions) args.push("--exclude",e);
    const task = exec(FD,[...args,"--","",p],{timeout:5000,maxBuffer:8*1024*1024,killSignal:"SIGKILL"}); track(task.child);
    const paths = (await task).stdout.split("\0").filter(Boolean).map(x => x.replace(/\/$/,""));
    if (paths.length > 20000) throw new Error("Changed subtree exceeds 20000 paths; explicit reconciliation required");
    return paths;
  }
  async function rescan(p:string,scope:typeof scopeList[number],changes:Map<string,{present:number;tree:number}>) {
    let paths:string[];
    try {paths=await subtree(p,scope);}
    catch(error){
      // Temporary directories can vanish or become files after lstat. Their
      // current state is authoritative; a genuine unreadable directory is a gap.
      let now:fs.Stats;
      try {now=fs.lstatSync(p);}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR'){changes.set(p,{present:0,tree:1});return;}throw e;}
      if(now.isDirectory())throw error;
      changes.set(p,{present:1,tree:1});return;
    }
    // Replace only after a successful, complete scan. Adding alone leaves
    // deleted descendants visible after coalesced directory notifications.
    changes.set(p,{present:scope.paths.includes(p)?0:1,tree:1});
    for(const sub of paths)changes.set(sub,{present:1,tree:0});
  }
  function scheduleFlush() {
    if (running || stopped || timer || !queue.size) return;
    timer = setTimeout(() => { timer = undefined; void flush(); },delay);
  }
  async function flush() {
    if (stopped) return;
    if (running) return;
    running = true;
    siblings.clear();
    const batch = [...queue]; queue.clear();
    try {
      while(batch.length) {
        const [root,message]=batch[0];
        const affected = scopeList.filter(s => s.paths.includes(root));
        const staged: {scope:typeof scopeList[number];changes:Map<string,{present:number;tree:number}>;gap?:string}[] = [];
        const unique = message.events;
        for (const scope of affected) {
          let nextYield = performance.now()+25;
          const changes = new Map<string,{present:number;tree:number}>();
          let gap = message.gap;
          for (const event of unique.values()) {
            if (event.scopes && !(event.flags & (1|2|4|8|16|32|64|128)) && !event.scopes.includes(scope.name)) continue;
            if (performance.now() >= nextYield) {
              await new Promise<void>(resolve => setImmediate(resolve));
              if (stopped) return;
              nextYield = performance.now()+25;
            }
            const p = event.path.replace(/\/$/,"") || "/", flags = event.flags;
            if (!path.isAbsolute(p) || !under(p,root)) { gap = "Invalid event path"; continue; }
            if (flags & (2|4|8|32|64|128)) { gap = "Filesystem journal gap/root change; explicit reconciliation required"; continue; }
            // MustScanSubDirs only asks for a fresh scan of that directory. Rescanning it
            // keeps the scope exact; marking it as drifted made every reconcile end in a
            // gap marker that only another full rebuild could have cleared.
            if (flags & 1) {
              let directory = false;
              try { directory = fs.lstatSync(p).isDirectory(); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") changes.set(p,{present:0,tree:1});else gap = `Cannot read changed path: ${e.code}`; }
              if (directory) { try { await rescan(p,scope,changes); } catch (e) { gap = e.message; } }
              continue;
            }
            if (flags & 16 || !scope.paths.some(r => under(p,r))) continue; // HistoryDone
            const relative = path.relative(scope.paths.find(r => under(p,r))!,p);
            const exclusions = scope.exclusions;
            if ((!scope.options.includeHidden&&relative.split(path.sep).some(part=>part.startsWith('.'))) || excluded(p,scope.paths.find(r=>under(p,r))!,exclusions)) continue;
            // A lookup may update its own database on each query. Keep membership
            // events, but do not feed its continuously changing properties back into it.
            const membership = !!(flags & (256|512|2048));
            if (!membership && path.dirname(p)===INDEX_DIR &&
                /^(?:live|(?:counts|search|media|sound)-[a-zA-Z0-9_-]+)\.sqlite(?:-journal|-wal|-shm|\.lock)?$/.test(path.basename(p))) continue;
            if (!scope.options.includeIgnored && [".gitignore",".ignore",".fdignore"].includes(path.basename(p))) {
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
            if(propertyChange&&!(flags & (256|512|2048))){
              try {const old=cachedFileProperties(scope.name,p);const current=stat.isSymbolicLink()?fs.statSync(p):stat;if(old?.size===current.size&&old?.mtime===current.mtimeMs&&old?.dir===Number(current.isDirectory()))continue;}
              catch(e){gap=`File property cache pending: ${String(e.message).slice(0,300)}`;}
            }
            if (!stat.isDirectory() && !media && !propertyChange && alreadyPresent(scope.name,p)) continue;
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
              try { await rescan(p,scope,changes); }
              catch (e) { gap = e.message; }
            }
          }
          staged.push({scope,changes,gap});
        }
        // Path deltas, durable metadata jobs and the shared root cursor commit together.
        const now = performance.now();
        const historyDone = [...message.events.values()].some(e => e.flags & 16);
        const checkpointDue = now - (cursorSavedAt.get(root) ?? 0) >= 60_000;
        let savedCursor = false;
        db.transaction(() => {
          const version = db.query('PRAGMA data_version').get().data_version;
          if (countsVersion !== version) { overlayCounts.clear(); countsVersion = version; }
          for (const item of staged) {
            const {scope,changes} = item;
            db.query("UPDATE scopes SET problem=NULL WHERE name=? AND problem LIKE 'Incremental update failed:%'").run(scope.name);
            let count = overlayCounts.get(scope.name);
            const revision = db.query("SELECT revision FROM scopes WHERE name=?").get(scope.name).revision + 1;
            for (const [p,c] of changes) {
              const hot=priorChange.get(scope.name,p);
              const old=hot??mergedChange.get(scope.name,p);
              if(!c.present&&!c.tree&&old?.present===0){changes.delete(p);continue;}
              // Keep the subtree watermark when a later exact event replaces this row.
              if(hot?.tree&&!c.tree)db.query('INSERT INTO tree_barriers VALUES (?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=max(revision,excluded.revision)').run(scope.name,p,hot.revision);
              count??=db.query('SELECT count(*) AS n FROM changes WHERE scope=?').get(scope.name).n as number;
              // A large packet can arrive at the cap between maintenance ticks.
              // Write new paths straight into the durable layer in this transaction.
              const table=count>=LIVE_PATH_LIMIT&&!hot?'merged_changes':'changes';
              db.query(`INSERT INTO ${table} VALUES (?,?,?,?,?) ON CONFLICT(scope,path) DO UPDATE SET present=excluded.present,tree=excluded.tree,revision=excluded.revision`).run(scope.name,p,c.present,c.tree,revision);
              if(table==='merged_changes'&&(c.tree||old?.tree))db.query('INSERT INTO tree_barriers VALUES (?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=max(revision,excluded.revision)').run(scope.name,p,c.tree?revision:old.revision);
              if(table==='changes'&&!hot)count++;
              if (fs.existsSync(mediaPath(scope.name))) {
                if (c.tree && !c.present) {
                  const media = new Database(mediaPath(scope.name),{readonly:true});
                  const prefix=p.replace(/\/$/,'')+'/';
                  try { for (const r of media.query("SELECT path FROM files WHERE path>=? AND path<?").all(prefix,prefix.slice(0,-1)+'0')) db.query("INSERT OR IGNORE INTO jobs(scope,path) VALUES (?,?)").run(scope.name,r.path); } finally { media.close(); }
                }
                if (/\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|png|jpe?g|webp)$/i.test(p)) db.query("INSERT INTO jobs(scope,path) VALUES (?,?) ON CONFLICT(scope,path) DO UPDATE SET failures=0,retryAt=0").run(scope.name,p);
              }
            }
            if(count!==undefined){
              overlayCounts.set(scope.name,count);
              if(count>=threshold)markMerge(scope.name,revision);
            }
            if (!changes.size) { if (item.gap) problem(scope.name,item.gap); continue; }
            db.query("UPDATE scopes SET revision=?,lastChange=? WHERE name=?").run(revision,new Date().toISOString(),scope.name);
            if (item.gap) problem(scope.name,item.gap);
          }
          if ((staged.some(s => s.changes.size || s.gap) || historyDone || checkpointDue) && message.cursor && message.uuid) {
            savedCursor = true;
            db.query("INSERT INTO streams VALUES (?,?,?) ON CONFLICT(root) DO UPDATE SET uuid=excluded.uuid,cursor=excluded.cursor WHERE cursor<>excluded.cursor OR uuid<>excluded.uuid").run(root,message.uuid,message.cursor);
          }
        })();
        batch.shift();
        scheduleMerge();
        if (savedCursor) cursorSavedAt.set(root,now);
        for (const {scope,changes} of staged) {
          if (changes.size) {
            try {if(canSyncSearch())syncSearch(scope.name);}catch(e){console.error(`fe: fast lookup will catch up on query: ${String(e.message).slice(0,300)}`);}
            console.error(`fe: refreshed ${scope.name} incrementally (${changes.size} paths)`);
          }
        }
      }
    } catch (e) { overlayCounts.clear();
      // Keep the uncommitted packet ahead of a newer cursor for the same root.
      for(const [root,older] of batch){
        const newer=queue.get(root);
        if(!newer){queue.set(root,older);continue;}
        for(const [p,event] of older.events){
          const current=newer.events.get(p);
          if(!current)newer.events.set(p,event);
          else{current.flags|=event.flags;current.scopes=current.scopes&&event.scopes?[...new Set([...current.scopes,...event.scopes])]:undefined;}
        }
        newer.gap??=older.gap;
      }
      for(const s of scopeList)try{db.query("UPDATE scopes SET problem=? WHERE name=? AND problem IS NULL").run(`Incremental update failed: ${e.message}`,s.name);}catch{}
      console.error('fe: retrying uncommitted filesystem packet: '+String(e.message).slice(0,300));
      if(!stopped&&!timer)timer=setTimeout(()=>{timer=undefined;void flush();},1000); }
    finally {
      running = false;
      if (stopped) { db.close(); release(); }
      else {
        // Give pending metadata work a turn before a continuous stream starts the next flush.
        clearTimeout(jobsTimer);
        jobsTimer = setTimeout(() => void jobs(),delay);
        scheduleFlush();
      }
    }
  }
  function configure() {
    overlayCounts.clear();mergeScopes.clear();
    child?.kill("SIGKILL"); lines?.close();
    scopeList = indexStatus().filter(s => s.exists && (!names || names.includes(s.name)));
    const roots = [...new Set(scopeList.flatMap(s => s.paths))];
    if (roots.length > 64) throw new Error("At most 64 independent live roots supported");
    for(const s of scopeList)recoverPublishedCompaction(path.join(INDEX_DIR,`index-${s.name}.txt`));
    // Take the journal write lock before reading filesystem stamps. A publisher
    // holds the same lock while swapping files, so reconfiguration cannot erase
    // post-watermark events using an earlier observation of the path snapshot.
    db.exec('BEGIN IMMEDIATE');
    try { for (const s of scopeList) {
      const stat=fs.statSync(path.join(INDEX_DIR,`index-${s.name}.txt`));
      const stamp = `${stat.mtimeMs}:${stat.size}`, old = db.query("SELECT stamp FROM scopes WHERE name=?").get(s.name);
      if (old?.stamp !== stamp) {
        for(const table of ['changes','merged_changes','tree_barriers','merge_queue'])db.query('DELETE FROM '+table+' WHERE scope=?').run(s.name); db.query("DELETE FROM jobs WHERE scope=?").run(s.name);
        for (const root of s.paths) db.query("DELETE FROM streams WHERE root=?").run(root);
      }
      db.query("INSERT INTO scopes(name,stamp,pid) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET stamp=excluded.stamp,pid=excluded.pid,problem=CASE WHEN stamp<>excluded.stamp THEN NULL ELSE problem END").run(s.name,stamp,process.pid);
      const count=db.query('SELECT count(*) AS n FROM changes WHERE scope=?').get(s.name).n;
      overlayCounts.set(s.name,count);
      if(db.query('SELECT 1 FROM merge_queue WHERE scope=?').get(s.name))mergeScopes.add(s.name);
      else if(count>=threshold)markMerge(s.name,db.query('SELECT revision FROM scopes WHERE name=?').get(s.name).revision);
      if (s.options.includeIgnored) db.query("UPDATE scopes SET problem=NULL WHERE name=? AND problem='Ignore rules changed; explicit reconciliation required'").run(s.name);
    } db.exec('COMMIT'); }catch(error){if(db.inTransaction)db.exec('ROLLBACK');throw error;}
    scheduleMerge();
    if (!roots.length) return;
    const config = roots.map(root => {
      const old = db.query("SELECT uuid,cursor FROM streams WHERE root=?").get(root);
      const targets=scopeList.filter(s=>s.paths.includes(root)).map(s=>({name:s.name,paths:s.paths,since:s.scanStartedAt ? Date.parse(s.scanStartedAt)/1000 : Date.parse(s.indexedAt || new Date().toISOString())/1000-120}));
      const since = Math.min(...targets.map(t=>t.since));
      // A shared watcher may suppress only exclusions common to every target.
      // Root/path-specific rules remain in the per-index event filter.
      const exclusions=scopeList.filter(s=>s.paths.includes(root)).map(s=>s.exclusions);
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
        const previous = queue.get(m.root), events = previous?.events || new Map<string,Event>();
        // Replays often repeat metadata events thousands of times for one path.
        // Bound distinct pending paths, retaining every flag and target scope.
        for(const event of (m.events || []) as Event[]){
          const old=events.get(event.path);
          events.set(event.path,{...event,flags:event.flags|(old?.flags||0),scopes:old ? (old.scopes&&event.scopes ? [...new Set([...old.scopes,...event.scopes])] : undefined) : event.scopes});
        }
        if (events.size > 20000) { events.clear(); m.gap="Event backlog exceeds budget; explicit reconciliation required"; }
        queue.set(m.root,{uuid:m.uuid,cursor:m.cursor || previous?.cursor,gap:m.gap || previous?.gap,events});
        // Schedule from the first event; continuous filesystem activity must not starve commits.
        scheduleFlush();
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
