import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {SearchCache} from '../src/search-cache';
import {SearchProcess,searchedCacheKey,type SearchWork} from '../src/search-process';

test('response cache bounds entry/key/total bytes, recency and age',()=>{
  let now=0;const cache=new SearchCache<string>(30,2,30,100,()=>now);
  cache.set('one','1234');cache.set('two','5678');assert.equal(cache.get('one'),'1234');
  cache.set('three','9012');assert.equal(cache.get('two'),undefined);assert.equal(cache.get('one'),'1234');
  cache.set('oversize','x'.repeat(31));assert.equal(cache.get('oversize'),undefined);
  cache.set('k'.repeat(31),'x');assert.equal(cache.get('k'.repeat(31)),undefined);
  now=99;assert.equal(cache.get('one'),'1234');now=100;assert.equal(cache.get('one'),undefined);
  const large=new SearchCache<{paths:string[]}>();
  const page={paths:Array.from({length:1000},(_,i)=>'/fixture/'+i+'x'.repeat(300))};
  large.set('large-page',page);assert.deepEqual(large.get('large-page'),page);
  const bytes=new SearchCache<string>(20,10,20);
  bytes.set('a','123456');bytes.set('b','123456');bytes.set('c','123456');
  assert.equal(bytes.get('a'),undefined);assert.equal(bytes.get('b'),'123456');assert.equal(bytes.get('c'),'123456');
});

const program=String.raw`
 import {createInterface} from 'node:readline';let execution=0;
 for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line);execution++;process.stderr.write('computing\n');
  await new Promise(resolve=>setTimeout(resolve,120));
  console.log(JSON.stringify({id:request.id,data:{paths:[request.query],execution,phase:request.phase??'exact'}}));
 }`;
const work=(client:string,generation=1,phase?:string,priority='foreground'):SearchWork=>({query:'same',index:'demo',limit:10,offset:0,client,generation,phase,priority});
function fixture(prepare:()=>void=()=>{},keyFor:(w:SearchWork)=>string=w=>JSON.stringify([w.query,w.index,w.limit,w.offset,w.phase])){
  let computing:()=>void=()=>{};
  const reader=new SearchProcess(()=>{
    const child=spawn(process.execPath,['--eval',program],{detached:true,stdio:['pipe','pipe','pipe']});
    child.stderr!.on('data',d=>{if(d.toString().includes('computing'))computing();});return child;
  },prepare,keyFor);
  return {reader,started:()=>new Promise<void>(resolve=>{computing=resolve})};
}

test('identical callers join the actual prepared revision and execute once',async()=>{
  let revision='before';const {reader,started}=fixture(()=>{revision='after';},()=>revision);
  try{
    const computing=started(),a=reader.search(work('client-one'),new AbortController().signal);await computing;
    const b=reader.search(work('client-two'),new AbortController().signal),[first,second]=await Promise.all([a,b]);
    assert.deepEqual(first.paths,['same']);assert.equal(first.execution,1);assert.equal(second.execution,1);
    assert.equal(first[searchedCacheKey],'after');assert(!JSON.stringify(first).includes('searchedCacheKey'));
    assert.equal(reader.status().completed,1);assert.equal(reader.status().starts,1);
  }finally{reader.close();}
});

test('a new generation detaches only its own caller from shared work',async()=>{
  const {reader,started}=fixture();
  try{
    const computing=started(),old=reader.search(work('client-one'),new AbortController().signal).catch(e=>e);await computing;
    const independent=reader.search(work('client-two'),new AbortController().signal),pid=reader.status().pid;
    const latest=reader.search({...work('client-one',2),query:'latest'},new AbortController().signal);
    assert.equal((await old).code,'SEARCH_CANCELED');assert.equal(reader.status().pid,pid);
    assert.deepEqual((await independent).paths,['same']);assert.deepEqual((await latest).paths,['latest']);
    assert.equal(reader.status().starts,1);assert.equal(reader.status().completed,2);assert.equal(reader.status().canceled,0);
  }finally{reader.close();}
});

test('disconnect and foreground prefetch cancellation preserve independent subscribers',async()=>{
  const {reader,started}=fixture();
  try{
    const cancel=new AbortController(),computing=started();
    const a=reader.search(work('client-one',1,undefined,'prefetch'),cancel.signal).catch(e=>e);await computing;
    const b=reader.search(work('client-two'),new AbortController().signal),foreground=reader.search(work('client-one'),new AbortController().signal);
    assert.equal((await a).code,'SEARCH_CANCELED');cancel.abort();
    assert.equal((await b).execution,1);assert.equal((await foreground).execution,1);assert.equal(reader.status().completed,1);
    const computing2=started(),disconnect=new AbortController();
    const c=reader.search({...work('client-one',2),query:'next'},disconnect.signal).catch(e=>e);await computing2;
    const d=reader.search({...work('client-two',2),query:'next'},new AbortController().signal);disconnect.abort();
    assert.equal((await c).code,'SEARCH_CANCELED');assert.equal((await d).execution,2);assert.equal(reader.status().starts,1);
  }finally{reader.close();}
});

test('preview and exact requests remain separate jobs',async()=>{
  const {reader}=fixture();
  try{
    const [preview,exact]=await Promise.all([
      reader.search(work('client-one',1,'preview'),new AbortController().signal),
      reader.search(work('client-two'),new AbortController().signal)]);
    assert.equal(preview.phase,'preview');assert.equal(exact.phase,'exact');assert.equal(reader.status().completed,2);
  }finally{reader.close();}
});
