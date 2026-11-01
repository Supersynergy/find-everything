/// <reference types="node" />
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeQuery} from '../src/smart-query';

const read=(file:string)=>readFileSync(path.resolve(file),'utf8');
interface PresentationFixture {root:string;query:string;paths:string[];candidates:string[]}
const fixture=():PresentationFixture=>JSON.parse(read('tests/native/presentation-fixture.json'));

test('product screenshots demonstrate filename matches across unrelated folders, not a matching parent',()=>{
  const f=fixture();
  assert.equal(f.query,'name:invoice ext:pdf !draft');
  assert.equal(f.paths.length,6);
  assert(new Set(f.paths.map(p=>path.dirname(p))).size>=3);
  for(const p of f.paths){
    assert.match(path.basename(p),/invoice/i);
    assert.equal(path.extname(p),'.pdf');
    assert.doesNotMatch(p,/draft/i);
    assert.doesNotMatch(path.dirname(p),/invoice/i);
    assert(f.candidates.includes(p));
  }
  assert(f.candidates.some(p=>/invoice/i.test(path.dirname(p))&&!/invoice/i.test(path.basename(p))),'Include a folder-only distractor');
  assert(f.candidates.some(p=>/draft/i.test(p)),'Include an excluded draft');
  assert(f.candidates.some(p=>path.extname(p)!=='.pdf'),'Include an excluded file type');
  const renderer=read('tests/native/release-preview.swift');
  assert.match(renderer,/JSONDecoder/);
  assert.match(renderer,/presentation-fixture\.json/);
  assert.match(renderer,/total: fixture\.paths\.count/);
  assert.doesNotMatch(renderer,/query: "design"/);
});

test('the production search backend returns exactly the illustrated filename-filter results',()=>{
  const f=fixture(),dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-presentation-'))),root=path.join(dir,'files');
  mkdirSync(root);
  const env={...process.env,FE_CONFIG_DIR:path.join(dir,'config'),FE_DATA_DIR:path.join(dir,'cache'),FE_FAVORITES_FILE:path.join(dir,'pins.json'),FE_LEARNING_FILE:path.join(dir,'learning.json')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  const local=(p:string)=>path.join(root,path.relative(f.root,p));
  const displayed=(p:string)=>f.root+'/'+path.relative(root,p).split(path.sep).join('/');
  try {
    for(const p of f.candidates){mkdirSync(path.dirname(local(p)),{recursive:true});writeFileSync(local(p),'Synthetic filename-search fixture; no document-content claim.');}
    run('index',root,'--name','presentation','--preset','folder');
    const result=run('search',f.query,'--index','presentation');
    assert.equal(result.complete,true);
    assert.equal(result.coverage.matched,f.paths.length);
    assert.deepEqual(result.paths.map(displayed).sort(),[...f.paths].sort());
    const broad=run('search',f.query.replace('name:invoice','invoice'),'--index','presentation');
    assert(broad.paths.some((p:string)=>/invoice/i.test(path.dirname(displayed(p)))&&!/invoice/i.test(path.basename(p))),'The explicit name filter, not a lucky fixture, removes folder-only matches');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('feature presentation separates supported capabilities, setup and limitations',()=>{
  const readme=read('README.md'),features=read('docs/FEATURES.md'),research=read('docs/release/README-RESEARCH.md');
  for(const token of ['name:invoice ext:pdf !draft','duration:<1s','favorites:true','MCP','not notarized'])assert(readme.includes(token),`Missing README evidence: ${token}`);
  assert.doesNotMatch(readme,/optional content search/i);
  assert.match(features,/content search|full.text/i);
  assert.match(features,/not bundled/i);
  assert.match(features,/saved searches/i);
  assert.match(features,/learning|learned/i);
  assert.match(readme,/synthetic/i);
  assert.match(readme,/feature-map\.svg/);
  for(const match of readme.matchAll(/!\[[^\]]*\]\((\.\/docs\/[^)]+)\)/g))assert(existsSync(path.resolve(match[1])),`Missing image: ${match[1]}`);
  for(const file of ['README.md','docs/FEATURES.md','docs/release/README-RESEARCH.md']){
    for(const match of read(file).matchAll(/\[[^\]]*\]\((?!https?:|#)([^)]+)\)/g)){
      const target=match[1].split('#')[0];
      if(target)assert(existsSync(path.resolve(path.dirname(file),target)),`Broken local link in ${file}: ${target}`);
    }
  }
  for(const repo of ['Canop/broot','junegunn/fzf','sxyazi/yazi','yorukot/superfile','localsend/localsend'])assert(research.includes('https://github.com/'+repo));
});

test('the natural-language examples advertised in the feature presentation use the real parser',()=>{
  assert.equal(normalizeQuery('(PDFs größer als 10 MB)'),'ext:pdf size:>10m');
  assert.equal(normalizeQuery('(Dateien aus den letzten 7 Tagen)'),'dm:7d');
  assert.equal(normalizeQuery('alle meine sounds die unter 1 sekunde gehen'),'type:audio duration:<1s');
  assert.match(normalizeQuery('(kurze düstere Lasersounds)'),/sound:/);
});
