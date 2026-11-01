/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const source=path.resolve('src/content-search.ts');
const engine=path.resolve('src/engine.ts');

function fixture(run:(root:string,cache:string)=>void) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fe-content-test-'));
  const cache=path.join(root,'cache');fs.mkdirSync(cache);
  try {run(root,cache);} finally {fs.rmSync(root,{recursive:true,force:true});}
}
function snapshot(cache:string,files:string[]) {fs.writeFileSync(path.join(cache,'index-documents.txt'),files.join('\n')+'\n');}
function evaluate(root:string,code:string) {
  const output=execFileSync(process.execPath,['-e',`const c=await import(${JSON.stringify(source)});const e=await import(${JSON.stringify(engine)});${code}`],{
    env:{...process.env,FE_DATA_DIR:path.join(root,'cache'),FE_CONFIG_DIR:path.join(root,'config')},encoding:'utf8',timeout:15000,
  });
  return JSON.parse(output);
}

// Construct a real, text-bearing PDF without installing a fixture generator.
function pdf(text:string,pages=1) {
  const stream=`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R ${Array.from({length:pages-1},(_,i)=>`${i+6} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  for(let i=1;i<pages;i++)objects.push(objects[2]);
  let body='%PDF-1.4\n';const offsets=[0];
  for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${object}\nendobj\n`;}
  const start=Buffer.byteLength(body);
  return body+`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

test('content search is opt-in and does not create a cache or index missing files',()=>fixture((root,cache)=>{
  const file=path.join(root,'report.txt');fs.writeFileSync(file,'confidential telescope');snapshot(cache,[file]);
  const result=evaluate(root,`const r=await c.searchContents('documents',{...e.parseQuery(''),content:'telescope'},20,0);console.log(JSON.stringify({r,created:require('fs').existsSync(c.contentPath('documents'))}));`);
  assert.deepEqual(result.r.paths,[]);assert.equal(result.r.complete,false);assert.equal(result.created,false);
  assert.match(result.r.warnings.join(' '),/content index|content.*index|index.*content/i);
}));

test('indexes document text rather than filenames, with literal phrase search',()=>fixture((root,cache)=>{
  const file=path.join(root,'unrelated-name.md');fs.writeFileSync(file,'A quarterly revenue report about the CAFÉ telescope.');snapshot(cache,[file]);
  const result=evaluate(root,`const indexed=await c.indexContents('documents',100,5);const r=await c.searchContents('documents',{...e.parseQuery(''),content:'cafe telescope'},20,0);console.log(JSON.stringify({indexed,r}));`);
  assert.equal(result.indexed.pending,0);assert.deepEqual(result.r.paths,[file]);assert.equal(result.r.coverage.matched,1);
  assert.match(result.r.snippets[0].text,/CAFÉ telescope/);
}));

test('content results respect filters, global sorting and pagination',()=>fixture((root,cache)=>{
  const names=['zeta.txt','beta.txt','alpha.txt','other.md'];
  const files=names.map(name=>{const file=path.join(root,name);fs.writeFileSync(file,'nebulous invoice');return file;});snapshot(cache,files);
  const result=evaluate(root,`await c.indexContents('documents',100,5);const pq={...e.parseQuery('ext:txt sort:name'),content:'nebulous'};const first=await c.searchContents('documents',pq,1,0);const second=await c.searchContents('documents',pq,1,1);console.log(JSON.stringify({first,second}));`);
  assert.deepEqual(result.first.paths,[files[2]]);assert.deepEqual(result.second.paths,[files[1]]);
  assert.equal(result.first.coverage.matched,3);assert.equal(result.first.nextOffset,1);
  assert.equal(result.first.snapshotId,result.second.snapshotId);
}));

test('name, size, favorites and exclusions also apply to document content',()=>fixture((root,cache)=>{
  const a=path.join(root,'alpha.txt'),b=path.join(root,'beta.txt');fs.writeFileSync(a,'orbit');fs.writeFileSync(b,'orbit orbit orbit');snapshot(cache,[a,b]);
  const result=evaluate(root,`await c.indexContents('documents',100,5);const query={...e.parseQuery('name:beta size:>10b'),content:'orbit',favorites:[${JSON.stringify(b)}]};const r=await c.searchContents('documents',query,20,0);const excluded=await c.searchContents('documents',{...e.parseQuery('!beta'),content:'orbit'},20,0);console.log(JSON.stringify({r,excluded}));`);
  assert.deepEqual(result.r.paths,[b]);assert.deepEqual(result.excluded.paths,[a]);
}));

test('indexing is bounded and resumes without rescanning directories',()=>fixture((root,cache)=>{
  const files=['a.txt','b.txt','c.txt'].map(name=>{const p=path.join(root,name);fs.writeFileSync(p,'resumable photon');return p;});snapshot(cache,files);
  fs.writeFileSync(path.join(root,'not-in-the-index.txt'),'resumable photon');
  const result=evaluate(root,`const rounds=[];for(let i=0;i<3;i++)rounds.push(await c.indexContents('documents',1,5));const r=await c.searchContents('documents',{...e.parseQuery('sort:name'),content:'photon'},20,0);console.log(JSON.stringify({rounds,r}));`);
  assert.ok(result.rounds.every((r:{processed:number})=>r.processed<=1));assert.equal(result.rounds.at(-1).pending,0);
  assert.deepEqual(result.r.paths,files);
}));

test('changed or deleted matching files are not returned as current content',()=>fixture((root,cache)=>{
  const file=path.join(root,'notes.txt');fs.writeFileSync(file,'original quasar');snapshot(cache,[file]);
  const result=evaluate(root,`await c.indexContents('documents',100,5);require('fs').writeFileSync(${JSON.stringify(file)},'replacement supernova that is longer');const stale=await c.searchContents('documents',{...e.parseQuery(''),content:'quasar'},20,0);await c.indexContents('documents',100,5);const updated=await c.searchContents('documents',{...e.parseQuery(''),content:'supernova'},20,0);require('fs').unlinkSync(${JSON.stringify(file)});const missing=await c.searchContents('documents',{...e.parseQuery(''),content:'supernova'},20,0);console.log(JSON.stringify({stale,updated,missing}));`);
  assert.deepEqual(result.stale.paths,[]);assert.equal(result.stale.complete,false);
  assert.deepEqual(result.updated.paths,[file]);assert.deepEqual(result.missing.paths,[]);
}));

test('a changed path snapshot fails closed until explicit content indexing resumes',()=>fixture((root,cache)=>{
  const a=path.join(root,'old.txt'),b=path.join(root,'new.txt');fs.writeFileSync(a,'private pulsar');fs.writeFileSync(b,'private pulsar');snapshot(cache,[a]);
  const result=evaluate(root,`await c.indexContents('documents',100,5);require('fs').writeFileSync(e.indexPathFor('documents'),${JSON.stringify(b+'\n')});const stale=await c.searchContents('documents',{...e.parseQuery(''),content:'pulsar'},20,0);await c.indexContents('documents',100,5);const updated=await c.searchContents('documents',{...e.parseQuery(''),content:'pulsar'},20,0);console.log(JSON.stringify({stale,updated}));`);
  assert.deepEqual(result.stale.paths,[]);assert.equal(result.stale.complete,false);assert.deepEqual(result.updated.paths,[b]);
}));

test('does not follow symlinks, read binary data, or silently truncate oversized text',()=>fixture((root,cache)=>{
  const secret=path.join(root,'secret.txt'),link=path.join(root,'link.txt'),binary=path.join(root,'binary.txt'),large=path.join(root,'large.txt');
  fs.writeFileSync(secret,'forbidden symlink phrase');fs.symlinkSync(secret,link);fs.writeFileSync(binary,Buffer.from('binary\0phrase'));fs.writeFileSync(large,'x'.repeat(2*1024*1024+1));snapshot(cache,[link,binary,large]);
  const result=evaluate(root,`const indexed=await c.indexContents('documents',100,5);const r=await c.searchContents('documents',{...e.parseQuery(''),content:'phrase'},20,0);console.log(JSON.stringify({indexed,r}));`);
  assert.deepEqual(result.r.paths,[]);assert.ok(result.indexed.skipped>=3);assert.equal(result.r.complete,false);
}));

test('FTS punctuation and operators are literal, not executable query syntax',()=>fixture((root,cache)=>{
  const a=path.join(root,'first.txt'),b=path.join(root,'second.txt');fs.writeFileSync(a,'alpha OR omega');fs.writeFileSync(b,'alpha alone');snapshot(cache,[a,b]);
  const result=evaluate(root,`await c.indexContents('documents',100,5);const r=await c.searchContents('documents',{...e.parseQuery(''),content:'alpha OR omega'},20,0);console.log(JSON.stringify(r));`);
  assert.deepEqual(result.paths,[a]);
}));

test('cached text has private file permissions and can be explicitly cleared',()=>fixture((root,cache)=>{
  const file=path.join(root,'notes.txt');fs.writeFileSync(file,'erase cached phrase');snapshot(cache,[file]);
  const result=evaluate(root,`await c.indexContents('documents',100,5);const mode=require('fs').statSync(c.contentPath('documents')).mode&0o777;const before=c.contentStatus('documents');await c.clearContents('documents');const after=c.contentStatus('documents');console.log(JSON.stringify({mode,before,after}));`);
  assert.equal(result.mode,0o600);assert.equal(result.before.indexed,1);assert.equal(result.after.indexed,0);assert.ok(fs.existsSync(file));
}));

test('PDF text extraction finds words absent from the filename',(t)=>fixture((root,cache)=>{
  if(!fs.existsSync('app/.build/fe-content-probe')&&!['/opt/homebrew/bin/pdftotext','/usr/local/bin/pdftotext','/usr/bin/pdftotext'].some(p=>fs.existsSync(p))) {t.skip('PDF extraction requires the built PDFKit helper or pdftotext');return;}
  const file=path.join(root,'report.pdf');fs.writeFileSync(file,pdf('portable ultraviolet telescope'));snapshot(cache,[file]);
  const result=evaluate(root,`const indexed=await c.indexContents('documents',100,5);const r=await c.searchContents('documents',{...e.parseQuery(''),content:'ultraviolet telescope'},20,0);console.log(JSON.stringify({indexed,r}));`);
  assert.equal(result.indexed.skipped,0);assert.deepEqual(result.r.paths,[file]);
}));

test('PDF fallback accepts 1000 pages but rejects 1001 without caching partial text',(t)=>fixture((root,cache)=>{
  const tool=['/opt/homebrew/bin/pdftotext','/usr/local/bin/pdftotext','/usr/bin/pdftotext'].find(p=>fs.existsSync(p)&&fs.existsSync(path.join(path.dirname(p),'pdfinfo')));
  if(!tool){t.skip('This real PDF fallback regression requires installed Poppler tools');return;}
  const allowed=path.join(root,'allowed.pdf'),oversized=path.join(root,'oversized.pdf');
  fs.writeFileSync(allowed,pdf('allowed boundary quartz',1000));fs.writeFileSync(oversized,pdf('forbidden boundary sapphire',1001));snapshot(cache,[allowed,oversized]);
  const result=evaluate(root,`process.env.FE_CONTENT_HELPER='';process.env.FE_PDFTOTEXT=${JSON.stringify(tool)};const indexed=await c.indexContents('documents',10,10);const allowed=await c.searchContents('documents',{...e.parseQuery(''),content:'quartz'},20,0);const rejected=await c.searchContents('documents',{...e.parseQuery(''),content:'sapphire'},20,0);console.log(JSON.stringify({indexed,allowed,rejected}));`);
  assert.deepEqual(result.allowed.paths,[allowed]);assert.deepEqual(result.rejected.paths,[]);assert.equal(result.indexed.indexed,1);assert.equal(result.indexed.skipped,1);assert.equal(result.rejected.coverage.unknown,1);
}));

test('PDF fallback does not invoke text extraction if page metadata cannot be verified',()=>fixture((root,cache)=>{
  const file=path.join(root,'report.pdf'),tool=path.join(root,'pdftotext'),marker=path.join(root,'unexpected-extraction');
  fs.writeFileSync(file,pdf('do not index uncontrolled pages'));snapshot(cache,[file]);
  fs.writeFileSync(tool,`#!/bin/sh\ncat >/dev/null\nprintf yes > ${JSON.stringify(marker)}\nprintf uncontrolled\n`,{mode:0o700});
  const result=evaluate(root,`process.env.FE_CONTENT_HELPER='';process.env.FE_PDFTOTEXT=${JSON.stringify(tool)};process.env.FE_PDFINFO='/does-not-exist/pdfinfo';const indexed=await c.indexContents('documents',10,5);console.log(JSON.stringify(indexed));`);
  assert.equal(result.indexed,0);assert.equal(result.skipped,1);assert.equal(fs.existsSync(marker),false);
}));

test('PDF fallback rejects malformed or ambiguous page counts before text extraction',()=>{
  for(const metadata of ['', 'Pages: unknown', 'Pages: 0', 'Pages: -1', 'Pages: 1.5', 'Pages: 9007199254740993', 'Pages: 1\nPages: 1001'])fixture((root,cache)=>{
    const file=path.join(root,'report.pdf'),probe=path.join(root,'pdfinfo'),tool=path.join(root,'pdftotext'),marker=path.join(root,'unexpected-extraction');
    fs.writeFileSync(file,pdf('do not index uncontrolled pages'));snapshot(cache,[file]);
    fs.writeFileSync(probe,`#!/bin/sh\ncat >/dev/null\nprintf ${JSON.stringify(metadata+'\n')}\n`,{mode:0o700});
    fs.writeFileSync(tool,`#!/bin/sh\ncat >/dev/null\nprintf yes > ${JSON.stringify(marker)}\nprintf uncontrolled\n`,{mode:0o700});
    const result=evaluate(root,`process.env.FE_CONTENT_HELPER='';process.env.FE_PDFTOTEXT=${JSON.stringify(tool)};process.env.FE_PDFINFO=${JSON.stringify(probe)};const indexed=await c.indexContents('documents',10,5);console.log(JSON.stringify(indexed));`);
    assert.equal(result.indexed,0,metadata);assert.equal(result.skipped,1,metadata);assert.equal(fs.existsSync(marker),false,metadata);
  });
});

test('content queries do not write caches and a missing PDF extractor is reported',()=>fixture((root,cache)=>{
  const a=path.join(root,'readme.txt'),b=path.join(root,'report.pdf');fs.writeFileSync(a,'stationary comet');fs.writeFileSync(b,pdf('portable comet'));snapshot(cache,[a,b]);
  const result=evaluate(root,`process.env.FE_CONTENT_HELPER='/does-not-exist/fe-content-probe';process.env.FE_PDFTOTEXT='/does-not-exist/pdftotext';const indexed=await c.indexContents('documents',100,5);const before=require('fs').readFileSync(c.contentPath('documents'));const r=await c.searchContents('documents',{...e.parseQuery(''),content:'comet'},20,0);const unchanged=before.equals(require('fs').readFileSync(c.contentPath('documents')));console.log(JSON.stringify({indexed,r,unchanged}));`);
  assert.equal(result.indexed.skipped,1);assert.equal(result.r.complete,false);assert.deepEqual(result.r.paths,[a]);assert.equal(result.unchanged,true);
}));

test('new contents in a previously nonmatching file cannot make a cached zero exhaustive',()=>fixture((root,cache)=>{
  const file=path.join(root,'changing.txt');fs.writeFileSync(file,'ordinary earlier contents');snapshot(cache,[file]);
  const result=evaluate(root,`await c.indexContents('documents',100,5);require('fs').writeFileSync(${JSON.stringify(file)},'brand new nebular observation');const r=await c.searchContents('documents',{...e.parseQuery(''),content:'nebular'},20,0);console.log(JSON.stringify(r));`);
  assert.deepEqual(result.paths,[]);assert.equal(result.complete,false);assert.match(result.warnings.join(' '),/cache|cached/i);
}));

test('macOS document extraction searches RTF body text through local textutil',(t)=>fixture((root,cache)=>{
  if(process.platform!=='darwin') {t.skip('Office/RTF extraction requires macOS textutil');return;}
  const file=path.join(root,'formatted.rtf');fs.writeFileSync(file,'{\\rtf1\\ansi A distant magnetar document.}');snapshot(cache,[file]);
  const result=evaluate(root,`await c.indexContents('documents',100,5);const r=await c.searchContents('documents',{...e.parseQuery(''),content:'magnetar'},20,0);console.log(JSON.stringify(r));`);
  assert.deepEqual(result.paths,[file]);
}));
