import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Database } from 'bun:sqlite';
import { membershipRepairWriter } from '../src/reconcile-files';

test('repair rechecks disk, fences newer exact and ancestor changes, preserves warnings and queues media', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'fe-repair-'));
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE scopes(name PRIMARY KEY,stamp,revision,problem,lastChange);
      CREATE TABLE changes(scope,path,present,tree,revision,PRIMARY KEY(scope,path));
      CREATE TABLE jobs(scope,path,failures DEFAULT 0,retryAt DEFAULT 0,PRIMARY KEY(scope,path));
      INSERT INTO scopes VALUES ('everything','v1',10,'access incomplete',NULL)`);
    const p = (name:string) => path.join(dir,name);
    const put = db.query('INSERT INTO changes VALUES (?,?,?,?,?)');
    fs.writeFileSync(p('new\ntrack.mp3'),'new'); fs.writeFileSync(p('recreated'),'live');
    put.run('everything',p('old-tree'),0,1,4);
    put.run('everything',p('new-tree'),0,1,9);
    put.run('everything',p('touched'),0,0,10);
    const repair = membershipRepairWriter(db,{index:'everything',stamp:'v1',revision:8},true);
    const records = repair([
      {path:p('new\ntrack.mp3'),present:true},{path:p('gone'),present:false},
      {path:p('recreated'),present:false},{path:p('new-tree/child'),present:false},
      {path:p('old-tree'),present:false},{path:p('touched'),present:false},
    ]);
    assert.deepEqual(records.map(r=>r.outcome),['applied','applied','changed','newer','tree','newer']);
    assert.deepEqual(db.query('SELECT revision,problem FROM scopes').get(),{revision:11,problem:'access incomplete'});
    assert.equal(db.query('SELECT path FROM jobs').get().path,p('new\ntrack.mp3'));
    assert.equal(db.query('SELECT present FROM changes WHERE path=?').get(p('gone')).present,0);
    db.exec(`CREATE TABLE merged_changes(scope,path,present,tree,revision,PRIMARY KEY(scope,path));
      CREATE TABLE tree_barriers(scope,path,revision,PRIMARY KEY(scope,path));
      CREATE TABLE merge_queue(scope PRIMARY KEY,watermark)`);
    db.query('INSERT INTO merged_changes VALUES (?,?,?,?,?)').run('everything',p('folded'),1,0,10);
    db.query('INSERT INTO tree_barriers VALUES (?,?,?)').run('everything',p('folded-tree'),10);
    assert.deepEqual(repair([{path:p('folded'),present:false},{path:p('folded-tree/deleted'),present:false}]).map(r=>r.outcome),['newer','newer']);
    assert.equal(repair([{path:p('old-tree'),present:false}])[0].outcome,'applied');
    assert.equal(db.query('SELECT revision FROM tree_barriers WHERE path=?').get(p('old-tree')).revision,4);
    db.exec("UPDATE scopes SET stamp='v2'");
    assert.throws(()=>repair([{path:p('other'),present:false}]),/generation changed/);
    assert.equal(db.query('SELECT count(*) as n FROM changes').get().n,5);
  } finally {db.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
