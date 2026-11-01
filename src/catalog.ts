import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

export const CONFIG_DIR = process.env.FE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "find-everything");
export const BUILTIN_SCOPES = ["home", "downloads", "documents", "applications", "all", "custom"];
export interface IndexOptions {
  includeHidden?: boolean;
  includeIgnored?: boolean;
  extraExcludes?: string;
  indexMaxAgeMinutes?: string;
}
export interface IndexProfile extends IndexOptions { name: string; paths: string[] }
const catalogFile = path.join(CONFIG_DIR, "indexes.json");

export function validateName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Index name must be 1–64 letters, numbers, hyphens or underscores");
  return name;
}

export function canonicalPaths(inputs: string[]): string[] {
  if (!inputs.length) throw new Error("Specify at least one folder");
  if (inputs.length > 64) throw new Error("Use at most 64 root folders per index");
  const roots = [...new Set(inputs.map(input => {
    const expanded = input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
    const p = fs.realpathSync(path.resolve(expanded));
    if (!fs.statSync(p).isDirectory()) throw new Error(`Not a folder: ${input}`);
    if (/[\r\n]/.test(p)) throw new Error("Folder names containing line breaks are unsupported");
    return p;
  }))].sort();
  return roots.filter((p, i) => !roots.slice(0, i).some(parent => p.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)));
}

export function profiles(): IndexProfile[] {
  if (!fs.existsSync(catalogFile)) return [];
  if (fs.statSync(catalogFile).size > 1024 * 1024) throw new Error("Index catalog exceeds 1 MiB");
  const data = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  if (data.version !== 1 || !Array.isArray(data.indexes) || data.indexes.length > 256) throw new Error(`Invalid catalog: ${catalogFile}`);
  const names = new Set<string>();
  return data.indexes.map((p: IndexProfile) => {
    validateName(p.name);
    if (names.has(p.name) || BUILTIN_SCOPES.includes(p.name) || !Array.isArray(p.paths) || !p.paths.length || p.paths.length > 64 || p.paths.some(v => typeof v !== "string" || !path.isAbsolute(v) || /[\r\n]/.test(v))
      || (p.includeHidden !== undefined && typeof p.includeHidden !== "boolean") || (p.includeIgnored !== undefined && typeof p.includeIgnored !== "boolean")
      || (p.extraExcludes !== undefined && typeof p.extraExcludes !== "string")
      || (p.indexMaxAgeMinutes !== undefined && (!Number.isFinite(Number(p.indexMaxAgeMinutes)) || Number(p.indexMaxAgeMinutes) < 1 || Number(p.indexMaxAgeMinutes) > 10080))) throw new Error(`Invalid index profile: ${p.name}`);
    names.add(p.name);
    return p;
  });
}

export function profile(name: string): IndexProfile | undefined {
  return profiles().find(p => p.name === name);
}

export function defaultIndex():string {return profiles().some(p=>p.name==='everything')?'everything':'home';}

export function saveProfile(item: IndexProfile, replace = false): void {
  validateName(item.name);
  if (BUILTIN_SCOPES.includes(item.name)) throw new Error(`Reserved index name: ${item.name}`);
  const validated = { ...item, paths: canonicalPaths(item.paths) };
  editCatalog(items => {
    if (!replace && items.some(p => p.name === item.name)) throw new Error(`Index already exists: ${item.name}; use --replace to update it`);
    return [...items.filter(p => p.name !== item.name), validated];
  });
}

export function removeProfile(name: string): void {
  editCatalog(items => {
    if (!items.some(p => p.name === name)) throw new Error(`Unknown index: ${name}`);
    return items.filter(p => p.name !== name);
  });
}

function editCatalog(edit: (items: IndexProfile[]) => IndexProfile[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const lock = `${catalogFile}.lock`;
  const release = acquireLock(lock);
  const tmp = `${catalogFile}.${randomUUID()}.tmp`;
  try {
    const items = edit(profiles());
    if (items.length > 256) throw new Error("Use at most 256 saved indexes");
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, indexes: items }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, catalogFile);
  } finally {
    release();
    fs.rmSync(tmp, { force: true });
  }
}

export function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      return () => { fs.closeSync(fd); fs.rmSync(file, { force: true }); };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let abandoned = false;
      try {
        const owner = Number(fs.readFileSync(file, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (cause) { if (cause.code === "ESRCH") abandoned = true; }
        } else abandoned = Date.now() - fs.statSync(file).mtimeMs > 30_000;
      } catch (cause) { if (cause.code === "ENOENT") continue; throw cause; }
      if (abandoned && attempt === 0) { fs.rmSync(file, { force: true }); continue; }
      throw new Error(`Index/catalog is busy; another process holds ${path.basename(file)}`);
    }
  }
  throw new Error("Could not acquire index lock; retry shortly");
}

export function pathIndexName(paths: string[], options: IndexOptions): string {
  return `path-${createHash("sha256").update(JSON.stringify([paths, options])).digest("hex").slice(0, 16)}`;
}
