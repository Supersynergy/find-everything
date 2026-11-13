import * as http from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import { EngineOpts, ensureIndex, rebuildIndex, parseQuery, indexStatus, effectiveOptions, indexPathFor } from "./engine";
import { searchMedia, mediaPath } from "./media";
import { normalizeQuery, QUERY_HELP } from "./smart-query";
import { listenSocket, waitForSocketOwner } from "./socket";
import { browse } from "./browse";
import { searchSounds, semanticPath, closeSoundWorker } from "./semantic";
import { liveRevisionFor, liveStatus } from "./delta";
import { startLive } from "./live";
import {defaultIndex} from './catalog';
import {favoritesFile} from './file-filters';
import { searchPrepared, searchStreaming, syncSearch, searchIndexPath,prepareSearch,indexProperties,preparedRevision } from './path-search';
import {SearchProcess,SearchWork,searchedCacheKey} from './search-process';
import {SearchCache} from './search-cache';
import {learnedSelections,learningFile} from './search-learning';
import {learningContext} from './search-ranking';
import {createInterface} from 'node:readline';
import {searchContents,contentPath} from './content-search';
import {searchMeaning,meaningPath} from './instantfind';
import {instantEncoder} from './instantfind-worker';

export const VERSION = "0.3.8";
function learningStamp(){try{const s=fs.statSync(learningFile());return `${s.mtimeMs}:${s.size}:${Math.floor(Date.now()/3600000)}`;}catch(e){if(e.code==='ENOENT')return 'none';throw e;}}

/** Adds the watcher and age envelope. It stays separate from the snapshot body so a
 * cached hit re-answers staleness, watcher problems and completeness for *now*
 * instead of replaying whatever was true when the body was computed. */
export function presentSearch(result:any,index:string) {
  const live = liveStatus(index);
  const info=indexStatus().find(i=>i.name===index),configurationChanged=info?.configurationChanged ?? false,provenanceWarnings=info?.provenanceWarnings ?? [];
  const healthy = live.watching && !live.problem && !configurationChanged;
  return {...result,live,stale:healthy ? false : result.stale,complete:result.complete && !live.problem && !configurationChanged && !provenanceWarnings.length,
    warnings:[...result.warnings.filter((w:string) => !healthy || !w.startsWith("Path snapshot is old")),...(live.problem ? [live.problem] : []),...(configurationChanged ? [`Index settings changed; searching the existing snapshot. Reconcile explicitly with fe index --index ${index}.`] : []),...provenanceWarnings]};
}

export async function searchFiles(query: string, index = defaultIndex(), limit = 300, options: EngineOpts = {}, fresh = false, snapshot = false, offset = 0, synchronize = true,preview=false) {
  return presentSearch(await searchRaw(query,index,limit,options,fresh,snapshot,offset,synchronize,preview),index);
}

/** The snapshot body without the envelope; the service adds it per request. */
export async function searchRaw(query: string, index = defaultIndex(), limit = 300, options: EngineOpts = {}, fresh = false, snapshot = false, offset = 0, synchronize = true,preview=false) {
  return searchSnapshot(query,index,limit,options,fresh,snapshot,offset,synchronize,preview);
}
async function searchSnapshot(query: string, index: string, limit: number, options: EngineOpts, fresh: boolean, snapshot: boolean, offset: number, synchronize:boolean,preview:boolean) {
  if (typeof query !== "string" || query.length > 4096) throw new Error("Query must be a string of at most 4096 characters");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Limit must be an integer from 1 to 1000");
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000000) throw new Error("Offset must be an integer from 0 to 100000000");
  const normalizedQuery = normalizeQuery(query);
  const parsed = parseQuery(normalizedQuery);
  const learningWarnings:string[]=[];
  if(!parsed.semantic&&!parsed.meaning&&(parsed.smart&&!parsed.sort||parsed.sort==='relevance')&&parsed.learning!==false){try{parsed.learned=learnedSelections(learningContext(parsed),index,Math.floor(Date.now()/3600000)*3600000);}catch(e){learningWarnings.push(`Local learning unavailable: ${String(e.message).slice(0,200)}`);}}
  const opts = effectiveOptions(index, options);
  const started = performance.now();
  if(parsed.meaning!==undefined) {
    if(fresh)throw new Error('Refresh document meaning explicitly with fe instantfind index --index NAME');
    const result=await searchMeaning(index,parsed,limit,offset);
    return {query,normalizedQuery,index,...result,stale:false,elapsedMs:Math.round(performance.now()-started)};
  }
  if(parsed.content!==undefined) {
    if(fresh)throw new Error('Refresh document text explicitly with fe content index --index NAME');
    const result=await searchContents(index,parsed,limit,offset);
    return {query,normalizedQuery,index,...result,stale:true,warnings:[...result.warnings,...learningWarnings],elapsedMs:Math.round(performance.now()-started)};
  }
  {
    await ensureIndex(index, opts, fresh, false, snapshot);
    if (parsed.semantic) return { query, normalizedQuery, index, ...await searchSounds(index, parsed, limit, offset), stale:Date.now()-fs.statSync(indexPathFor(index)).mtimeMs>Number(opts.indexMaxAgeMinutes)*60000, elapsedMs: Math.round(performance.now() - started) };
    if (parsed.mediaFilters.length) {
      const media = searchMedia(normalizedQuery, index, parsed, limit, offset);
      const stale = Date.now() - fs.statSync(indexPathFor(index)).mtimeMs > Number(opts.indexMaxAgeMinutes) * 60000;
      return { query, normalizedQuery, index, ...media,snapshotId:media.snapshotId+':relevance-v1:'+learningStamp(),stale,
        warnings: [...media.warnings,...learningWarnings, ...(stale ? [`Path snapshot is old; refresh with fe index --index ${index}`] : [])], elapsedMs: Math.round(performance.now() - started) };
    }
    let prepared:ReturnType<typeof searchPrepared>,acceleratorProblem:string|undefined;
    // A live writer can hold the accelerator for a moment. Retrying a lock beats
    // every fallback: the complete snapshot means reading the whole index file.
    for (let attempt=0;;attempt++) {
      try {if(synchronize)syncSearch(index);prepared=searchPrepared(index,parsed,limit,offset,preview);acceleratorProblem=undefined;break;}
      catch(e){
        acceleratorProblem=`Fast lookup is unavailable; using the complete saved snapshot: ${String(e.message).slice(0,300)}`;
        if(attempt>=1||!/SQLITE_BUSY|database (table )?is locked/i.test(String(e.message)))break;
        await new Promise<void>(r=>setTimeout(r,200));
      }
    }
    if(!prepared&&normalizedQuery.trim()&&offset>100000)throw new Error(`Prepare fast lookup before requesting deeper pages: fe prepare --index ${index}`);
    const result=prepared ?? (!normalizedQuery.trim() ? await browse(index,limit,offset) : await searchStreaming(index,parsed,limit,offset));
    const stale=Date.now()-fs.statSync(indexPathFor(index)).mtimeMs>Number(opts.indexMaxAgeMinutes)*60000;
    return {query,normalizedQuery,index,...result,snapshotId:result.snapshotId+':relevance-v1:'+learningStamp(),warnings:[...result.warnings,...learningWarnings,...(acceleratorProblem?[acceleratorProblem]:[])],stale,elapsedMs:Math.round(performance.now()-started)};
  }
}

export async function serveSearchWorker(){
  if(process.env.FE_SEARCH_WORKER!=='1'||Number(process.env.FE_SEARCH_OWNER_PID)!==process.ppid)throw new Error('Search worker requires its owning service');
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  const ownerPid=process.ppid;
  const owner=setInterval(()=>{try{if(process.ppid!==ownerPid)process.exit(0);process.kill(ownerPid,0)}catch{process.exit(0)}},1000);owner.unref();
  try {
    for await(const line of lines){
      if(Buffer.byteLength(line)>32768)throw new Error('Search request exceeds limit');
      const request=JSON.parse(line);let reply:any;
      try {
        if(!Number.isSafeInteger(request.id)||!fs.existsSync(indexPathFor(request.index)))throw new Error('No saved index; create it explicitly before searching');
        const data=await searchRaw(request.query,request.index,request.limit,{},false,true,request.offset,false,request.phase==='preview');
        reply={id:request.id,data};
      }catch(e){reply={id:request.id,error:String(e.message).slice(0,1000)};}
      let body=JSON.stringify(reply)+'\n';
      if(Buffer.byteLength(body)>4*1024**2)body=JSON.stringify({id:request.id,error:'Search response exceeds 4 MiB'})+'\n';
      if(!process.stdout.write(body))await new Promise<void>(resolve=>process.stdout.once('drain',resolve));
    }
  }finally{clearInterval(owner);closeSoundWorker();instantEncoder.close();}
}

function equalToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApi(token: string, localSocket = false): http.Server & {canSyncSearch:()=>boolean} {
  if (token.length < 32) throw new Error("FE_API_TOKEN must contain at least 32 characters");
  let active = 0;
  let refreshing=false;
  const fingerprint = (file: string) => { try { const s = fs.statSync(file); return [s.mtimeMs, s.size, s.ino]; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const cacheContext=(work:SearchWork)=>{
    const parsed=parseQuery(normalizeQuery(work.query)),index=work.index;
    const regular=parsed.content===undefined&&parsed.meaning===undefined&&!parsed.semantic&&!parsed.mediaFilters.length;
    const prepared=regular?preparedRevision(index):undefined,liveRevision=liveRevisionFor(index);
    // Parsed structure shares only equivalent queries, retaining quoted spaces,
    // case and ordered terms. Each backend contributes its own dependencies.
    const key=JSON.stringify([parsed,index,work.limit,work.offset,work.phase,
      Math.floor(Date.now()/3600000),parsed.dmFilter?Math.floor(Date.now()/60000):0,
      effectiveOptions(index),fingerprint(indexPathFor(index)),
      regular?[fingerprint(searchIndexPath(index)),prepared]:null,
      parsed.mediaFilters.length||parsed.semantic?fingerprint(mediaPath(index)):null,
      parsed.content!==undefined||parsed.meaning!==undefined?fingerprint(contentPath(index)):null,
      parsed.meaning!==undefined?fingerprint(meaningPath(index)):null,
      parsed.semantic?fingerprint(semanticPath(index)):null,
      liveRevision,fingerprint(learningFile()),parsed.favorites!==undefined?fingerprint(favoritesFile()):null]);
    return {key,prepared,liveRevision};
  };
  const reader=new SearchProcess(undefined,work=>{const parsed=parseQuery(normalizeQuery(work.query));if(parsed.content===undefined&&parsed.meaning===undefined&&!parsed.semantic&&!parsed.mediaFilters.length)syncSearch(work.index);},work=>cacheContext(work).key);
  reader.warm();
  const cache = new SearchCache<Awaited<ReturnType<typeof searchRaw>>>();
  const cachedSearch = async (work:SearchWork,signal:AbortSignal) => {
    reader.advance(work);
    const {query,index,limit,offset}=work;
    if(typeof query!=='string'||query.length>4096)throw new Error('Query must be a string of at most 4096 characters');
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Limit must be an integer from 1 to 1000');
    if(!Number.isInteger(offset)||offset<0||offset>100000000)throw new Error('Offset must be an integer from 0 to 100000000');
    if(work.priority&&!['foreground','prefetch'].includes(work.priority))throw new Error('Invalid search priority');
    if(work.phase&&work.phase!=='preview')throw new Error('Invalid search phase');
    const normalizedQuery=normalizeQuery(query);
    const started = performance.now();
    const key=cacheContext(work).key,hit=cache.get(key);
    if(hit)return {...presentSearch({...hit,query,normalizedQuery},index),elapsedMs:Math.round(performance.now()-started),cacheHit:true};
    const data = await reader.search(work,signal);
    const current=cacheContext(work),searched=data[searchedCacheKey];
    const prepared=current.prepared;
    // prepare() can apply journal changes before the worker reads. Cache under
    // that searched key only while it still describes the returned snapshot.
    const bound=data.engine!=='sqlite-trigram'||prepared&&prepared.live===current.liveRevision&&data.snapshotId.startsWith(`${prepared.source}:${prepared.live}:${prepared.properties}:`);
    if(searched===current.key&&bound&&!data.instantfind)cache.set(searched,data);
    return { ...presentSearch({...data,query,normalizedQuery},index), cacheHit: false };
  };
  const server = http.createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {if(res.destroyed)return; const body = JSON.stringify(data); res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(body); };
    const address = server.address();
    const host = localSocket ? "localhost" : typeof address === "object" && address ? `127.0.0.1:${address.port}` : "";
    if (req.headers.host !== host || req.headers.origin) return send(403, { error: "Local non-browser requests only" });
    if (!equalToken(req.headers.authorization || "", token)) return send(401, { error: "Bearer token required" });
    if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || "0") > 0) { req.resume(); return send(413, { error: "Request bodies are not supported" }); }
    if (active >= 8) return send(503, { error: "Busy; retry after current requests finish" });
    active++;
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (url.origin !== `http://${host}`) return send(403, { error: "Invalid request origin" });
      if (req.method === "GET" && url.pathname === "/health") return send(200, { version: VERSION, apiRevision: 6, ok: true,search:reader.status() });
      if (req.method === "GET" && url.pathname === "/v1/indexes") return send(200, indexStatus().map(i => ({...i,live:i.exists ? liveStatus(i.name) : null})));
      if (req.method === "GET" && url.pathname === "/v1/updates") {
        const index = url.searchParams.get("index") || defaultIndex();
        const fingerprint = (p: string) => fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
        const live = liveStatus(index);
        return send(200,{...live,revision:JSON.stringify([fingerprint(indexPathFor(index)),live.revision,fingerprint(searchIndexPath(index)),fingerprint(mediaPath(index)),fingerprint(contentPath(index)),fingerprint(semanticPath(index)),fingerprint(learningFile())])});
      }
      if (req.method === "GET" && url.pathname === "/v1/query-help") return send(200, QUERY_HELP);
      if (req.method === "GET" && url.pathname === "/v1/search") {
        const cancel=new AbortController(),abort=()=>{if(!res.writableFinished)cancel.abort()};res.once('close',abort);
        try {return send(200,await cachedSearch({query:url.searchParams.get('q')||'',index:url.searchParams.get('index')||defaultIndex(),limit:Number(url.searchParams.get('limit')||'300'),offset:Number(url.searchParams.get('offset')||'0'),client:url.searchParams.get('client')??undefined,generation:url.searchParams.has('generation')?Number(url.searchParams.get('generation')):undefined,priority:url.searchParams.get('priority')||'foreground',phase:url.searchParams.get('phase')??undefined},cancel.signal));}
        finally{res.removeListener('close',abort);}
      }
      const refresh = url.pathname.match(/^\/v1\/indexes\/([a-zA-Z0-9_-]+)\/refresh$/);
      if (req.method === "POST" && refresh) {
        if(refreshing)return send(503,{error:'An explicit index refresh is already running'});
        refreshing=true;
        try {await rebuildIndex(refresh[1], {});return send(200, indexStatus().find(i => i.name === refresh[1]));}
        finally{refreshing=false;}
      }
      return send(404, { error: "Unknown endpoint" });
    } catch (e) { send(e.status||400, { error: e.message,...(e.code?{code:e.code}:{}) }); }
    finally { active--; }
  });
  server.once('close',()=>reader.close());
  server.requestTimeout = 15_000;
  server.headersTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return Object.assign(server,{canSyncSearch:()=>reader.canSync()});
}

export async function serveApi(port: number, socketPath?: string, idleSeconds = 300, parentBound = false, live = false, liveIndexes?: string[]): Promise<void> {
  // A KeepAlive'd service must not die over a stale name: --live-index values that
  // are unknown or not indexed yet are reported and skipped instead of aborting start.
  const requested = liveIndexes?.length ? [...new Set(liveIndexes)] : undefined;
  let liveNames: string[] | undefined;
  if (requested) {
    const watchable = new Set(indexStatus().filter(i => i.exists).map(i => i.name));
    const ignored = requested.filter(n => !watchable.has(n));
    if (ignored.length) console.error(`fe: --live-index ignored (not indexed): ${ignored.join(", ")}`);
    liveNames = requested.filter(n => watchable.has(n));
  }
  // Wait before taking any lock: a persistent service outlives its supervisor,
  // so a launchd KeepAlive job must not fight the running owner for live.sqlite.
  if (live && socketPath) await waitForSocketOwner(socketPath);
  const token = process.env.FE_API_TOKEN || randomBytes(32).toString("hex");
  const server = createApi(token, !!socketPath);
  server.once("close", closeSoundWorker);
  let idleTimer: ReturnType<typeof setTimeout>;
  const resetIdle = () => { if (live) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => server.close(), idleSeconds * 1000); idleTimer.unref(); };
  server.on("request", resetIdle);
  server.on("close", () => clearTimeout(idleTimer));
  if (!live) resetIdle();
  const stopLive = live ? await startLive(liveNames,300,server.canSyncSearch) : undefined;
  server.once("close", () => stopLive?.());
  const ownerPid = parentBound ? process.ppid : undefined;
  if (ownerPid) {
    const ownerTimer = setInterval(() => {
      try { process.kill(ownerPid, 0); }
      catch { server.close(); }
    }, 1000);
    ownerTimer.unref(); server.once("close", () => clearInterval(ownerTimer));
  }
  if (socketPath) { await listenSocket(server, socketPath, token, VERSION, ownerPid); return; }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const bound = server.address() as import("net").AddressInfo;
  console.error(JSON.stringify({ url: `http://127.0.0.1:${bound.port}`, token }));
}

const tools = [
  { name: "search_files", description: "Search complete indexed filenames/paths with exact coverage.matched counts, stable pages and global sort:name|path|big|small|new|old. Pass nextOffset as offset and retain snapshotId; never assume the first page is the whole result set. Size/date require cached properties; unknown metadata and index gaps keep complete false. German audio filters and parenthesized local CLAP sound descriptions are supported; acoustic ranking is approximate. No query-time directory scan.", inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 4096 }, index: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 }, offset: { type: "integer", minimum: 0, maximum: 100000000 } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  {name:'prepare_index',description:'Compile the fast filename lookup from an existing path snapshot, without traversing folders. Bounded and resumable; call again if ready=false. No permission changes.',inputSchema:{type:'object',properties:{index:{type:'string'},seconds:{type:'integer',minimum:1,maximum:30}},required:['index'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:'index_properties',description:'Cache file size and modification date from known indexed paths in a bounded batch. No file content decoding or directory traversal. Repeat while pending>0; failed paths stay unknown.',inputSchema:{type:'object',properties:{index:{type:'string'},maxFiles:{type:'integer',minimum:1,maximum:10000},seconds:{type:'integer',minimum:1,maximum:30}},required:['index'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  { name: "list_indexes", description: "List configured folder/project indexes and their freshness.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "refresh_index", description: "Rebuild a configured path index. Does not extract media metadata. User files remain unchanged.", inputSchema: { type: "object", properties: { index: { type: "string" } }, required: ["index"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "query_help", description: "Supported single-line query syntax, media fields, examples and coverage limits.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
];

export function mcpSession() {
  let initialized = false, ready = false;
  return async (message: any): Promise<any | undefined> => {
    const id = message?.id ?? null;
    const error = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || ("id" in message && typeof message.id !== "string" && typeof message.id !== "number")) return error(-32600, "Invalid Request");
    const notify = !("id" in message);
    if (notify) {
      if (message.method === "notifications/initialized" && initialized) ready = true;
      return;
    }
    let result: unknown;
    switch (message.method) {
      case "initialize": {
        if (initialized) return error(-32600, "Already initialized");
        if (!message.params || typeof message.params.protocolVersion !== "string" || !message.params.clientInfo || typeof message.params.capabilities !== "object") return error(-32602, "Invalid initialization parameters");
        initialized = true;
        const supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
        result = { protocolVersion: supported.includes(message.params.protocolVersion) ? message.params.protocolVersion : supported[0], capabilities: { tools: {} }, serverInfo: { name: "find-everything", version: VERSION } }; break;
      }
      case "ping": result = {}; break;
      case "tools/list": if (!ready) return error(-32000, "Initialize the session first"); result = { tools }; break;
      case "tools/call": {
        if (!ready) return error(-32000, "Initialize the session first");
        const params = message.params;
        const tool = tools.find(t => t.name === params?.name);
        if (!tool) return error(-32602, "Unknown tool");
        const args = params.arguments || {};
        if (!args || typeof args !== "object" || Array.isArray(args)) return error(-32602, "Arguments must be an object");
        const keys = Object.keys(tool.inputSchema.properties);
        if (Object.keys(args).some(k => !keys.includes(k)) || ("index" in args && typeof args.index !== "string") || (params.name === "search_files" && typeof args.query !== "string") || (params.name === "refresh_index" && typeof args.index !== "string")) return error(-32602, "Invalid tool arguments");
        try {
          let data: unknown;
          if (params.name === "search_files") data = await searchFiles(args.query, args.index || defaultIndex(), args.limit ?? 300, {}, false, true, args.offset ?? 0);
          else if (params.name === "list_indexes") data = { indexes: indexStatus() };
          else if (params.name === "query_help") data = QUERY_HELP;
          else if(params.name==='prepare_index'||params.name==='index_properties') {
            if(typeof args.index!=='string'||!fs.existsSync(indexPathFor(args.index)))throw new Error('Existing indexed scope required; create a snapshot explicitly with fe index');
            const seconds=args.seconds??10,maxFiles=args.maxFiles??1000;
            if(!Number.isInteger(seconds)||seconds<1||seconds>30||!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>10000)throw new Error('Invalid preparation budget');
            data=params.name==='prepare_index'?await prepareSearch(args.index,seconds):await indexProperties(args.index,maxFiles,seconds);
          }
          else { await rebuildIndex(args.index, {}); data = indexStatus().find(i => i.name === args.index); }
          result = { content: [{ type: "text", text: JSON.stringify(data) }] };
        } catch (e) { result = { content: [{ type: "text", text: e.message }], isError: true }; }
        break;
      }
      default: return error(-32601, "Method not found");
    }
    return { jsonrpc: "2.0", id, result };
  };
}

export async function serveMcp(): Promise<void> {
  const handle = mcpSession();
  let buffer = "", queued = 0;
  let work = Promise.resolve();
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { console.error("fe mcp: message limit exceeded"); process.exit(1); }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      if (++queued > 32) { console.error("fe mcp: request queue limit exceeded"); process.exit(1); }
      work = work.then(async () => {
        let request: unknown;
        try { request = JSON.parse(line); }
        catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
        const response = await handle(request);
        if (response) send(response);
      }).catch(e => { console.error(`fe mcp: ${e.message}`); process.exitCode = 1; }).finally(() => { queued--; });
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Incomplete message" } });
    void work.finally(closeSoundWorker);
  });
}
