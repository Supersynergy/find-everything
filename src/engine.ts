import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {favoritePaths,Omission} from './file-filters';
import { createHash, randomUUID } from "crypto";
import { Transform } from "stream";
import { pipeline, finished } from "stream/promises";
import { once } from "events";
import { acquireLock, BUILTIN_SCOPES, IndexOptions, profile, profiles, validateName } from "./catalog";
import { MEDIA_FIELDS, NumericFilter, normalizeQuery, numericFilters } from "./smart-query";
import { deltaFor } from "./delta";
import {recoverPublishedCompaction} from './compaction-recovery';

export const HOME = os.homedir();
export const IS_MAC = process.platform === "darwin";
export const INDEX_DIR = process.env.FE_DATA_DIR || path.join(HOME, ".cache", "hypersearch");

// Homebrew first, then system paths, then PATH lookup as last resort.
const BIN_DIRS = [
  path.join(
    HOME,
    "Library/Application Support/FindEverything/bin",
  ),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  path.join(HOME, ".local", "bin"),
  path.join(HOME, "bin"),
];
export const findBin = (name: string): string => {
  for (const d of BIN_DIRS) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return name;
};
export const FD = process.env.FE_FD || findBin("fd");
export const FZF = findBin("fzf");
export const RG = findBin("rg");
export const OPEN_CMD = IS_MAC ? findBin("open") : findBin("xdg-open");

export const BASE_EXCLUDES = [
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".Trash",
  ".DS_Store",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".npm",
  ".npx",
  ".bun",
  ".yarn",
  ".pnpm-store",
  ".cargo",
  ".cargo-target",
  ".rustup",
  ".pub-cache",
  ".dartServer",
  ".gem",
  ".gradle",
  ".m2",
  ".cocoapods",
  "Pods",
  "DerivedData",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  ".venv",
  ".venv*",
  ".venvs",
  "venv",
  ".tox",
  "site-packages",
  ".conda",
  ".pyenv",
  ".nvm",
  ".volta",
  ".deno",
  ".local",
  ".terraform",
  ".serverless",
  ".vercel",
  ".composer",
  ".nuget",
  ".gg",
  ".gemini",
  ".cmux-snapshots",
  ".orbstack",
  ".lmstudio",
  "Library",
  "go/pkg",
];
// Extra excludes when scanning from / (macOS + Linux system noise).
export const ALL_EXCLUDES = [
  "System",
  "dev",
  "net",
  "Volumes",
  "cores",
  "private/var",
  "proc",
  "sys",
  "run",
  "snap",
  "boot",
];

export type Scope = string;
export const SCOPES: Scope[] = [
  "home",
  "downloads",
  "documents",
  "applications",
  "all",
  "custom",
];

export interface EngineOpts extends IndexOptions {
  customSearchPaths?: string;
  paths?: string[];
}

export function effectiveOptions(scope: Scope, opts: EngineOpts = {}): EngineOpts {
  validateName(scope);
  const saved = BUILTIN_SCOPES.includes(scope) ? undefined : profile(scope);
  if (!BUILTIN_SCOPES.includes(scope) && !saved && !opts.paths) throw new Error(`Unknown index: ${scope}`);
  const metadata = BUILTIN_SCOPES.includes(scope) && fs.existsSync(metaPathFor(scope)) ? JSON.parse(fs.readFileSync(metaPathFor(scope),'utf8')).indexOptions : undefined;
  const result = { includeHidden: true, includeIgnored: false, indexMaxAgeMinutes: "60", ...metadata, ...saved, ...opts };
  if (result.exhaustive) { result.includeHidden = true; result.includeIgnored = true; }
  const age = Number(result.indexMaxAgeMinutes);
  if (!Number.isFinite(age) || age < 1 || age > 10080) throw new Error("Index max age must be 1–10080 minutes");
  return result;
}

export function scanExcludes(scope: Scope, opts: EngineOpts): string[] {
  return [...(opts.exhaustive ? [] : BASE_EXCLUDES),
    ...(opts.extraExcludes || '').split(',').map(s=>s.trim()).filter(Boolean),
    ...(scope === 'all' ? opts.exhaustive ? ['/dev','/proc','/sys','/System/Volumes/Data'] : ALL_EXCLUDES : [])];
}

export function scopePaths(scope: Scope, opts: EngineOpts): string[] {
  opts = effectiveOptions(scope, opts);
  if (opts.paths?.length) return opts.paths;
  const dirs = (() => {
    switch (scope) {
      case "home":
        return [HOME];
      case "downloads":
        return [path.join(HOME, "Downloads")];
      case "documents":
        return [path.join(HOME, "Documents")];
      case "applications":
        return IS_MAC
          ? ["/Applications", path.join(HOME, "Applications")]
          : [
              "/usr/share/applications",
              path.join(HOME, ".local/share/applications"),
            ];
      case "all":
        return ["/"];
      case "custom":
        return (opts.customSearchPaths || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      default:
        return opts.paths || [];
    }
  })();
  return dirs.filter((d) => d === "/" || fs.existsSync(d));
}

export const indexPathFor = (scope: Scope) => path.join(INDEX_DIR, `index-${validateName(scope)}.txt`);
export const shardDirFor = (scope: Scope) => path.join(INDEX_DIR, `index-${validateName(scope)}.d`);
const metaPathFor = (scope: Scope) => path.join(INDEX_DIR, `index-${validateName(scope)}.json`);
const signature = (scope: Scope, opts: EngineOpts) => createHash("sha256").update(JSON.stringify([
  2, scopePaths(scope, opts), opts.includeHidden, opts.includeIgnored, opts.extraExcludes || "", BASE_EXCLUDES,
  ...(opts.exhaustive ? ['exhaustive',scanExcludes(scope,opts)] : []),
])).digest("hex");
export const INDEX_TIMEOUT_MS = 120_000;
export const SEARCH_TIMEOUT_MS = 10_000;
// Flat indexes are streamed to disk, not retained in RAM. Bound disk use separately.
export const INDEX_DISK_LIMIT_BYTES = 32 * 1024 ** 3;
export const INDEX_FREE_RESERVE_BYTES = 2 * 1024 ** 3;
export function indexByteBudget(freeBytes: number): number {
  if (!Number.isFinite(freeBytes) || freeBytes <= INDEX_FREE_RESERVE_BYTES) {
    throw new Error("Not enough free disk space to build an index; keep at least 2 GiB free");
  }
  return Math.min(INDEX_DISK_LIMIT_BYTES, Math.floor(freeBytes - INDEX_FREE_RESERVE_BYTES));
}

export function createIndexNormalizer(byteBudget: number, stats: { count: number; bytes: number; skipped: number }): Transform {
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 1 || byteBudget > INDEX_DISK_LIMIT_BYTES) throw new Error("Invalid index disk budget");
  let pending = "";
  return new Transform({ transform(chunk, _encoding, done) {
    pending += chunk.toString("utf8");
    const entries = pending.split("\0"); pending = entries.pop()!;
    if (pending.length > 1024 * 1024) return done(new Error("Path exceeds index limit"));
    const valid = entries.filter(p => { if (/[\r\n]/.test(p)) { stats.skipped++; return false; } return p.length > 0; });
    const text = valid.length ? valid.join("\n") + "\n" : "";
    stats.count += valid.length; stats.bytes += Buffer.byteLength(text);
    if (stats.bytes > byteBudget) return done(new Error(`Index reached its safe disk limit (${(byteBudget / 1024 ** 3).toFixed(2)} GiB); free disk space or exclude generated folders`));
    done(null, text);
  }});
}

export const SHARD_COUNT = 8;
// Per-shard match cap -> at most SHARD_COUNT*cap candidates reach fzf,
// which bounds the worst-case query (e.g. "e") at ~30ms instead of seconds.
const SHARD_CAP = 4000;
const FILE_CAP = 32000;

const inFlight = new Map<string, Promise<void>>();
const activeChildren = new Set<ChildProcess>();
export function track<T extends ChildProcess>(child: T): T {
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}
export function stopChildren(): void { for (const child of activeChildren) child.kill("SIGKILL"); }

// The flat index stays canonical; shards are a derived cache that lets
// rg scan all 8 in parallel (~4x) and gives -m a spread across the tree.
export async function shardIndex(file: string, dir: string): Promise<void> {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
  const tmpDir = `${dir}.${randomUUID()}.tmp`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const outputs = Array.from({ length: SHARD_COUNT }, (_, i) => fs.createWriteStream(path.join(tmpDir, `s-${i}`), { mode: 0o600 }));
  const completed = Promise.allSettled(outputs.map(out => finished(out)));
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const timer = setTimeout(() => input.destroy(new Error("Sharding timed out")), 30_000);
  try {
    let i = 0, tail = "";
    for await (const chunk of input) {
      const text = tail + chunk;
      const end = text.lastIndexOf("\n");
      if (end < 0) { tail = text; continue; }
      tail = text.slice(end + 1);
      const out = outputs[i++ % SHARD_COUNT];
      if (!out.write(text.slice(0, end + 1))) await once(out, "drain");
    }
    if (tail) outputs[i % SHARD_COUNT].write(tail + "\n");
    outputs.forEach(out => out.end());
    const failed = (await completed).find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmpDir, dir);
  } finally {
    clearTimeout(timer); input.destroy(); outputs.forEach(out => out.destroy());
    await Promise.allSettled(outputs.map(out => finished(out)));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function rebuildIndex(scope: Scope, opts: EngineOpts, monitor?: { progress: (stats: { count: number; bytes: number }) => void; signal: AbortSignal; externalTimeout: boolean }): Promise<void> {
  opts = effectiveOptions(scope, opts);
  const file = indexPathFor(scope);
  recoverPublishedCompaction(file);
  const pending = inFlight.get(file);
  if (pending) return pending;

  const job = (async () => {
    const scanStartedAt = new Date().toISOString();
    fs.mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const release = acquireLock(lock);
    const tmp = `${file}.${randomUUID()}.tmp`;
    const metaTmp = `${metaPathFor(scope)}.${randomUUID()}.tmp`;
    try {
    const dirs = scopePaths(scope, opts);
    if (dirs.length === 0) throw new Error(`No folders configured for ${scope}; use fe index --path FOLDER --name NAME`);
    for (const dir of dirs) if (!fs.statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`);
    const excludes = scanExcludes(scope, opts);
    const args = ["--absolute-path", "--color=never", "--print0", "--show-errors", "--threads", "2"];
    if (opts.includeHidden) args.push("--hidden");
    if (opts.includeIgnored) args.push("--no-ignore");
    for (const e of excludes) args.push("--exclude", e);
    args.push("", ...dirs);

    const disk = fs.statfsSync(INDEX_DIR);
    const budget = indexByteBudget(disk.bavail * disk.bsize);
    const stats = { count: 0, bytes: 0, skipped: 0 };
    const normalizer = createIndexNormalizer(budget, stats);
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    // The core app must work on a fresh Mac without Homebrew or downloading helpers.
    // System find respects the explicit exclusions above, but not per-project ignore files.
    const systemWalker = !fs.existsSync(FD) && FD === "fd";
    const patterns = excludes.flatMap(pattern => {
      const clean = pattern.replace(/^\/+|\/+$/g, "");
      if (!clean) return [];
      if (pattern.startsWith('/')) return dirs.flatMap(root=>['-path',path.join(root,clean)]);
      return [clean.includes("/") ? "-path" : "-name", clean.includes("/") ? `*/${clean}` : clean];
    });
    if (!opts.includeHidden) patterns.push("-name", ".*");
    const findArgs = [...dirs];
    if (patterns.length) {
      const conditions: string[] = [];
      for (let i = 0; i < patterns.length; i += 2) {
        if (conditions.length) conditions.push("-o");
        conditions.push(patterns[i], patterns[i + 1]);
      }
      findArgs.push("(", ...conditions, ")", "-prune", "-o");
    }
    findArgs.push("-print0");
    const child = track(spawn(systemWalker ? "/usr/bin/find" : FD, systemWalker ? findArgs : args));
    child.stdout.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", d => { stderr = (stderr + d).slice(-2000); });
    // The progress supervisor enforces active time while its entire worker group can pause.
    const timer = monitor?.externalTimeout ? undefined : setTimeout(() => child.kill("SIGKILL"), INDEX_TIMEOUT_MS);
    monitor?.progress(stats);
    const progressTimer = monitor ? setInterval(() => monitor.progress(stats), 200) : undefined;
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => {
        // Protected macOS folders are expected; permission failures are not full coverage.
        const permissionOnly = systemWalker && code === 1 && stderr.trim().split("\n").every(line => /: (Permission denied|Operation not permitted)$/.test(line));
        if (code === 0 || permissionOnly) resolve();
        else reject(new Error(`File scanner exited ${code}: ${stderr || "scan failed or timed out"}`));
      });
    });
    try { await Promise.all([pipeline(child.stdout, normalizer, out, { signal: monitor?.signal }), exited]); }
    finally { if (timer) clearTimeout(timer); if (progressTimer) clearInterval(progressTimer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    monitor?.progress(stats);
    const provenanceWarnings = [
      ...(stderr.trim() ? ['File scanner reported inaccessible paths or other errors; coverage is incomplete.'] : []),
      ...(stats.skipped ? [`Skipped ${stats.skipped} paths containing line breaks; coverage is incomplete.`] : []),
    ];
    const indexOptions={includeHidden:opts.includeHidden,includeIgnored:opts.includeIgnored,extraExcludes:opts.extraExcludes,indexMaxAgeMinutes:opts.indexMaxAgeMinutes,exhaustive:opts.exhaustive};
    fs.writeFileSync(metaTmp, JSON.stringify({ signature: signature(scope, opts), ...stats, paths: dirs, indexOptions, scanStartedAt, indexedAt: new Date().toISOString(), provenanceWarnings }), { mode: 0o600 });
    // Finish both files before publishing the complete flat snapshot. Search preparation
    // is a separately resumable derived-cache stage, not an unfinished directory scan.
    fs.renameSync(tmp, file);
    fs.renameSync(metaTmp, metaPathFor(scope));
    } finally {
      try { fs.rmSync(tmp, { force: true }); fs.rmSync(metaTmp, { force: true }); }
      finally { release(); }
    }
  })().finally(() => inFlight.delete(file));

  inFlight.set(file, job);
  return job;
}

// Shard dir may be missing on upgrade from a flat-index install; split it
// on the fly (~150ms) instead of waiting for the next fd rebuild.
export async function ensureShards(scope: Scope): Promise<void> {
  const file = indexPathFor(scope);
  const dir = shardDirFor(scope);
  if (!fs.existsSync(file)) return;
  if (fs.existsSync(`${file}.lock`)) return;
  const dirFresh =
    fs.existsSync(dir) &&
    fs.statSync(dir).mtimeMs >= fs.statSync(file).mtimeMs;
  if (!dirFresh) await shardIndex(file, dir);
}

export async function ensureIndex(
  scope: Scope,
  opts: EngineOpts,
  force = false,
  _background = false,
  _snapshot = false,
): Promise<string> {
  opts = effectiveOptions(scope, opts);
  const file = indexPathFor(scope);
  if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && !force) {
    return file;
  }
  if(!force&&!opts.paths?.length)throw new Error(`No saved index for ${scope}; create it explicitly with fe index --index ${scope}`);
  await rebuildIndex(scope, opts);
  return file;
}

export function indexStatus() {
  return [...SCOPES.filter(s => s !== "custom"), ...profiles().map(p => p.name)].map(name => {
    const file = indexPathFor(name);
    const stat = fs.existsSync(file) ? fs.statSync(file) : undefined;
    const meta = fs.existsSync(metaPathFor(name)) ? JSON.parse(fs.readFileSync(metaPathFor(name), "utf8")) : {};
    const opts = effectiveOptions(name);
    return { name, paths: scopePaths(name, opts), options: opts, exists: !!stat, bytes: stat?.size || 0,
      indexedAt: stat?.mtime.toISOString() || null, scanStartedAt:meta.scanStartedAt || null, count: meta.count ?? null, skipped: meta.skipped || 0,
      exclusions: scanExcludes(name,opts),
      provenanceWarnings: Array.isArray(meta.provenanceWarnings)?meta.provenanceWarnings:[],
      configurationChanged: !!stat && meta.signature !== signature(name, opts),
      stale: !stat || meta.signature !== signature(name, opts) || Date.now() - stat.mtimeMs > Number(opts.indexMaxAgeMinutes) * 60_000 };
  });
}

export function snapshotDescription(scope:Scope,opts:EngineOpts,count:number,bytes:number,provenanceWarnings:string[]=[]) {
  const now=new Date().toISOString();
  return {signature:signature(scope,effectiveOptions(scope,opts)),count,bytes,skipped:0,paths:scopePaths(scope,opts),scanStartedAt:now,indexedAt:now,provenanceWarnings};
}

// Search target: shard dir when available (parallel scan), flat file else.
function searchTarget(scope: Scope): { target: string; isDir: boolean } {
  const dir = shardDirFor(scope);
  if (fs.existsSync(dir) && fs.statSync(dir).mtimeMs >= fs.statSync(indexPathFor(scope)).mtimeMs && fs.readdirSync(dir).length > 0)
    return { target: dir, isDir: true };
  return { target: indexPathFor(scope), isDir: false };
}

// Query language (Everything-style, validated): `ext:md;pdf` / `*.md`
// extension lists, `in:downloads` / bare `invoice in downloads` location
// scoping, `type:doc|image|video|audio|zip|code|app|hidden` macros,
// `!noise` exclusion, `a|b` alternation, `"exact phrase"` literal,
// `sort:name|new|old|big|small` result ordering, `size:>10m` / `dm:today`
// Indexed filters run before pagination. Unconsumed words stay fuzzy terms.
export interface ParsedQuery {
  matchCase?: boolean;
  wholeWord?: boolean;
  smart?: boolean;
  learning?: boolean;
  learned?: {path:string;boost:number}[];
  semantic?: string;
  content?: string;
  meaning?: string;
  mediaFilters: NumericFilter[];
  fuzzy: string[]; // fzf filter terms ('exact, a|b, plain)
  constraints: { pattern: string; negate: boolean; literal?:string; field?:'name'|'folder'; prefix?:boolean; suffixes?:string[]; alternatives?:string[] }[];
  sort?: string;
  sizeFilter?: { op: string; bytes: number; maxBytes?:number };
  dmFilter?: { days: number };
  favorites?:string[];
  omit?:Omission[];
}
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const IN_ALIASES: Record<string, string> = {
  downloads: "Downloads", documents: "Documents", docs: "Documents",
  desktop: "Desktop", pictures: "Pictures", pics: "Pictures",
  music: "Music", movies: "Movies", applications: "Applications",
  apps: "Applications", projects: "Projects",
};
const TYPE_MACROS: Record<string, string> = {
  doc: "txt|md|pdf|rtf|odt|doc|docx|pages|tex|epub",
  image: "png|jpe?g|gif|webp|svg|heic|tiff?|bmp|ico",
  video: "mp4|m4v|mov|mkv|avi|webm|wmv|flv",
  audio: "mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma",
  zip: "zip|tar|tgz|gz|bz2|xz|rar|7z",
  code: "py|js|ts|tsx|jsx|swift|rs|go|c|h|cpp|cc|mm|m|java|kt|rb|sh|zsh|pl|lua|sql|html|css|json|ya?ml|toml|xml",
  app: "app|dmg|pkg",
};
const SIZE_UNITS: Record<string, number> = {
  b: 1, k: 1 << 10, kb: 1 << 10, m: 1 << 20, mb: 1 << 20,
  g: 1 << 30, gb: 1 << 30,
};
const DM_DAYS: Record<string, number> = {
  today: 1, yesterday: 2, week: 7, thisweek: 7,
  month: 31, thismonth: 31, year: 366, thisyear: 366,
};
export function parseQuery(q: string): ParsedQuery {
  if(q.includes('\0'))throw new Error('NUL is not valid in a filename or query');
  q = normalizeQuery(q).normalize('NFC');
  const pq: ParsedQuery = { fuzzy: [], constraints: [], mediaFilters: [] };
  q = q.replace(/sound:("(?:\\.|[^"\\\n])+")/g, (_, encoded) => {
    const description=JSON.parse(encoded);
    if (pq.semantic) throw new Error("Use one sound description per query");
    if (description.length > 512) throw new Error("Sound description exceeds 512 characters");
    pq.semantic = description; return " ";
  });
  const toks = q.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) || [];
  if(q.replace(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g,'').trim())throw new Error('Unclosed quoted value');
  const unquote = (s:string) => {
    if (!s.startsWith('"')) return s;
    try {const value=JSON.parse(s);if(typeof value==='string'&&!value.includes('\0'))return value;} catch {throw new Error('Invalid quoted value');}
    throw new Error('Invalid quoted value');
  };
  if (toks.length + pq.fuzzy.length > 32) throw new Error("Use at most 32 search terms or filters");
  const inTarget = (v: string) => {
    const lv = v.toLowerCase();
    if (IN_ALIASES[lv])
      return `/${IN_ALIASES[lv]}/`;
    if (v.startsWith("/") || v.startsWith("~"))
      return (v.startsWith("~") ? HOME + v.slice(1) : v).replace(/\/+$/,'')+'/';
    return `/${v}/`;
  };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.startsWith('"')) {pq.fuzzy.push("'"+unquote(tok));continue;}
    // bare ` in X` keyword (Raycast style): `invoice in downloads`
    if ((tok === "in" || tok === "in:") && toks[i + 1]) {
      const value=unquote(toks[++i]),literal=inTarget(value);pq.constraints.push({ pattern: reEsc(literal), literal, field:'folder', prefix:value.startsWith('/')||value.startsWith('~'), negate: false });
      continue;
    }
    if (tok.startsWith("!") && tok.length > 1) {
      pq.constraints.push({ pattern: reEsc(tok.slice(1)),literal:tok.slice(1), negate: true });
      continue;
    }
    if (tok.startsWith("*." ) && /^[\w-]+$/.test(tok.slice(2))) {
      pq.constraints.push({ pattern: `\\.${tok.slice(2)}\\/?$`,suffixes:['.'+tok.slice(2).toLowerCase()], negate: false });
      continue;
    }
    if(/^(content|meaning):$/i.test(tok))throw new Error('content: and meaning: require a word or quoted phrase');
    const m = tok.match(/^([a-z]+):(.+)$/i);
    if (m) {
      const k = m[1].toLowerCase();
      const v = unquote(m[2]);
      const lv = v.toLowerCase();
      if(k==='literal'){
        if(!v.length||Buffer.byteLength(v)>4096)throw new Error('literal: needs 1–4096 UTF-8 bytes');
        pq.constraints.push({pattern:reEsc(v),literal:v,negate:false});continue;
      }
      if(k==='case'||k==='word'){
        if(k==='case'&&lv==='smart'){pq.matchCase=undefined;continue;}
        if(!['yes','true','1','no','false','0'].includes(lv))throw new Error(`${k}: use yes or no${k==='case'?' or smart':''}`);
        const enabled=['yes','true','1'].includes(lv);
        if(k==='case')pq.matchCase=enabled;else pq.wholeWord=enabled;
        continue;
      }
      if(k==='meaning') {
        if(pq.meaning!==undefined)throw new Error('Use one meaning: description per query');
        if(!v.trim()||Buffer.byteLength(v)>2048||!/[\p{L}\p{N}]/u.test(v)||/[\r\n\0]/.test(v))throw new Error('meaning: requires a document description of at most 2048 UTF-8 bytes');
        pq.meaning=v.trim();continue;
      }
      if(k==='content') {
        if(pq.content!==undefined)throw new Error('Use one content: word or quoted phrase per query');
        if(!v.trim()||Buffer.byteLength(v)>512||!/[\p{L}\p{N}]/u.test(v)||/[\r\n\0]/.test(v))throw new Error('content: requires a literal word or phrase, at most 512 UTF-8 bytes');
        pq.content=v.trim();continue;
      }
      if (MEDIA_FIELDS[k]) { pq.mediaFilters.push(...numericFilters(k, lv)); continue; }
      if(k==='favorites'||k==='fav'||((k==='is'||k==='type')&&['favorite','favorites'].includes(lv))){
        if(['true','yes','1','favorite','favorites'].includes(lv))pq.favorites=favoritePaths();
        else if(['false','no','0'].includes(lv))pq.favorites=undefined;
        else throw new Error('Use favorites:true or favorites:false');
        continue;
      }
      if(k==='view'){
        if(lv==='smart')pq.smart=true;else if(lv==='all'){pq.smart=false;pq.omit=[];}else if(lv==='working'){pq.smart=false;pq.omit=['system','generated'];}else throw new Error('Use view:smart, view:working or view:all');
        continue;
      }
      if(k==='learn'){if(!['on','off'].includes(lv))throw new Error('Use learn:on or learn:off');pq.learning=lv==='on';continue;}
      if(k==='omit'){
        const kinds=lv==='none'?[]:lv.split(';');if(kinds.some(v=>!['system','generated','hidden','noise'].includes(v)))throw new Error('Use omit:system;generated;hidden;noise');
        pq.omit=[...new Set(kinds)] as Omission[];continue;
      }
      if (k === "ext") {
        // ext:md;pdf;txt — `;` lists like Everything
        const parts = lv.split(";").filter((e) => /^[\w-]+(\.[\w-]+)*$/.test(e));
        if(!parts.length||parts.length!==lv.split(';').length)throw new Error('Invalid extension filter');
        if (parts.length)
          pq.constraints.push({
            pattern: `\\.(${parts.map(reEsc).join("|")})\\/?$`,
            suffixes:parts.map(p=>'.'+p),
            negate: false,
          });
        continue;
      }
      if (k === "in") {
        const literal=inTarget(v);pq.constraints.push({ pattern: reEsc(literal),literal, field:'folder', prefix:v.startsWith('/')||v.startsWith('~'), negate: false });
        continue;
      }
      if (k === "name") {
        if(!v || v.includes('/'))throw new Error('Name filter needs a filename fragment without /');
        pq.constraints.push({pattern:reEsc(v)+'[^/]*\\/?$',literal:v,field:'name',negate:false});
        continue;
      }
      if (k === "type" || k === "is" || k === "kind") {
        if (TYPE_MACROS[lv]) {
          pq.constraints.push({
            pattern: `\\.(${TYPE_MACROS[lv]})\\/?$`,
            suffixes:TYPE_MACROS[lv].split('|').flatMap(p=>{const m=p.match(/^(.*)([a-z])\?(.*)$/);return m?[m[1]+m[3],m[1]+m[2]+m[3]]:[p];}).map(p=>'.'+p),
            negate: false,
          });
        } else if (lv === "hidden" || lv === "dot") {
          pq.constraints.push({ pattern: "/\\.",literal:'/.', negate: false });
        } else throw new Error('Unknown file type; use audio, video, image, doc, code, zip, app or hidden');
        continue;
      }
      if (k === "sort") {
        if (/^(relevance|name|name-desc|path|path-desc|new|old|big|small|size)$/.test(lv))
          pq.sort = lv === "size" ? "big" : lv;
        else throw new Error('Unknown sort; use relevance, name, name-desc, path, path-desc, new, old, big or small');
        continue;
      }
      if (k === "size") {
        const range=lv.match(/^(\d+(?:\.\d+)?)(b|kb?|mb?|gb?)?\.\.(\d+(?:\.\d+)?)(b|kb?|mb?|gb?)?$/);
        if(range){
          const bytes=Number(range[1])*(SIZE_UNITS[range[2]||'b']),maxBytes=Number(range[3])*(SIZE_UNITS[range[4]||'b']);
          if(!Number.isFinite(bytes)||!Number.isFinite(maxBytes)||bytes>maxBytes)throw new Error('Invalid size range');
          pq.sizeFilter={op:'range',bytes,maxBytes};continue;
        }
        const sm = lv.match(/^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)(b|kb?|mb?|gb?)?$/);
        if (sm)
          pq.sizeFilter = {
            op: sm[1] || ">",
            bytes: parseFloat(sm[2]) * (SIZE_UNITS[sm[3] || "b"] || 1),
          };
        else throw new Error('Invalid size filter; use size:>10m, size:=0 or size:1m..10m');
        if(!Number.isFinite(pq.sizeFilter.bytes))throw new Error('Size exceeds supported range');
        continue;
      }
      if (k === "dm" || k === "modified") {
        if (DM_DAYS[lv]) pq.dmFilter = { days: DM_DAYS[lv] };
        else {
          const dm = lv.match(/^(?:<|in)?(\d+)d$/);
          if (dm) pq.dmFilter = { days: parseInt(dm[1]) };
          else throw new Error('Invalid modified-date filter');
        }
        continue;
      }
    }
    if (tok.includes("|")) {
      // a|b alternation: rg gets a regex stage, fzf keeps native `|`
      const alts = tok.split("|").filter(Boolean).map(reEsc);
      if (alts.length > 1) {
        pq.constraints.push({ pattern: `(${alts.join("|")})`,alternatives:tok.split('|').filter(Boolean), negate: false });
        pq.fuzzy.push(tok);
        continue;
      }
    }
    pq.fuzzy.push(tok);
  }
  if(pq.fuzzy.length>16)throw new Error('Use at most 16 search terms');
  if(pq.smart&&pq.omit===undefined)pq.omit=['system','generated','hidden','noise'];
  if(pq.smart&&pq.omit){
    const literals=[...pq.fuzzy.map(t=>t.replace(/^'/,'')),...pq.constraints.flatMap(c=>c.negate||c.literal===undefined?[]:[c.literal])];
    // An explicit extension/filename is intentional, not background clutter.
    if(pq.constraints.some(c=>c.suffixes)||literals.some(t=>/\.[a-z0-9_]+$/i.test(t)))pq.omit=pq.omit.filter(v=>v!=='noise');
    if(literals.some(t=>t==='/.'||/(?:^|\/)\.[^/]/.test(t)))pq.omit=pq.omit.filter(v=>v!=='hidden');
  }
  return pq;
}

// Pipeline: rg(term1, file/dir directly) -> rg(term2) ... -> fzf --filter
// rg narrows the index to ~2k candidates in ~25ms (8 parallel shards);
// fzf ranks them. Each shard is -m capped so worst-case queries stay ~30ms.
export function runSearch(
  query: string,
  scope: Scope,
  limit: number,
  onSpawn?: (c: ChildProcess[]) => void,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const pq = parseQuery(query);
    const delta = deltaFor(scope);
    const children: ChildProcess[] = [];
    onSpawn?.(children);
    let finished = false;
    const finish = (error?: Error, output: string[] = []) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const c of children) c.kill("SIGKILL");
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error("Search timed out")), SEARCH_TIMEOUT_MS);

    let stream: NodeJS.ReadableStream | undefined;
    if (RG) {
      const { target, isDir } = searchTarget(scope);
      const stages: string[][] = [];
      for (const term of pq.fuzzy) {
        if (term.includes("|")) continue; // alternation already a regex stage
        stages.push([
          ...(isDir ? ["--no-ignore", "--no-filename"] : []),
          "-S", "-F",
          "--no-line-number", "--",
          term.startsWith("'") ? term.slice(1) : term,
        ]);
      }
      for (const c of pq.constraints) {
        stages.push([
          ...(isDir ? ["--no-ignore", "--no-filename"] : []),
          "-i", ...(c.negate ? ["-v"] : []),
          "--no-line-number", "--", c.pattern,
        ]);
      }
      for (const [i, args] of stages.entries()) {
        if (i === stages.length - 1) args.splice(args.indexOf("--"), 0, "-m", String(isDir ? SHARD_CAP : FILE_CAP));
        if (i === 0) args.push(target);
        const p = track(spawn(RG, args, {
          stdio: ["pipe", "pipe", "ignore"],
        }));
        children.push(p);
        p.on("error", e => finish(new Error(`rg: ${e.message}`)));
        p.on("close", code => { if (code !== null && code > 1) finish(new Error(`rg exited ${code}`)); });
        p.stdin!.on("error", () => {}); // EPIPE on early kill
        p.stdout!.on("error", () => {});
        if (stream) stream.pipe(p.stdin!);
        stream = p.stdout!;
      }
    }
    if (!stream) {
      stream = fs.createReadStream(indexPathFor(scope));
      stream.on("error", e => finish(e as Error));
    }
    let pendingLine = "";
    const constraints = pq.constraints.map(c => ({ re: new RegExp(c.pattern,"i"), negate:c.negate }));
    const matches = (p: string) => constraints.every(c => c.re.test(p) !== c.negate) && pq.fuzzy.every(term => term.includes("|") || (/[A-Z]/.test(term) ? p.includes(term.replace(/^'/,"")) : p.toLowerCase().includes(term.replace(/^'/,"").toLowerCase())));
    const overlay = new Transform({ transform(chunk,_encoding,done) {
      pendingLine += chunk.toString(); const lines = pendingLine.split("\n"); pendingLine = lines.pop()!;
      for (const p of lines) if (delta.visible(p,true)) this.push(p+"\n");
      done();
    }, flush(done) {
      if (pendingLine && delta.visible(pendingLine,true)) this.push(pendingLine+"\n");
      for (const p of delta.additions) if (matches(p)) this.push(p+"\n");
      done();
    }});
    stream.setEncoding?.("utf8"); stream = stream.pipe(overlay);
    // fzf needs `a | b` with spaces for OR; quoted terms use 'exact syntax.
    const fzfFilter = pq.fuzzy
      .map((t) => (t.includes("|") ? t.split("|").join(" | ") : t))
      .join(" ");
    const fzfArgs = [`--filter=${fzfFilter}`, "--scheme=path", "--no-bold"];
    const fz = track(spawn(
      FZF, fzfArgs,
      { stdio: ["pipe", "pipe", "ignore"] },
    ));
    children.push(fz);
    fz.stdin!.on("error", () => {});
    stream.pipe(fz.stdin!);

    let buf = "", outputBytes = 0;
    fz.stdout!.setEncoding("utf8");
    fz.stdout!.on("data", (d) => {
      const s = d.toString();
      buf += s;
      outputBytes += Buffer.byteLength(s);
      if (outputBytes > 8 * 1024 * 1024) finish(new Error("Search output exceeds 8 MiB; narrow the query"));
    });
    fz.on("close", code => {
      if (code !== 0 && code !== 1) return finish(new Error(`fzf exited ${code}`));
      finish(undefined, buf.split("\n").filter(Boolean).slice(0, limit));
    });
    fz.on("error", e => finish(new Error(`fzf: ${e.message}`)));
  });
}

// fzf ranks the rg-filtered candidates; afterwards we partition so that
// hits whose basename contains ALL query terms float to the top.
// Takes the raw query; operator tokens are parsed away internally.
export function rerank(paths: string[], q: string): string[] {
  const groups = parseQuery(q)
    .fuzzy.map((t) => t.replace(/^'/, "").toLowerCase())
    .map((t) => t.split("|")); // each group's alts are OR-ed
  const seen = new Set<string>();
  const nameHit: string[] = [];
  const rest: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    const base = path.basename(p).toLowerCase();
    (groups.every((g) => g.some((alt) => base.includes(alt)))
      ? nameHit
      : rest
    ).push(p);
  }
  return [...nameHit, ...rest];
}

// Post-filters needing stat() run on the visible top-N only (the flat
// index stores just paths — stat'ing 4.6M entries would defeat it).
export function applyPostFilters(paths: string[], pq: ParsedQuery): string[] {
  if (!pq.sizeFilter && !pq.dmFilter && !pq.sort) return paths;
  let items = paths.map((p) => {
    try {
      const s = fs.statSync(p);
      return { p, size: s.size, mtime: s.mtimeMs };
    } catch {
      return { p, size: 0, mtime: 0 };
    }
  });
  if (pq.sizeFilter)
    items = items.filter(i => matchesSize(i.size,pq.sizeFilter));
  if (pq.dmFilter)
    items = items.filter(
      (i) => Date.now() - i.mtime <= pq.dmFilter!.days * 86_400_000,
    );
  if (pq.sort === "name" || pq.sort === 'name-desc') items.sort((a,b)=>(path.basename(a.p).toLowerCase().localeCompare(path.basename(b.p).toLowerCase())||a.p.localeCompare(b.p))*(pq.sort==='name-desc'?-1:1));
  else if(pq.sort==='path'||pq.sort==='path-desc')items.sort((a,b)=>a.p.toLowerCase().localeCompare(b.p.toLowerCase())*(pq.sort==='path-desc'?-1:1));
  else if (pq.sort === "new") items.sort((a, b) => b.mtime - a.mtime);
  else if (pq.sort === "old") items.sort((a, b) => a.mtime - b.mtime);
  else if (pq.sort === "big") items.sort((a, b) => b.size - a.size);
  else if (pq.sort === "small") items.sort((a, b) => a.size - b.size);
  return items.map((i) => i.p);
}

export function matchesSize(value:number|null|undefined,filter:ParsedQuery['sizeFilter']) {
  if(value==null)return false;
  if(!filter)return true;
  return filter.op==='range'?value>=filter.bytes&&value<=filter.maxBytes!:filter.op==='>'?value>filter.bytes:filter.op==='<'?value<filter.bytes:filter.op==='>='?value>=filter.bytes:filter.op==='<='?value<=filter.bytes:value===filter.bytes;
}
export function compareSearchProperties(a:{path:string;size?:number|null;mtime?:number|null},b:{path:string;size?:number|null;mtime?:number|null},sort:string) {
  const compare=(x:string,y:string)=>x<y?-1:x>y?1:0,tie=compare(a.path,b.path);
  if(sort==='name'||sort==='name-desc')return (compare(path.basename(a.path).toLowerCase(),path.basename(b.path).toLowerCase())||tie)*(sort==='name-desc'?-1:1);
  if(sort==='path'||sort==='path-desc')return (compare((path.dirname(a.path)+'/').toLowerCase(),(path.dirname(b.path)+'/').toLowerCase())||compare(path.basename(a.path).toLowerCase(),path.basename(b.path).toLowerCase())||tie)*(sort==='path-desc'?-1:1);
  if(!['new','old','big','small'].includes(sort))throw new Error(`Not a property sort: ${sort}`);
  const field=sort==='new'||sort==='old'?'mtime':'size',x=a[field],y=b[field];
  if(x==null||y==null)return x==null?(y==null?tie:1):-1;
  return (x-y)*(sort==='new'||sort==='big'?-1:1)||tie;
}
export {humanBytes,prettyPath} from './file-display';

export function openPath(p: string): void {
  spawn(OPEN_CMD, [p], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}
