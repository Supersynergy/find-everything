import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {parseQuery} from '../src/engine';
import {queryMatcher,wordMatch} from '../src/query-match';

test('literal punctuation, Unicode, case and words agree across prepared and streaming search',()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fe-specials-'))),root=path.join(dir,'files'),data=path.join(dir,'data');fs.mkdirSync(root);fs.mkdirSync(data);
  const env={...process.env,FE_DATA_DIR:data,FE_CONFIG_DIR:path.join(dir,'config')};
  const run=(...args:string[])=>JSON.parse(execFileSync(process.execPath,[path.resolve('src/cli.ts'),...args,'--json'],{env,encoding:'utf8',timeout:20000}));
  const names=['a|b.txt','wow!.txt','star*.txt','(open.txt','close).txt','say"hi".txt','back\\slash.txt','[x]?.txt',"'quote.txt",'space ; # & = + %.txt','audio: doc: note.txt','emoji 🧪🚀.txt','upper-Ärger.txt','lower-ärger.txt','cafe\u0301.txt','report.txt','reporting.txt','report_2026.txt','report-final.txt','x𐐀x.txt','𐐀.txt','.hidden!.txt'];
  try{
    for(const name of names)fs.writeFileSync(path.join(root,name),'x');fs.mkdirSync(path.join(root,'MixedFolder'));fs.writeFileSync(path.join(root,'MixedFolder/unique.txt'),'x');run('index',root,'--name','demo','--exhaustive');
    const specials=['line\nbreak.txt','line\rbreak.txt','tab\tend.txt','control\x01end.txt'];
    const stat=fs.statSync(path.join(data,'index-demo.txt')),db=new Database(path.join(data,'live.sqlite'),{create:true});
    db.exec('CREATE TABLE scopes(name TEXT PRIMARY KEY,stamp TEXT,revision INTEGER,problem TEXT,pid INTEGER,lastChange TEXT);CREATE TABLE changes(scope TEXT,path TEXT,present INTEGER,tree INTEGER,revision INTEGER,PRIMARY KEY(scope,path));CREATE TABLE jobs(scope TEXT,path TEXT,failures INTEGER,retryAt REAL,PRIMARY KEY(scope,path));');
    db.query('INSERT INTO scopes VALUES(?,?,1,NULL,?,NULL)').run('demo',`${stat.mtimeMs}:${stat.size}`,process.pid);
    for(const n of specials){fs.writeFileSync(path.join(root,n),'x');db.query('INSERT INTO changes VALUES(?,?,1,0,1)').run('demo',path.join(root,n));}db.close();
    const queries=[...names.filter(n=>!['upper-Ärger.txt','lower-ärger.txt','cafe\u0301.txt'].includes(n)).map(n=>['literal:'+JSON.stringify(n)+' case:yes',[n]]),
      ...specials.map(n=>['literal:'+JSON.stringify(n),[n]]),
      ['Ärger case:no',['upper-Ärger.txt','lower-ärger.txt']],['Ärger case:yes',['upper-Ärger.txt']],['Ärger',['upper-Ärger.txt']],['café',['cafe\u0301.txt']],
      ['report word:yes',['report.txt','report-final.txt']],['name:report word:yes',['report.txt','report-final.txt']],['literal:"a|b"',['a|b.txt']],
      ['in:MixedFolder case:yes',['MixedFolder/unique.txt']],['in:mixedfolder case:yes',[]],['in:mixedfolder case:no',['MixedFolder/unique.txt']],['𐐀 word:yes',['𐐀.txt']],['report word:yes !final',['report.txt']]] as [string,string[]][];
    const compare=()=>{for(const [query,expected] of queries){const got=run('search',query+' view:all sort:name','--index','demo');assert.deepEqual(got.paths.slice().sort(),expected.map(n=>path.join(root,n)).sort(),query);}};
    run('prepare','--index','demo');compare();fs.unlinkSync(path.join(data,'search-demo.sqlite'));compare();
    const raw=run('search','--query','wow!.txt','--literal','--index','demo');assert.deepEqual(raw.paths,[path.join(root,'wow!.txt')]);
    const explain=run('explain','literal:"a|b" case:no word:yes view:all','--index','demo');assert.equal(explain.matching.case,'insensitive');assert.equal(explain.matching.wholeWord,true);assert.deepEqual(explain.visibility.omitted,[]);assert.equal(explain.matching.constraints[0].literal,'a|b');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
},30000);

test('invalid controls and mode values fail explicitly; Unicode word boundaries include combining marks',()=>{
  for(const q of ['literal:"\\u0000"','a\0b','case:maybe','word:maybe'])assert.throws(()=>parseQuery(q));
  assert.equal(wordMatch('foo\u0301','foo',false),false);
  assert.equal(wordMatch('𐐀word','word',false),false);
  assert.equal(queryMatcher(parseQuery('literal:"!|*("'))('/!|*('),true);
});
