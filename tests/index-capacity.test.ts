import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createIndexNormalizer,indexByteBudget,INDEX_FREE_RESERVE_BYTES} from '../src/engine';
import {searchByteBudget,SEARCH_DISK_LIMIT_BYTES} from '../src/path-search';
const GiB=1024**3;

test('path accounting can cross the observed 8-GiB boundary without allocating a large fixture',async()=>{
  const stats={count:59480394,bytes:8*GiB-4,skipped:0};let output='';
  await pipeline(Readable.from(['/Demo/final-file.pdf\0']),createIndexNormalizer(indexByteBudget(100*GiB),stats),new Writable({write(data,_encoding,done){output+=data.toString();done();}}));
  assert.equal(output,'/Demo/final-file.pdf\n');assert(stats.bytes>8*GiB);assert.equal(stats.count,59480395);
});

test('search preparation budgets include an existing checkpoint, a finite cap and a free-space reserve',()=>{
  assert.equal(SEARCH_DISK_LIMIT_BYTES,48*GiB);
  assert.equal(searchByteBudget(100*GiB),48*GiB);
  assert.equal(searchByteBudget(10*GiB),8*GiB);
  assert.equal(searchByteBudget(10*GiB,6*GiB),14*GiB);
  for(const free of [NaN,Infinity,-1,INDEX_FREE_RESERVE_BYTES])assert.throws(()=>searchByteBudget(free,8*GiB),/free disk space/);
  for(const existing of [-1,NaN,Infinity,1.5])assert.throws(()=>searchByteBudget(10*GiB,existing));
});
