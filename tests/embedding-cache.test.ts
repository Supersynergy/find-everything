import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {EmbeddingCache} from '../src/embedding-cache';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

test('vector LRU bounds entries and bytes, owns payloads and rejects invalid vectors',()=>{
  const cache=new EmbeddingCache(2,6500),vector=Array(768).fill(0);vector[0]=1;
  cache.set('one',vector);vector[0]=9;assert.equal(cache.get('one')![0],1);
  const copy=cache.get('one')!;copy[0]=8;assert.equal(cache.get('one')![0],1);
  cache.set('two',vector);cache.get('one');cache.set('three',vector);
  assert.equal(cache.get('two'),undefined);assert.equal(cache.size,2);assert(cache.bytes<=6500);
  cache.set('bad',[1]);cache.set('nan',Array(768).fill(NaN));cache.set('overflow',Array(768).fill(1e300));assert.equal(cache.size,2);
  cache.clear();assert.equal(cache.size,0);assert.equal(cache.bytes,0);
  const bounded=new EmbeddingCache();for(let i=0;i<900;i++)bounded.set(String(i),vector);
  assert.equal(bounded.size,512);assert(bounded.bytes<=2*1024*1024);
});
test('production worker reuses exact passages and invalidates cache on runtime changes',()=>{
  const r=spawnSync(process.execPath,['test',path.resolve('tests/fixtures/passage-cache/worker.test.ts')],{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stdout+r.stderr);
});
