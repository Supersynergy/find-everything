#!/usr/bin/env bun
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { canonicalPaths, pathIndexName, profiles, removeProfile, saveProfile,defaultIndex } from "./catalog";
import { EngineOpts, FD, RG, FZF, OPEN_CMD, INDEX_DIR, SCOPES, HOME, IS_MAC,
  ensureIndex, rebuildIndex, humanBytes, indexPathFor, openPath, indexStatus, effectiveOptions, scopePaths, stopChildren, track,parseQuery } from "./engine";
import { completions } from "./completions";
import { shellCommand } from "./shell";
import { serveApi, serveMcp, serveSearchWorker, searchFiles, VERSION } from "./services";
import { enrichMedia, repairMedia } from "./media";
import { DEFAULT_SOCKET, socketRequest } from "./socket";
import { QUERY_HELP,normalizeQuery } from "./smart-query";
import { indexSounds, closeSoundWorker } from "./semantic";
import { runtimeDir, semanticStatus } from "./semantic-worker";
import { startLive } from "./live";
import { serveLiveWorker } from './live-process';
import {directoryListingChild,retryCommand} from './targeted-rescan';
import {journalStatus,requestJournalMerge} from './journal-status';
import {compactIndex,compactionStatus,reconcileIndex} from './compaction';
import { prepareSearch, indexProperties, searchIndexStatus } from './path-search';
import {combineIndexes} from './combine';
import {changeFavorites} from './file-filters';
import {updateLearning} from './search-learning';
import {learningContext} from './search-ranking';
import {indexContents,contentStatus,clearContents} from './content-search';
import {indexMeaning,meaningStatus,clearMeaning} from './instantfind';
import {setupInstantRuntime,instantRuntimeStatus,instantEncoder} from './instantfind-worker';
import { startIndexJob, type IndexJob } from './index-progress';
let activeIndexJob: IndexJob | undefined;
let indexWorkerAbort: AbortController | undefined;
let stopLive: (() => void) | undefined;
let setupProcess: ChildProcess | undefined;
function stopSetup() {
  const child = setupProcess; setupProcess = undefined;
  if (!child?.pid || child.exitCode !== null) return;
  try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
  catch (e) { if (e.code !== "ESRCH") throw e; }
}

interface Flags {
  scope?: string; paths: string[]; name?: string; preset?: string; opts: EngineOpts;
  limit: number; json: boolean; nul: boolean; tui: boolean; fresh: boolean; progress: boolean;
  replace: boolean; names: boolean; port: number; interval: number; help: boolean; version: boolean;
  model?:string;python?:string;ocr?:boolean;ocrPages?:number;literal?:boolean;
  socket?: string; snapshot: boolean; maxFiles: number; seconds: number; kind: string; idleSeconds: number; offset: number; parentBound: boolean; query: string; live?: boolean; liveIndexes: string[]; rows:number;sources:string[];
}
function numeric(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be ${min}–${max}`);
  return n;
}
function parseFlags(argv: string[]): { pos: string[]; flags: Flags } {
  const flags: Flags = { paths: [], opts: {}, limit: 300, json: false, nul: false, tui: false, fresh: false,
    progress: false, replace: false, names: false, port: 39217, interval: 1, help: false, version: false, snapshot: false, maxFiles: 500, seconds: 60, kind: "audio", idleSeconds: 300, offset: 0, parentBound: false, query: "",liveIndexes:[],rows:10000000,sources:[] };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${a}`); return argv[++i]; };
    switch (a) {
      case "--": pos.push(...argv.slice(i + 1)); i = argv.length; break;
      case "--scope": case "--index": case "-s": flags.scope = value(); break;
      case "--path": flags.paths.push(value()); break;
      case "--name": flags.name = value(); break;
      case "--limit": case "-n": flags.limit = numeric(value(), a, 1, 1000); if (!Number.isInteger(flags.limit)) throw new Error("Limit must be an integer"); break;
      case "--max-age": flags.opts.indexMaxAgeMinutes = String(numeric(value(), a, 1, 10080)); break;
      case "--exclude": flags.opts.extraExcludes = [flags.opts.extraExcludes, value()].filter(Boolean).join(","); break;
      case "--hidden": flags.opts.includeHidden = true; break;
      case "--exhaustive": flags.opts.exhaustive = true; break;
      case "--no-exhaustive": flags.opts.exhaustive = false; break;
      case "--no-hidden": flags.opts.includeHidden = false; break;
      case "--include-ignored": flags.opts.includeIgnored = true; break;
      case "--respect-ignore": flags.opts.includeIgnored = false; break;
      case "--preset": {
        flags.preset = value();
        if (!["project", "folder"].includes(flags.preset)) throw new Error("Preset must be project or folder");
        break;
      }
      case "--json": flags.json = true; break;
      case "--literal": flags.literal=true;break;
      case '--ocr': flags.ocr=true;break;
      case '--ocr-pages': flags.ocrPages=numeric(value(),a,1,100);if(!Number.isInteger(flags.ocrPages))throw new Error('OCR page limit must be an integer');break;
      case "--model": flags.model=value();break;
      case "--python": flags.python=value();break;
      case "--progress-json": flags.progress = true; break;
      case "--null": case "-0": flags.nul = true; break;
      case "--tui": flags.tui = true; break;
      case "--fresh": flags.fresh = true; break;
      case "--snapshot": flags.snapshot = true; break;
      case "--socket": { const p = value(); flags.socket = p === "auto" ? DEFAULT_SOCKET : path.resolve(p); break; }
      case "--max-files": flags.maxFiles = numeric(value(), a, 1, 10000); break;
      case "--rows": flags.rows=numeric(value(),a,1,10000000);if(!Number.isInteger(flags.rows))throw new Error('Rows must be an integer');break;
      case '--sources': flags.sources=value().split(',').filter(Boolean);break;
      case "--seconds": flags.seconds = numeric(value(), a, 1, 300); break;
      case "--kind": flags.kind = value(); break;
      case "--idle-seconds": flags.idleSeconds = numeric(value(), a, 1, 3600); break;
      case "--offset": flags.offset = numeric(value(), a, 0, 100000000); break;
      case "--parent": case "--parent-bound": flags.parentBound = true; break;
      case "--live": flags.live = true; break;
      case "--live-index": flags.liveIndexes.push(value()); break;
      case "--query": {if(i+1>=argv.length)throw new Error('Missing value for --query');flags.query=argv[++i];break;}
      case "--replace": flags.replace = true; break;
      case "--names": flags.names = true; break;
      case "--port": flags.port = numeric(value(), a, 0, 65535); if (!Number.isInteger(flags.port)) throw new Error("Port must be an integer"); break;
      case "--interval": flags.interval = numeric(value(), a, 0.2, 60); break;
      case "--help": case "-h": flags.help = true; break;
      case "--version": case "-v": flags.version = true; break;
      default: if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`); pos.push(a);
    }
  }
  if (flags.preset) flags.opts = { includeHidden: true, includeIgnored: flags.preset === "folder", ...flags.opts };
  if (flags.json && (flags.nul || flags.tui)) throw new Error("--json cannot be combined with --null or --tui");
  return { pos, flags };
}

const HELP = `fe — Find Everything ${VERSION}

  fe [search] <query>             ranked paths; no command opens the picker
  fe index [folder ...]          rebuild a scope, folder or project index
  fe indexes                     list built-in and saved indexes
  fe indexes remove <name>       forget a profile (keeps files and cache)
  fe watch --index <name>        incremental journal updates; foreground
  fe prepare --index NAME       compile fast search from existing path data
  fe combine --name everything  merge saved indexes without a directory scan
  fe properties --index NAME    cache file size/date; no directory traversal
  fe status [--json]             tools and index health
  fe open|reveal|preview <path>   OS actions or bounded text preview
  fe completions bash|zsh|fish    print shell completion script
  fe serve [--port 39217]        token-protected HTTP API on 127.0.0.1
  fe mcp                        MCP server over stdio
  fe enrich --index NAME        extract changed media metadata, within a budget
  fe repair-media --index NAME  retry unknown audio once per reader/file version
  fe query-help                 single-line smart fields and examples
  fe explain QUERY --index NAME  explain matching, visibility and saved index status
  fe favorites list|add|remove  shared favorite paths (absolute paths for add/remove)
  fe learn status|reset|enable|disable  local decaying preferences, shared by app/Raycast
  fe learn open PATH --query Q --index NAME  record a successful file selection
  fe search 'QUERY view:smart'  human-first relevance; view:all reveals saved paths
  fe semantic setup             install pinned local CLAP runtime and model
  fe semantic status            show model readiness and location
  fe semantic index --index NAME --query '(kurze Lasersounds)' --max-files 100 --seconds 60

  --index, --scope, -s <name>    home|downloads|documents|applications|all|custom|saved
  --path <folder>                repeat for multiple roots
  --name <name> --replace        save or explicitly update a profile
  --preset project|folder        project respects ignore files; folder includes them
  --hidden | --no-hidden         include/exclude dotfiles
  --exhaustive                   include hidden/ignored/generated folders; keep explicit excludes
  --no-exhaustive                restore standard scan exclusions on an explicit rebuild
  --include-ignored              bypass ignore files (build/cache exclusions remain)
  --exclude <glob>               repeatable extra exclusion
  --max-age <minutes>            snapshot age warning threshold (default 60)
  --fresh                       force refresh before searching
  --snapshot                    use existing snapshot (also the default)
  --live                        serve maintains journal deltas until stopped
  --live-index <name>            repeatable; limit --live to these indexes (others are reported)
  --socket auto|<path>           private Unix socket for serve or search
  --kind audio|video|image|media enrichment kind (default audio)
  --max-files <1–10000>          enrichment probe budget (default 500)
  --seconds <1–300>              enrichment wall-time budget (default 60)
  --rows <1–10000000>           preparation checkpoint budget; safe to resume
  --sources NAME,NAME           choose combine sources (default: all saved)
  --idle-seconds <1–3600>        serve exits after idle time (default 300)
  --offset <0–100000000>        result page; deep filtered pages need prepare
  --parent                      serve exits when its calling process exits
  -n, --limit <1–1000>           result limit (default 300)
  --progress-json               index progress as NDJSON; SIGUSR2 pauses/resumes owned workers
  --literal                     treat search text and punctuation literally
  --json | -0, --null            JSON or NUL-separated paths
  --interval <seconds>           watcher debounce, 0.2–60 (default 1)
  --help, -h | --version, -v

Examples:
  fe index ~/BASE/projects/hypersearch --name hypersearch --preset project
  fe search 'engine ext:ts' --index hypersearch --json
  fe search 'invoice ext:pdf' --path ~/Documents/Invoices

  fe instantfind setup --model PATH --python PATH   reuse a pinned local Gemma model
  fe instantfind index|status|clear --index NAME    prepare meaning search from cached text
  fe search 'meaning:"recover a failed release" ext:md' --index NAME

Path indexes store names and paths; fe content index explicitly prepares local document full-text search.
  fe content index|status|clear --index NAME [--ocr --ocr-pages 32] [--max-files 500 --seconds 60] [--json]
  fe compact [status] --index NAME --rows 1000000 --seconds 30   resume saved-change merge
  fe journal [merge] --index NAME                           inspect counts or request a live merge
  fe retries [import FD-DIAGNOSTICS] --index NAME            inspect or seed directory recovery
  fe reconcile --index NAME                                 explicitly scan configured roots
  fe search 'content:"quarterly revenue" ext:pdf' --index NAME --json
Text/code, extractable PDFs and macOS Office/RTF are supported within reported limits. Local OCR is explicit with --ocr.
`;

function selection(flags: Flags): { scope: string; opts: EngineOpts } {
  if (flags.paths.length) {
    if (flags.scope) throw new Error("Use either --path or --index, not both");
    const paths = canonicalPaths(flags.paths);
    const opts = { includeHidden: true, includeIgnored: false, ...flags.opts, paths };
    return { scope: pathIndexName(paths, opts), opts };
  }
  const scope = flags.scope || defaultIndex();
  return { scope, opts: effectiveOptions(scope, flags.opts) };
}

async function cmdSearch(q: string, flags: Flags): Promise<void> {
  if(flags.literal)q='literal:'+JSON.stringify(q);
  const { scope, opts } = selection(flags);
  if (flags.socket && (flags.paths.length || flags.fresh || Object.keys(flags.opts).length)) throw new Error("Socket searches use saved index settings; refresh separately or omit --socket");
  const result = flags.socket
    ? await socketRequest(flags.socket, `/v1/search?${new URLSearchParams({ q, index: scope, limit: String(flags.limit), offset: String(flags.offset) })}`)
    : await searchFiles(q, scope, flags.limit, opts, flags.fresh, flags.snapshot, flags.offset).finally(()=>{closeSoundWorker();instantEncoder.close();});
  if (flags.json) return void console.log(JSON.stringify(result));
  for (const warning of result.warnings || []) console.error(`fe: ${warning}`);
  for (const p of result.paths) process.stdout.write(flags.tui ? `${p}\t${path.basename(p)}  ${path.dirname(p).replace(HOME, "~")}\n` : p + (flags.nul ? "\0" : "\n"));
}

async function cmdIndex(pos: string[], flags: Flags, worker = false): Promise<void> {
  flags.paths.push(...pos);
  let scanned = 0;
  const emit = (event: object) => console.log(JSON.stringify(event));
  const monitor = worker ? { signal: indexWorkerAbort!.signal, externalTimeout: true, progress: (stats: { count: number; bytes: number }) => {
    scanned = stats.count; emit({ phase: 'scan', files: scanned, bytesRead: stats.bytes, paused: false });
  }} : undefined;
  let selected: ReturnType<typeof selection>;
  if (flags.name) {
    if (flags.scope) throw new Error("Use --name with folders, or --index to rebuild a profile");
    const item = { name: flags.name, paths: canonicalPaths(flags.paths), ...flags.opts };
    if (profiles().some(p => p.name === item.name) && !flags.replace) throw new Error(`Index already exists: ${item.name}; use --replace`);
    if (SCOPES.includes(item.name)) throw new Error(`Reserved index name: ${item.name}`);
    selected = { scope: item.name, opts: { ...item, includeHidden: item.includeHidden ?? true, includeIgnored: item.includeIgnored ?? false } };
    await rebuildIndex(selected.scope, selected.opts, monitor);
    saveProfile(item, flags.replace);
  } else {
    selected = selection(flags);
    await rebuildIndex(selected.scope, selected.opts, monitor);
    const saved=profiles().find(p=>p.name===selected.scope);
    if(saved&&Object.keys(flags.opts).length)saveProfile({...saved,...flags.opts},true);
  }
  if (worker) {
    const totalBytes = fs.statSync(indexPathFor(selected.scope)).size;
    emit({ phase: 'prepare', files: scanned, bytesRead: 0, totalBytes, paused: false });
    while (true) {
      indexWorkerAbort!.signal.throwIfAborted();
      const prepared = await prepareSearch(selected.scope, 1, 10000);
      if (prepared.ready) break;
      const partial = prepared as { bytesRead?: number };
      emit({ phase: 'prepare', files: scanned, bytesRead: partial.bytesRead ?? 0, totalBytes, paused: false });
    }
    emit({ phase: 'complete', files: scanned, bytesRead: totalBytes, totalBytes, paused: false });
    return;
  }
  if(fs.statSync(indexPathFor(selected.scope)).size<=32*1024*1024)await prepareSearch(selected.scope,10);
  const status = indexStatus().find(s => s.name === selected.scope) || { name: selected.scope, paths: scopePaths(selected.scope, selected.opts), bytes: fs.statSync(indexPathFor(selected.scope)).size };
  console.log(flags.json ? JSON.stringify(status) : `${selected.scope}: ${humanBytes(status.bytes)} · ${status.paths.join(", ")}`);
}

function cmdPreview(p: string, json: boolean): void {
  if (!p) throw new Error("Specify a file or folder");
  const absolute = path.resolve(p.replace(/^~(?=\/|$)/, HOME));
  const stat = fs.statSync(absolute);
  let text: string | null = null;
  if (stat.isFile() && stat.size > 0) {
    const fd = fs.openSync(absolute, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 4000));
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (!buffer.subarray(0, length).includes(0)) text = buffer.subarray(0, length).toString("utf8");
    } finally { fs.closeSync(fd); }
  }
  const meta = { path: absolute, directory: stat.isDirectory(), bytes: stat.size, modifiedAt: stat.mtime.toISOString(), text };
  console.log(json ? JSON.stringify(meta) : `${path.basename(absolute)}\n${absolute}\n${stat.isDirectory() ? "folder" : humanBytes(stat.size)} · modified ${stat.mtime.toISOString()}${text === null ? "" : `\n\n${text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")}`}`);
}

async function cmdTui(flags: Flags): Promise<void> {
  const { scope, opts } = selection(flags);
  await ensureIndex(scope, opts);
  const self = process.argv[1]?.endsWith(".ts") ? [process.execPath, path.resolve(process.argv[1])] : [process.execPath];
  const selector = flags.paths.length ? flags.paths.flatMap(p => ["--path", p]) : ["--index", scope];
  const options = [...selector, ...(opts.exhaustive ? ['--exhaustive'] : []), ...(opts.includeHidden === false ? ["--no-hidden"] : ["--hidden"]), ...(opts.includeIgnored ? ["--include-ignored"] : ["--respect-ignore"]), ...(opts.extraExcludes ? ["--exclude", opts.extraExcludes] : []), "--max-age", opts.indexMaxAgeMinutes || "60"];
  const prefix = shellCommand(self);
  const search = shellCommand([...self, "search", "--tui", "-n", String(flags.limit), ...options]);
  const rebuild = shellCommand([...self, "index", ...options]);
  const args = ["--ansi", "--disabled", "--delimiter=\t", "--with-nth=2..", "--layout=reverse", "--scheme=path",
    `--bind=change:reload:${search} -- {q} || true`, `--bind=enter:execute-silent(${prefix} open {1})+abort`,
    `--bind=ctrl-r:execute-silent(${rebuild})+reload:${search} -- {q}`, `--bind=ctrl-o:execute-silent(${prefix} reveal {1})`,
    `--preview=${prefix} preview {1}`, "--preview-window=right,55%,wrap", `--header=Find Everything · ${scope} · Enter opens · ^R rebuild · ^O reveal`];
  const child = spawn(FZF, args, { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 || code === 130 ? resolve() : reject(new Error(`fzf exited ${code}`))); });
}

async function watchIndex(flags: Flags): Promise<void> {
  const { scope, opts } = selection(flags);
  await ensureIndex(scope, opts, false, false, true);
  stopLive = await startLive([scope],flags.interval*1000);
}

async function main(): Promise<void> {
  const { pos, flags } = parseFlags(process.argv.slice(2));
  if (flags.version) return void console.log(`fe ${VERSION}`);
  const [cmd, ...rest] = pos;
  if (flags.help || cmd === "help") return void console.log(HELP);
  switch (cmd) {
    case '_directory-list':return directoryListingChild(rest[0]);
    case '_search-worker':return serveSearchWorker();
    case '_live-worker':return serveLiveWorker(JSON.parse(rest[0]??'null'));
    case 'learn': {
      const action=rest[0]||'status';
      const parsed=parseQuery(normalizeQuery(flags.query));
      const result=updateLearning(action,learningContext(parsed),flags.scope||defaultIndex(),rest[1]);
      console.log(JSON.stringify(result));return;
    }
    case 'favorites':case 'favorite': {
      const result=changeFavorites(rest[0]||'list',rest.slice(1));
      console.log(flags.json?JSON.stringify(result):result.paths.join('\n'));return;
    }
    case "semantic": {
      if (rest[0] === "status") return void console.log(JSON.stringify(semanticStatus()));
      if (rest[0] === "setup") {
        const child = setupProcess = track(spawn("bash", [path.join(runtimeDir(), "setup.sh")], { detached: process.platform !== "win32", stdio: "inherit" }));
        const timer = setTimeout(stopSetup, 180000);
        const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        clearTimeout(timer); setupProcess = undefined; if (code !== 0) throw new Error("Local sound setup failed; retry fe semantic setup"); return;
      }
      if (rest[0] !== "index") throw new Error("Usage: fe semantic setup|status|index");
      const { scope, opts } = selection(flags);
      await ensureIndex(scope, opts, flags.fresh, false, true);
      const result = await indexSounds(scope, flags.query, flags.maxFiles, flags.seconds);
      console.log(JSON.stringify(result)); return;
    }
    case "search": return cmdSearch(rest.length?rest.join(" "):flags.query, flags);
    case 'explain':{
      const {scope}=selection(flags),query=rest.length?rest.join(' '):flags.query;
      const normalizedQuery=normalizeQuery(flags.literal?'literal:'+JSON.stringify(query):query),parsed=parseQuery(normalizedQuery);
      console.log(JSON.stringify({query,normalizedQuery,index:scope,matching:{case:parsed.matchCase===undefined?'smart':parsed.matchCase?'sensitive':'insensitive',wholeWord:parsed.wholeWord??false,terms:parsed.fuzzy,constraints:parsed.constraints},visibility:{smart:parsed.smart??false,omitted:parsed.omit??[],favoritesOnly:parsed.favorites!==undefined},snapshot:indexStatus().find(s=>s.name===scope)??null,lookup:searchIndexStatus(scope,false),notes:['Reads saved index metadata; does not scan folders or execute a search.','Explicit size/date filters need known cached properties.','Index warnings remain evidence of incomplete coverage.']}));return;
    }
    case 'retries':{const {scope}=selection(flags);console.log(JSON.stringify(retryCommand(scope,rest)));return;}
    case 'journal':{if(rest.length>1||(rest.length&&rest[0]!=='merge'))throw new Error('Usage: fe journal [merge] --index NAME');const {scope}=selection(flags);console.log(JSON.stringify(rest.length?requestJournalMerge(scope):journalStatus(scope)));return;}
    case 'compact':{if(rest.length>1||(rest.length&&rest[0]!=='status'))throw new Error('Usage: fe compact [status] --index NAME');const {scope}=selection(flags);console.log(JSON.stringify(rest[0]==='status'?compactionStatus(scope):await compactIndex(scope,flags.seconds,flags.rows)));return;}
    case 'reconcile':{const {scope}=selection(flags);console.log(JSON.stringify(await reconcileIndex(scope)));return;}
    case 'combine': {if(!flags.name)throw new Error('Use fe combine --name everything');console.log(JSON.stringify(await combineIndexes(flags.name,flags.sources,flags.replace,flags.seconds)));return;}
    case 'prepare': case 'properties': {
      const {scope}=selection(flags);if(!fs.existsSync(indexPathFor(scope)))throw new Error('No existing path snapshot; run fe index explicitly first');
      const result=cmd==='prepare'?await prepareSearch(scope,flags.seconds,flags.rows):await indexProperties(scope,flags.maxFiles,flags.seconds);
      console.log(JSON.stringify(result));return;
    }
    case "repair-media": case "enrich": {
      const { scope, opts } = selection(flags);
      await ensureIndex(scope, opts, flags.fresh, false, true);
      const result = cmd === "repair-media" ? await repairMedia(scope, flags.maxFiles, flags.seconds) : await enrichMedia(scope, flags.maxFiles, flags.seconds, flags.kind);
      console.log(flags.json ? JSON.stringify(result) : `${scope}: ${"probed" in result ? result.probed : result.inspected} inspected · ${result.reused} reused · ${result.failed} failed · ${result.pending} pending`); return;
    }
    case 'instantfind': {
      const action=rest[0]||'status';
      if(action==='setup') {
        if(!flags.model||!flags.python)throw new Error('Use fe instantfind setup --model PATH --python PATH');
        console.log(JSON.stringify(await setupInstantRuntime(flags.model,flags.python)));return;
      }
      const {scope}=selection(flags);
      if(!['index','status','clear'].includes(action)||rest.length>1)throw new Error('Use fe instantfind setup|index|status|clear');
      try {console.log(JSON.stringify(action==='index'?await indexMeaning(scope,flags.maxFiles,flags.seconds):action==='clear'?clearMeaning(scope):{...meaningStatus(scope),runtime:instantRuntimeStatus()}));}
      finally{instantEncoder.close();}return;
    }
    case 'content': {
      const {scope}=selection(flags);
      const action=rest[0]??'status';
      if(rest.length>1||!['index','status','clear'].includes(action))throw new Error('Use fe content index|status|clear --index NAME');
      const result=action==='index'?await indexContents(scope,flags.maxFiles,flags.seconds,undefined,{ocr:flags.ocr,maxPages:flags.ocrPages}):action==='clear'?await clearContents(scope):contentStatus(scope);
      console.log(JSON.stringify(result));return;
    }
    case "query-help": return void console.log(flags.json ? JSON.stringify(QUERY_HELP) : QUERY_HELP.examples.join("\n") + "\n\n" + QUERY_HELP.notes);
    case "index": {
      if (!flags.progress) return cmdIndex(rest, flags);
      const self = process.argv[1]?.endsWith('.ts') ? [path.resolve(process.argv[1])] : [];
      activeIndexJob = startIndexJob(process.execPath, [...self, '_index-job', ...process.argv.slice(3)]);
      const parentGone=()=>activeIndexJob?.cancel();
      if(flags.parentBound){process.stdin.once('end',parentGone);process.stdin.resume();}
      try { await activeIndexJob.done; } finally {
        process.stdin.removeListener('end',parentGone);process.stdin.pause();activeIndexJob=undefined;
      }
      return;
    }
    case '_index-guardian': {
      const group=Number(rest[0]);
      if (!Number.isSafeInteger(group)||group<2) throw new Error('Invalid owned index group');
      let disarmed=false;
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', data => {if(String(data).includes('complete')) disarmed=true;});
      process.stdin.on('end', () => {
        if(disarmed) return;
        const send=(signal:NodeJS.Signals)=>{try{process.kill(-group,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH') throw error;}};
        send('SIGCONT');send('SIGTERM');
        setTimeout(()=>send('SIGKILL'),1000);
      });
      process.stdin.resume();return;
    }
    case '_index-job': {
      indexWorkerAbort = new AbortController();
      try { await cmdIndex(rest, flags, true); } finally { indexWorkerAbort = undefined; }
      return;
    }
    case "watch": return watchIndex(flags);
    case "indexes": {
      if (rest[0] === "remove") { if (!rest[1]) throw new Error("Specify the index to remove"); removeProfile(rest[1]); return; }
      if (rest.length) throw new Error("Usage: fe indexes [remove NAME]");
      const indexes = indexStatus();
      console.log(flags.json ? JSON.stringify(indexes) : indexes.map(i => flags.names ? i.name : `${i.name.padEnd(16)} ${i.exists ? `${humanBytes(i.bytes)}${i.stale ? " · stale" : ""}` : "not indexed"}  ${i.paths.join(", ")}`).join("\n")); return;
    }
    case "status": {
      const status = { version: VERSION, tools: { fd: FD, rg: RG, fzf: FZF, open: OPEN_CMD }, indexDir: INDEX_DIR, indexes: indexStatus().map(i=>({...i,search: i.exists?searchIndexStatus(i.name):null})) };
      console.log(flags.json ? JSON.stringify(status) : `${Object.entries(status.tools).map(([n, p]) => `${n.padEnd(6)} ${p}`).join("\n")}\n\n${status.indexes.map(i => `${i.name.padEnd(16)} ${humanBytes(i.bytes)} · ${i.stale ? "stale / missing" : "current"} · ${i.indexedAt || "never"}`).join("\n")}`); return;
    }
    case "preview": return cmdPreview(rest[0], flags.json);
    case "open": case "reveal": {
      if (!rest[0] || !fs.existsSync(rest[0])) throw new Error("Specify an existing path");
      if (cmd === "open") return openPath(rest[0]);
      const child = spawn(OPEN_CMD, IS_MAC ? ["-R", rest[0]] : [path.dirname(rest[0])], { stdio: "ignore", detached: true });
      child.on("error", e => { console.error(e.message); process.exitCode = 1; }); child.unref(); return;
    }
    case "completions": return void process.stdout.write(completions(rest[0]));
    case "serve": return serveApi(flags.port, flags.socket, flags.idleSeconds, flags.parentBound, flags.live, flags.liveIndexes);
    case "mcp": return serveMcp();
    case undefined: case "pick": return cmdTui(flags);
    default: return cmdSearch(pos.join(" "), flags);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  if (activeIndexJob) { activeIndexJob.cancel(); return; }
  if (indexWorkerAbort) { indexWorkerAbort.abort(new Error('Indexing cancelled')); return; }
  stopLive?.(); stopSetup(); closeSoundWorker(); instantEncoder.close(); stopChildren(); process.exit(signal === "SIGINT" ? 130 : 143);
});
process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") {
  if (activeIndexJob) { activeIndexJob.cancel(); return; }
  if (indexWorkerAbort) { indexWorkerAbort.abort(new Error('Index progress reader closed')); return; }
  stopChildren(); process.exit(0);
} else { console.error(e.message); process.exit(1); } });
main().catch(e => { stopChildren(); console.error(`fe: ${e.message || e}`); process.exitCode = 1; });
