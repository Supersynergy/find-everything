import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
test('instantfind regression suite uses an isolated process and private fixtures',()=>{
  const result=spawnSync(process.execPath,['test',path.resolve('tests/fixtures/instantfind/unit.test.ts')],{encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
  if(result.status!==0)throw new Error(result.stderr||result.stdout||String(result.error));
  expect(result.status).toBe(0);
});
