import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireLock} from './catalog';

export const favoritesFile=()=>process.env.FE_FAVORITES_FILE||path.join(os.homedir(),'Library/Application Support/FindEverything/pins.json');
export function favoritePaths():string[] {
  const file=favoritesFile();
  try {
    if(fs.statSync(file).size>2*1024*1024)throw new Error('Favorites exceed 2 MiB');
    const values=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!Array.isArray(values)||values.length>10000||values.some(p=>typeof p!=='string'||!path.isAbsolute(p)||p.length>4096||/[\r\n\0]/.test(p)))throw new Error('Invalid favorites file');
    return [...new Set(values)];
  }catch(e){if(e.code==='ENOENT')return [];throw e;}
}
export function changeFavorites(action:string,values:string[]) {
  if(!['list','add','remove'].includes(action))throw new Error('Use favorites list, add PATH or remove PATH');
  if(action==='list')return {paths:favoritePaths()};
  if(!values.length||values.some(p=>!path.isAbsolute(p)||p.length>4096||/[\r\n\0]/.test(p)))throw new Error('Favorites require absolute paths without line breaks');
  const file=favoritesFile();fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const release=acquireLock(file+'.lock');
  try {
    const previous=favoritePaths(),set=new Set(previous);
    for(const value of values)if(action==='add')set.add(value);else set.delete(value);
    const paths=[...set];if(paths.length>10000)throw new Error('Favorites are limited to 10000 paths');
    const data=JSON.stringify(paths);if(Buffer.byteLength(data)>2*1024*1024)throw new Error('Favorites exceed 2 MiB');
    if(JSON.stringify(previous)!==data){const temporary=file+'.'+randomUUID();try {fs.writeFileSync(temporary,data,{mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}}
    return {paths};
  }finally{release();}
}
export type Omission='system'|'generated'|'hidden'|'noise';
export const NOISE_SUFFIXES=['.log','.tmp','.temp','.bak','.swp','.swo','.pyc','.pyo','.o','.a','.so','.dylib','.dll','.class','.map','.tsbuildinfo','.DS_Store'];
export const NOISE_NAMES=['package-lock.json','bun.lock','bun.lockb','yarn.lock','pnpm-lock.yaml','cargo.lock','poetry.lock','uv.lock','thumbs.db','desktop.ini'];
export function noiseFilename(name:string){const value=name.toLowerCase();return NOISE_NAMES.includes(value)||NOISE_SUFFIXES.some(s=>value.endsWith(s.toLowerCase()));}
export const GENERATED=['node_modules','.git','.build','__pycache__','.cache','.venv','target','DerivedData','.next','dist','build','.turbo','coverage','.pytest_cache','.mypy_cache','.ruff_cache','.gradle','.svelte-kit'];
const ruleCache=new Map<string,{glob:string;term:string}[]>();
export function omissionRules(kinds:Omission[]) {
  const key=kinds.join(';'),cached=ruleCache.get(key);if(cached)return cached;
  const rules:{glob:string;term:string}[]=[];
  if(kinds.includes('system'))for(const root of ['/System/','/Library/','/private/','/usr/','/bin/','/sbin/','/dev/',os.homedir()+'/Library/'])rules.push({glob:root.toLowerCase()+'*',term:root.split('/').filter(Boolean).at(-1)!.toLowerCase()});
  if(kinds.includes('generated')){for(const name of GENERATED)rules.push({glob:'*/'+name.toLowerCase()+'/*',term:name.toLowerCase()});rules.push({glob:'*/*.app/contents/*',term:'.app'});}
  if(ruleCache.size>=8)ruleCache.delete(ruleCache.keys().next().value!);ruleCache.set(key,rules);return rules;
}
export function omitted(p:string,kinds:Omission[]=[]) {
  if(!kinds.length)return false;
  const value=p.toLowerCase();
  if(kinds.includes('hidden')&&/(?:^|\/)\.[^/]/.test(p))return true;
  if(kinds.includes('generated')&&/\.app\/contents(?:\/|$)/i.test(p))return true;
  if(kinds.includes('noise')&&noiseFilename(path.basename(p.replace(/\/$/,''))))return true;
  return omissionRules(kinds).some(r=>r.glob.startsWith('*/')?value.includes(r.glob.slice(1,-1)):value.startsWith(r.glob.slice(0,-1)));
}
