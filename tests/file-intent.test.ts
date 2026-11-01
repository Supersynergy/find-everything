import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeQuery} from '../src/smart-query';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,rmSync,utimesSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Database} from 'bun:sqlite';

// Human-written expected filters, separate from the translator implementation.
const development=[
 ['(PDFs größer als 10 MB)','ext:pdf size:>10m'],
 ['(Bilder unter 2 MB)','type:image size:<2m'],
 ['(Dateien aus den letzten 7 Tagen)','dm:7d'],
 ['(Videos in Downloads)','type:video in:"~/Downloads"'],
 ['(favorisierte PDFs mindestens 1,5 MB)','ext:pdf favorites:true size:>=1.5m'],
 ['(Dokumente neueste zuerst)','type:doc sort:new'],
 ['(PDFs im Ordner "/Users/me/Project (copy)")','ext:pdf in:"/Users/me/Project (copy)"'],
 ['(Dateien mit Namen "Q4 Bericht")','name:"Q4 Bericht"'],
];
const validation=[
 ['(images smaller than 500 KB)','type:image size:<500k'],
 ['(files from the last 14 days)','dm:14d'],
 ['(PDFs höchstens 20 MB größte zuerst)','ext:pdf size:<=20m sort:big'],
 ['(Archive über 1 GB)','type:zip size:>1g'],
 ['(meine favorisierten Bilder in Bilder)','type:image favorites:true in:"~/Pictures"'],
 ['(Rechnungen als PDFs)','ext:pdf "rechnungen"'],
 ['(files named "Q4 report") ext:pdf','name:"Q4 report" ext:pdf'],
 ['"folder (copy)" (PDFs kleiner als 5 MB)','"folder (copy)" ext:pdf size:<5m'],
];
for(const [name,cases] of [['development',development],['validation',validation]] as const)test('local file intent golden set: '+name,()=>{
 for(const [input,expected]of cases)assert.equal(normalizeQuery(input),expected,input);
});
test('ambiguous or malformed file clauses cannot introduce query operators',()=>{
 for(const q of ['(PDFs größer als 10 elephants)','(Bilder und Videos)','(Dateien favorites:true)','(PDFs im Ordner "relative")','(PDFs (neu))'])assert.throws(()=>normalizeQuery(q),q);
 assert.equal(normalizeQuery('(kurze düstere Lasersounds)'),'type:audio duration:<1s sound:"dark eerie laser sound effect"');
 assert.equal(normalizeQuery('PDFs größer als 10 MB'),'PDFs größer als 10 MB','normal filename text stays literal');
});

test('natural clauses use real indexed properties, folder boundaries and favorites without changing the index',()=>{
 const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'fe-file-intent-'))),root=path.join(dir,'files'),folder=path.join(root,'Project (copy)'),sibling=folder+'-other';
 mkdirSync(folder,{recursive:true});mkdirSync(sibling);
 const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config'),FE_FAVORITES_FILE:path.join(dir,'pins.json')};
 const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
 const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:10000}));
 try{
  for(const [name,size]of [['invoice.pdf',24],['old.pdf',12],['Q4 Bericht.pdf',16],['image.png',4]] as const)writeFileSync(path.join(folder,name),'x'.repeat(size));
  writeFileSync(path.join(sibling,'invoice.pdf'),'other');
  const old=new Date(Date.now()-30*86400000);utimesSync(path.join(folder,'old.pdf'),old,old);
  run('index',root,'--name','demo');run('prepare','--index','demo');run('properties','--index','demo');run('favorites','add',path.join(folder,'invoice.pdf'));
  const database=path.join(env.FE_DATA_DIR,'search-demo.sqlite'),db=new Database(database);db.exec("UPDATE files SET size=NULL WHERE name='old.pdf'");db.close();
  const files=[database,path.join(env.FE_DATA_DIR,'index-demo.txt')],before=files.map(f=>[statSync(f).size,statSync(f).mtimeMs]);
  for(const [natural,explicit]of [
   ['(PDFs größer als 10 Bytes)','ext:pdf size:>10b'],
   ['(PDFs aus den letzten 7 Tagen)','ext:pdf dm:7d'],
   ['(favorisierte PDFs mindestens 10 Bytes)','ext:pdf favorites:true size:>=10b'],
   [`(PDFs im Ordner ${JSON.stringify(folder+'/')})`,`ext:pdf in:${JSON.stringify(folder+'/')}`],
   ['(Dateien mit Namen "Q4 Bericht")','name:"Q4 Bericht"'],
  ]){
   const a=run('search',natural,'--index','demo'),b=run('search',explicit,'--index','demo');assert.deepEqual(a.paths,b.paths,natural);assert.deepEqual(a.coverage,b.coverage,natural);assert(a.paths.length>0,natural);
  }
  const size=run('search','(PDFs größer als 10 Bytes)','--index','demo');assert(!size.paths.some(p=>p.endsWith('/old.pdf')));assert.equal(size.coverage.metadataUnknown,1);
  const scoped=run('search',`(PDFs im Ordner ${JSON.stringify(folder+'/')})`,'--index','demo');assert(scoped.paths.every(p=>p.startsWith(folder+'/')));
  assert.deepEqual(files.map(f=>[statSync(f).size,statSync(f).mtimeMs]),before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
