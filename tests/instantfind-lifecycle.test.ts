import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SearchProcess} from '../src/search-process';

const program=`import{createInterface}from'node:readline';for await(const l of createInterface({input:process.stdin})){const r=JSON.parse(l);console.log(JSON.stringify({id:r.id,data:r.query==='meaning:empty'?{instantfind:true,paths:[]}:r.query.startsWith('meaning:')?{instantfind:true,runtime:{pid:123},paths:['x']}:{paths:['x']}}));}`;

test('successful document use removes idle retirement; plain/empty readers still retire and close reaps the child',async()=>{
 const old=setTimeout,scheduled:(()=>void)[]=[];
 globalThis.setTimeout=((cb:any,ms?:number,...args:any[])=>{if(ms===600000){scheduled.push(cb);return old(()=>{},3600000);}return old(cb,ms,...args);}) as typeof setTimeout;
 const children:ReturnType<typeof spawn>[]=[];
 const reader=new SearchProcess(()=>{const p=spawn(process.execPath,['--eval',program],{detached:true,stdio:['pipe','pipe','pipe']});children.push(p);return p;});
 const query=(q:string)=>reader.search({query:q,index:'test',limit:1,offset:0},new AbortController().signal);
 try{
  await query('meaning:empty');assert.equal(reader.status().residentMeaning,false);assert.equal(scheduled.length,1);
  const closed=once(children[0],'close');scheduled[0]();await closed;
  await query('meaning:used');assert.equal(reader.status().residentMeaning,true);assert.equal(scheduled.length,1);
  const pid=reader.status().pid;await query('ordinary');assert.equal(reader.status().pid,pid);assert.equal(scheduled.length,1);
  const stopped=once(children[1],'close');reader.close();await stopped;assert.equal(reader.status().pid,null);
 }finally{reader.close();globalThis.setTimeout=old;}
});

test('compact tokenizer preserves merge priorities, special tokens, byte fallback and truncation with bounded caches',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fe-tokenizer-'));
 try{
  const vocab:Record<string,number>={'<pad>':0,'<eos>':1,'<bos>':2,'a':3,'b':4,'c':5,'ab':6,'bc':7,'▁':8};
  for(let n=0;n<256;n++)vocab[`<0x${n.toString(16).toUpperCase().padStart(2,'0')}>`]=9+n;
  writeFileSync(path.join(dir,'tokenizer.json'),JSON.stringify({model:{type:'BPE',ignore_merges:false,byte_fallback:true,vocab,merges:[['b','c'],['a','b']]},normalizer:{type:'Replace',pattern:{String:' '},content:'▁'},pre_tokenizer:{type:'Split',pattern:{String:' '},behavior:'MergedWithPrevious',invert:false},added_tokens:[{id:2,content:'<bos>',single_word:false,lstrip:false,rstrip:false,normalized:false}]}));
  const helper=path.resolve('runtime/instantfind');
  const script=`import sys,json,os;sys.path.insert(0,sys.argv[1]);from compact_tokenizer import prepare,CompactTokenizer;d=sys.argv[2];prepare(d+'/tokenizer.json',d+'/tokenizer.sqlite');t=CompactTokenizer(d+'/tokenizer.sqlite');assert t.encode('abc')==[2,3,7,1];assert t.encode('a b')==[2,3,8,4,1];assert t.encode('<bos>ab')==[2,2,6,1];assert t.encode('é')==[2,204,178,1];assert len(t.encode('c'*500))==256;assert t.merge.cache_info().maxsize==16384;assert t.token.cache_info().maxsize==4096;print('passed')`;
  const result=spawnSync('python3',['-c',script,helper,dir],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'passed');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
