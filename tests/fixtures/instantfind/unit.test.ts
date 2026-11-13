import {test,expect,afterAll} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'fe-meaning-'));
process.env.FE_DATA_DIR=path.join(root,'cache');process.env.FE_CONFIG_DIR=path.join(root,'config');
process.env.FE_INSTANTFIND_RUNTIME=path.join(root,'runtime');process.env.FE_FAVORITES_FILE=path.join(root,'favorites.json');
fs.mkdirSync(process.env.FE_DATA_DIR,{recursive:true});
const engine=await import('../../../src/engine');
const content=await import('../../../src/content-search');
const meaning=await import('../../../src/instantfind');
const runtime=await import('../../../src/instantfind-worker');
let counter=0,calls=0;
const encoder:import('../../../src/instantfind-worker').DocumentEncoder={async encode(texts){calls++;
  return {vectors:texts.map(text=>{const v=Array(768).fill(0);v[text.toLowerCase().includes('invoice')?1:0]=1;return v;}),pid:1,setupMs:0,peakRssMiB:1};}};
async function fixture(entries:Record<string,string>){
  const index='case-'+(++counter),folder=path.join(root,index);fs.mkdirSync(folder);
  const files=Object.entries(entries).map(([name,text])=>{const p=path.join(folder,name);fs.writeFileSync(p,text);return p;});
  fs.writeFileSync(engine.indexPathFor(index),files.join('\n')+'\n');
  await content.indexContents(index,100,5);return {index,files};
}
afterAll(()=>{runtime.instantEncoder.close();fs.rmSync(root,{recursive:true,force:true});});
test('meaning grammar is explicit and validates empty or repeated descriptions',()=>{
  const parsed=engine.parseQuery('meaning:"restore a failed release" ext:md');
  expect(parsed.meaning).toBe('restore a failed release');expect(parsed.content).toBeUndefined();
  expect(()=>engine.parseQuery('meaning:')).toThrow();
  expect(()=>engine.parseQuery('meaning:"one" meaning:"two"')).toThrow();
});
test('missing meaning index returns preparation instructions without a model call',async()=>{
  const before=calls,r=await meaning.searchMeaning('missing',engine.parseQuery('meaning:"invoice"'),20,0,encoder);
  expect(r.paths).toEqual([]);expect(calls).toBe(before);expect(r.warnings[0]).toContain('Prepare');
});
test('builds from cached text, reuses vectors, ranks and deduplicates documents',async()=>{
  const f=await fixture({'recovery.md':'recovery '.repeat(600),'invoice.md':'invoice payment reference'});
  const first=await meaning.indexMeaning(f.index,100,5,encoder);
  expect(first.encoded).toBeGreaterThan(0);
  const second=await meaning.indexMeaning(f.index,100,5,encoder);expect(second.encoded).toBe(0);
  const r=await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"invoice"'),20,0,encoder);
  expect(r.paths[0]).toBe(f.files[1]);expect(new Set(r.paths).size).toBe(2);expect(r.complete).toBe(false);
});
test('extension, name, favorites and pagination remain hard constraints',async()=>{
  const f=await fixture({'one.md':'invoice first','two.txt':'invoice second','three.md':'invoice third'});
  await meaning.indexMeaning(f.index,100,5,encoder);
  const r=await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"invoice" ext:md'),1,0,encoder);
  expect(r.paths.length).toBe(1);expect(r.paths[0].endsWith('.md')).toBe(true);expect(r.nextOffset).toBe(1);
  const next=await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"invoice" ext:md'),1,1,encoder);
  expect(next.paths[0]).not.toBe(r.paths[0]);
  const q=engine.parseQuery('meaning:"invoice" name:three');q.favorites=[f.files[2]];
  expect((await meaning.searchMeaning(f.index,q,20,0,encoder)).paths).toEqual([f.files[2]]);
  q.favorites=[];expect((await meaning.searchMeaning(f.index,q,20,0,encoder)).paths).toEqual([]);
});
test('changed and deleted files cannot escape the cached version checks',async()=>{
  const f=await fixture({'one.md':'invoice original','two.md':'invoice other'});
  await meaning.indexMeaning(f.index,100,5,encoder);
  fs.writeFileSync(f.files[0],'changed document text');fs.utimesSync(f.files[0],new Date(),new Date(Date.now()+5000));fs.unlinkSync(f.files[1]);
  expect((await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"invoice"'),20,0,encoder)).paths).toEqual([]);
});
test('a file modified while encoding is excluded before output',async()=>{
  const f=await fixture({'one.md':'invoice original'});await meaning.indexMeaning(f.index,100,5,encoder);
  const changing={async encode(texts:string[],kind:'query'|'document'){
    fs.writeFileSync(f.files[0],'modified during encoding');fs.utimesSync(f.files[0],new Date(),new Date(Date.now()+5000));
    return encoder.encode(texts,kind);
  }};
  expect((await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"invoice"'),20,0,changing)).paths).toEqual([]);
});
test('malformed encoder output preserves the last complete index',async()=>{
  const f=await fixture({'one.md':'invoice original'});await meaning.indexMeaning(f.index,100,5,encoder);
  const previous=fs.readFileSync(meaning.meaningPath(f.index));
  fs.writeFileSync(f.files[0],'different invoice text');await content.indexContents(f.index,100,5);
  const broken={async encode(){return {vectors:[[1]],pid:1,setupMs:0,peakRssMiB:1};}};
  await expect(meaning.indexMeaning(f.index,100,5,broken)).rejects.toThrow('Invalid embedding');
  expect(fs.readFileSync(meaning.meaningPath(f.index)).equals(previous)).toBe(true);
  expect(meaning.meaningStatus(f.index).ready).toBe(false);
});
test('budgeted builds checkpoint without exposing a partial index and resume without re-encoding',async()=>{
  const f=await fixture({'one.md':'invoice one','two.md':'invoice two','three.md':'invoice three'});
  let encoded=0;
  const slow={async encode(texts:string[],kind:'query'|'document'){
    encoded+=texts.length;await new Promise(resolve=>setTimeout(resolve,80));return encoder.encode(texts,kind);
  }};
  const first=await meaning.indexMeaning(f.index,100,.05,slow);
  expect(first.pending).toBe(true);expect(first.encoded).toBe(1);expect(fs.existsSync(meaning.meaningPath(f.index))).toBe(false);
  const second=await meaning.indexMeaning(f.index,100,5,slow);
  expect(second.pending).toBe(false);expect(second.documents).toBe(3);expect(encoded).toBe(3);
});
test('semantic index is private and reports a bounded subset',async()=>{
  const f=await fixture({'one.md':'first','two.md':'second'});await meaning.indexMeaning(f.index,1,5,encoder);
  expect(meaning.meaningStatus(f.index).limited).toBe(true);
  expect(fs.statSync(meaning.meaningPath(f.index)).mode&0o777).toBe(0o600);
  fs.chmodSync(meaning.meaningPath(f.index),0o644);
  await expect(meaning.searchMeaning(f.index,engine.parseQuery('meaning:"first"'),20,0,encoder)).rejects.toThrow('Unsafe');
});
test('conflicting backends are rejected rather than silently dropping constraints',async()=>{
  await expect(meaning.searchMeaning('missing',engine.parseQuery('meaning:"one" content:"two"'),20,0,encoder)).rejects.toThrow('cannot be combined');
});

test('query-focused passages expose late content without weakening filters',async()=>{
  const f=await fixture({'a.md':'ordinary introduction '.repeat(400),'z.md':'ordinary introduction '.repeat(400)+' unique-late-anchor'});
  const passages=content.meaningPassages(f.index,'unique-late-anchor',new Set(f.files));expect(passages.passages.find(p=>p.path===f.files[1])?.text).toContain('unique-late-anchor');
  const focused={async encode(texts:string[]){return {vectors:texts.map(text=>{const v=Array(768).fill(0);v[text.includes('unique-late-anchor')?1:0]=1;return v;}),pid:1,setupMs:0,peakRssMiB:1};}};
  await meaning.indexMeaning(f.index,100,5,focused);
  const result=await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"unique-late-anchor"'),20,0,focused);
  expect(result.paths[0]).toBe(f.files[1]);expect(result.snippets[0].text).toContain('unique-late-anchor');
  const filtered=await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"unique-late-anchor" name:a.md'),20,0,focused);
  expect(filtered.paths).toEqual([f.files[0]]);
  const moving={async encode(texts:string[],kind:'query'|'document'|'passage'){const r=await focused.encode(texts);return {...r,identity:kind==='query'?'before':'after'};}};
  const changed=await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"unique-late-anchor"'),20,0,moving);
  expect(changed.paths).toEqual([]);expect(changed.warnings[0]).toContain('runtime changed');
});
test('confident rare-word evidence resolves a tie while ordinary words keep semantic order',async()=>{
  const entries:Record<string,string>={};for(let i=0;i<99;i++)entries[String(i).padStart(3,'0')+'.md']='routine note';entries['z.md']='quartz saxophone hydrangea nebula';
  const f=await fixture(entries);await meaning.indexMeaning(f.index,100,5,encoder);
  const result=await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"quartz saxophone hydrangea nebula"'),20,0,encoder);
  expect(result.paths[0]).toBe(f.files.at(-1)!);expect('scores' in result&&result.scores[0].similarity).toBe(1);
  expect((await meaning.searchMeaning(f.index,engine.parseQuery('meaning:"routine"'),20,0,encoder)).paths[0]).toBe(f.files[0]);
});
