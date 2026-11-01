import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {relevanceOrder,relevanceScore,learningContext,withSmartView,withAllView} from '../src/search-ranking';
import {parseQuery} from '../src/engine';
import {decayedWeight,queryKey} from '../src/search-learning';

function fixture(){
  const dir=mkdtempSync(path.join(tmpdir(),'fe-ranking-')),root=path.join(dir,'files');mkdirSync(root);
  const env={...process.env,FE_DATA_DIR:path.join(dir,'cache'),FE_CONFIG_DIR:path.join(dir,'config'),FE_FAVORITES_FILE:path.join(dir,'pins.json'),FE_LEARNING_FILE:path.join(dir,'learning.json')};
  const exe=process.env.FE_TEST_CLI||process.execPath,prefix=process.env.FE_TEST_CLI?[]:[path.resolve('src/cli.ts')];
  const run=(...args:string[])=>JSON.parse(execFileSync(exe,[...prefix,...args,'--json'],{env,encoding:'utf8',timeout:30000}));
  const names=['report-z.md','report-a.mp4','report-b.wav','report-c.jpg','report.json','report.ts','report.log','.report.md','node_modules/report.md','dist/report.md','package-lock.json','thumbs.db','notes/report.txt','report/aaa.json','🦊.md','🦊.json',...Array.from({length:1600},(_,i)=>`report-${String(i).padStart(4,'0')}.json`)];
  const files=names.map(n=>path.join(root,n));
  for(const p of files.slice(0,16)){mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,'fixture');}
  run('index',root,'--name','demo');writeFileSync(path.join(env.FE_DATA_DIR,'index-demo.txt'),files.join('\n')+'\n');run('prepare','--index','demo');
  return {dir,root,files,env,run,search:(q:string,n=1000,offset=0)=>run('search',q,'--index','demo','-n',String(n),'--offset',String(offset)),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('smart ranking is global, human-first and reversible; explicit technical intent works and reads do not write',()=>{
  const f=fixture();try{
    const cache=path.join(f.env.FE_DATA_DIR,'search-demo.sqlite'),source=path.join(f.env.FE_DATA_DIR,'index-demo.txt');
    const before=[cache,source].map(p=>[statSync(p).mtimeMs,statSync(p).size]);
    const plain=f.search('sort:name'),smart=f.search('view:smart');
    assert.equal(smart.engine,'sqlite-trigram',JSON.stringify(smart.warnings));assert.equal(smart.coverage.matched,1610);
    assert.equal(f.search('files view:smart').coverage.matched,smart.coverage.matched,'path-wide matches still exclude filename noise before counting');
    const tail=f.search('view:smart',1000,1000);assert.equal(new Set([...smart.paths,...tail.paths]).size,1610);
    const alphabetical=[...plain.paths,...f.search('sort:name',1000,1000).paths];
    assert(smart.paths.slice(0,6).every((p:string)=>/\.(md|mp4|wav|jpg|txt)$/.test(p)),JSON.stringify(smart.paths.slice(0,6)));
    assert(smart.paths.includes(f.files[0]));assert(!smart.paths.slice(0,6).includes(f.files[4]));
    assert(!smart.paths.some((p:string)=>p.includes('/node_modules/')||p.includes('/dist/')||p.endsWith('.log')||path.basename(p).startsWith('.')));
    assert.deepEqual(f.search('report.log view:smart').paths,[f.files[6]]);
    assert.deepEqual(f.search('ext:log view:smart').paths,[f.files[6]]);
    assert.deepEqual(f.search('package-lock.json view:smart').paths,[f.files[10]]);
    assert.deepEqual(f.search('.report.md view:smart').paths,[f.files[7]]);
    for(const intent of ['type:hidden','is:hidden','kind:dot']){
      const found=f.search(intent+' view:smart omit:system;generated;hidden;noise');
      assert.equal(found.engine,'sqlite-trigram');assert.deepEqual(found.paths,[f.files[7]],intent);assert.equal(found.coverage.matched,1);
    }
    assert.equal(f.search('view:all',1).coverage.matched,f.files.length);
    assert.deepEqual(f.search('view:smart sort:name').paths,alphabetical.filter((p:string)=>!/(?:node_modules|dist)\//.test(p)&&!p.endsWith('.log')&&!path.basename(p).startsWith('.')&&!p.endsWith('package-lock.json')&&!p.endsWith('thumbs.db')).slice(0,1000));
    const q='report- view:smart',first=f.search(q,7);assert.equal(first.engine,'sqlite-trigram',JSON.stringify(first.warnings));let offset=0,all:string[]=[];
    do{const r=f.search(q,1000,offset);all.push(...r.paths);offset=r.nextOffset;}while(offset!==null);
    assert.equal(new Set(all).size,all.length);assert.equal(all.length,first.coverage.matched);assert.equal(first.paths[0],f.files[1]);
    assert.deepEqual([cache,source].map(p=>[statSync(p).mtimeMs,statSync(p).size]),before);
    assert.equal(f.run('learn','status').entries,0);assert.equal(f.search('🦊 view:smart').paths[0],f.files[14]);
    const sql=f.search('report- view:smart',1000).paths;renameSync(cache,cache+'.saved');
    const streaming=f.search('report- view:smart',1000);assert.equal(streaming.engine,'complete-stream');assert.deepEqual(streaming.paths,sql);
    assert.deepEqual(f.search('type:hidden view:smart').paths,[f.files[7]]);
    const baseline=[...f.search('report- sort:name').paths,...f.search('report- sort:name',1000,1000).paths];
    const beforeRank=baseline.findIndex((p:string)=>/\.(md|mp4|wav|jpg|txt)$/.test(p))+1;
    assert.equal(beforeRank,1601);assert.equal(first.paths[0],f.files[1]);
    console.log(JSON.stringify({fixture:'1600 JSON distractors; report- query',firstHumanBefore:beforeRank,firstHumanAfter:1,globalMatches:first.coverage.matched}));
  }finally{f.cleanup();}
});

test('successful selections learn locally across clients, remain query-scoped, decay, reset and honor opt-out and explicit sort',()=>{
  const f=fixture();try{
    const q='report- view:smart',selected=f.files[0],initial=f.search(q,5);
    assert.notEqual(initial.paths[0],selected);
    f.run('learn','open',selected,'--query','report-','--index','demo');
    const learned=f.search(q,5);assert.equal(learned.paths[0],selected);assert.notEqual(learned.snapshotId,initial.snapshotId);
    assert.notEqual(f.search('report view:smart',5).paths[0],selected,'a broader query does not inherit unrelated choices');
    assert.deepEqual(f.search(q+' learn:off',5).paths,initial.paths);
    assert.deepEqual(f.search(q+' sort:name',5).paths,f.search('report- view:all sort:name',5).paths);
    assert.equal(statSync(f.env.FE_LEARNING_FILE).mode&0o777,0o600);
    const stored=JSON.parse(readFileSync(f.env.FE_LEARNING_FILE,'utf8'));assert.match(stored.selections[0].key,/^[a-f0-9]{64}$/);assert(!readFileSync(f.env.FE_LEARNING_FILE,'utf8').includes('"query"'));
    const stamp=statSync(f.env.FE_LEARNING_FILE).mtimeMs;f.search(q);assert.equal(statSync(f.env.FE_LEARNING_FILE).mtimeMs,stamp);
    f.run('learn','disable');const disabled=readFileSync(f.env.FE_LEARNING_FILE,'utf8');f.run('learn','open',selected,'--query','report-','--index','demo');assert.equal(readFileSync(f.env.FE_LEARNING_FILE,'utf8'),disabled);assert.deepEqual(f.search(q,5).paths,initial.paths);
    f.run('learn','reset');assert.deepEqual(f.run('learn','status'),{enabled:false,entries:0});f.run('learn','enable');assert.deepEqual(f.search(q,5).paths,initial.paths);
    assert.equal(f.run('learn','open',selected,'--query','--literal','--index','demo').entries,1);
    writeFileSync(f.env.FE_LEARNING_FILE,'invalid');assert(f.search(q).warnings.some((w:string)=>w.includes('Local learning unavailable')));f.run('learn','reset');assert.deepEqual(f.run('learn','status'),{enabled:false,entries:0});
  }finally{f.cleanup();}
});

test('SQL and fallback use identical relevance tiers for Unicode, literals, alternation and bounded learning',()=>{
  const db=new Database(':memory:');db.exec('CREATE TABLE files(id INTEGER PRIMARY KEY,nameKey TEXT)');
  try{
    const names=['report.json','report.md','report-notes.md','aaa.json','🦊.json','🦊.md',"it's.md",'footsteps.wav'];
    for(let i=0;i<names.length;i++)db.query('INSERT INTO files VALUES (?,?)').run(i+1,names[i]);
    for(const query of ['report','report notes','🦊',"it's",'report|footsteps','']){
      const pq=parseQuery(query+' view:smart'),order=relevanceOrder(pq);
      const sql=db.query(`SELECT id FROM files f ORDER BY ${order.sql},f.nameKey,f.id`).all(...order.args).map(r=>r.id);
      const expected=names.map((name,i)=>({name,id:i+1,score:relevanceScore('/tmp/'+name,pq)})).sort((a,b)=>a.score-b.score||(a.name<b.name?-1:a.name>b.name?1:a.id-b.id)).map(r=>r.id);
      assert.deepEqual(sql,expected,query);
    }
    assert(relevanceScore('/tmp/report.md',parseQuery('report'))<relevanceScore('/tmp/report/aaa.json',parseQuery('report'),48));
    assert.equal(decayedWeight(8,0,30*86400000),4);assert.equal(queryKey(learningContext(parseQuery('report   notes')),'a'),queryKey(learningContext(parseQuery('report notes')),'a'));assert.notEqual(queryKey('in:/a  b','a'),queryKey('in:/a b','a'));assert.notEqual(queryKey('report','a'),queryKey('report','b'));
    assert.notEqual(learningContext(parseQuery('report in:downloads')),learningContext(parseQuery('report in:documents')));
    assert.equal(learningContext(parseQuery('report view:smart')),learningContext(parseQuery('report')));
    assert.equal(withSmartView('report view:all'),'report view:all');
    assert.equal(withSmartView('"literal view:all"'),'"literal view:all" view:smart');
    assert.equal(withAllView('"literal view:smart" view:working'),'"literal view:smart" view:all');
  }finally{db.close();}
});
