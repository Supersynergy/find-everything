import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, statSync, rmSync, realpathSync, readFileSync, symlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
const [cli, evidence] = process.argv.slice(2);
if (!cli || !evidence) throw new Error('Usage: bun scripts/verify-semantic.ts /absolute/fe evidence-dir');
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fe-acoustic-'))), root = path.join(dir, 'audio'); mkdirSync(root);
const env = { ...process.env, FE_DATA_DIR: path.join(dir, 'cache'), FE_CONFIG_DIR: path.join(dir, 'config') };
const run = (...args: string[]) => JSON.parse(execFileSync(cli, [...args, '--json'], { env, encoding: 'utf8', timeout: 60000, maxBuffer: 2e6 }));
const times: any[] = [];
try {
  copyFileSync(path.join(evidence, 'dog.wav'), path.join(root, 'a.wav'));
  copyFileSync(path.join(evidence, 'cat.wav'), path.join(root, 'b.wav'));
  symlinkSync(path.join(root, 'a.wav'), path.join(root, 'z-alias.wav'));
  run('index', root, '--name', 'fixture'); run('enrich', '--index', 'fixture');
  const beforeMissing = run('search', '(Hund bellen)', '--index', 'fixture', '--snapshot');
  assert.equal(beforeMissing.complete, false); assert.deepEqual(beforeMissing.paths, []);
  let start = performance.now(); const first = run('semantic', 'index', '--index', 'fixture', '--max-files', '10', '--seconds', '40');
  times.push({ phase: 'index-cold', ms: performance.now() - start });
  assert.equal(first.analyzed, 2); assert.equal(first.failed, 0); assert.equal(first.pending, 0);
  const db = first.database, stamp = statSync(db).mtimeMs;
  const pathStamp = statSync(path.join(dir, 'cache/index-fixture.txt')).mtimeMs;
  const result: any = {};
  for (const [query, expected] of [['(Hund bellen)', 'a.wav'], ['(Katze)', 'b.wav']]) {
    start = performance.now(); const reply = run('search', query, '--index', 'fixture', '--snapshot', '-n', '1');
    times.push({ phase: query, ms: performance.now() - start });
    result[query] = reply; assert.equal(path.basename(reply.paths[0]), expected); assert.equal(reply.semantic, true); assert.equal(reply.complete, false);
    assert.equal(reply.coverage.known, 2); assert.equal(reply.coverage.unknown, 0);
  }
  start = performance.now(); const second = run('semantic', 'index', '--index', 'fixture', '--max-files', '10', '--seconds', '10');
  times.push({ phase: 'index-reuse', ms: performance.now() - start });
  assert.equal(second.analyzed, 0); assert.equal(second.reused, 2); assert.equal(statSync(db).mtimeMs, stamp);
  assert.equal(statSync(path.join(dir, 'cache/index-fixture.txt')).mtimeMs, pathStamp);
  const socketPath = path.join(dir, 'run/search.sock');
  const service = spawn(cli, ['serve', '--socket', socketPath, '--idle-seconds', '20'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Socket startup timeout')), 10000); service.stderr.on('data', d => { if (d.toString().includes('socket')) { clearTimeout(timer); resolve(); } }); service.once('exit', () => reject(new Error('Socket service stopped'))); });
    const info = JSON.parse(readFileSync(socketPath + '.json', 'utf8'));
    const get = (q: string) => new Promise<any>((resolve, reject) => {
      const req = request({ socketPath, path: '/v1/search?' + new URLSearchParams({ q, index: 'fixture', limit: '1' }), headers: { Host: 'localhost', Authorization: 'Bearer ' + info.token }, timeout: 10000 }, res => {
        let body = ''; res.on('data', d => body += d); res.on('end', () => { try { assert.equal(res.statusCode, 200, body); resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Timeout'))); req.end();
    });
    const descriptive = await Promise.all([get('(düstere Hundebellen)'), get('(helle Katze)')]);
    assert.equal(path.basename(descriptive[0].paths[0]), 'a.wav'); assert.equal(path.basename(descriptive[1].paths[0]), 'b.wav');
    const concurrent = await Promise.all([get('(Hund bellen)'), get('(Katze)')]);
    assert.equal(path.basename(concurrent[0].paths[0]), 'a.wav'); assert.equal(path.basename(concurrent[1].paths[0]), 'b.wav');
    for (let i = 0; i < 16; i++) {
      const start = performance.now(); const reply = await get(i % 2 ? '(Katze)' : '(Hund bellen)');
      assert.equal(path.basename(reply.paths[0]), i % 2 ? 'b.wav' : 'a.wav');
      times.push({ phase: 'socket-warm', ms: performance.now() - start, cacheHit: reply.cacheHit });
    }
  } finally { service.kill('SIGTERM'); await new Promise(resolve => service.once('close', resolve)); }
  const mcpInput = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'acoustic-oracle', version: '1' }, capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_files', arguments: { query: '(Katze)', index: 'fixture', limit: 1 } } },
  ].map(v => JSON.stringify(v)).join('\n') + '\n';
  const mcp = execFileSync(cli, ['mcp'], { env, input: mcpInput, encoding: 'utf8', timeout: 10000 });
  const mcpReply = JSON.parse(mcp.trim().split('\n').pop()!).result;
  assert.equal(path.basename(JSON.parse(mcpReply.content[0].text).paths[0]), 'b.wav');
  writeFileSync(path.join(root, 'bad-model.wav'), 'broken audio');
  run('index', '--index', 'fixture'); run('enrich', '--index', 'fixture');
  const failure = run('semantic', 'index', '--index', 'fixture', '--max-files', '10', '--seconds', '20');
  assert.equal(failure.failed, 1); assert.equal(failure.analyzed, 1);
  const negativeCache = run('semantic', 'index', '--index', 'fixture', '--max-files', '10', '--seconds', '20');
  assert.equal(negativeCache.analyzed, 0); assert.equal(negativeCache.reused, 3);
  const page1 = run('search', '(Katze)', '--index', 'fixture', '--snapshot', '-n', '1');
  const page2 = run('search', '(Katze)', '--index', 'fixture', '--snapshot', '-n', '1', '--offset', String(page1.nextOffset));
  assert.equal(page1.snapshotId, page2.snapshotId); assert.notEqual(page1.paths[0], page2.paths[0]); assert.equal(page2.nextOffset, null);
  copyFileSync(path.join(evidence, 'cat.wav'), path.join(root, 'a.wav'));
  const changed = run('search', '(Hund bellen)', '--index', 'fixture', '--snapshot');
  assert(!changed.paths.includes(path.join(root, 'a.wav'))); assert.equal(changed.coverage.changed, 1);
  const repair = run('semantic', 'index', '--index', 'fixture', '--max-files', '10', '--seconds', '20');
  assert.equal(repair.analyzed, 1); assert.equal(repair.reused, 2);
  writeFileSync(path.join(evidence, 'semantic-oracle.json'), JSON.stringify({ passed: true, oracle: 'Opaque filenames; public dog/cat recording identity independent of retrieved filenames; top-1 dog and cat; pagination; changed-match rejection; exact cache reuse with unchanged SQLite and path-index timestamps.', times, first, second, result, cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex') }, null, 2));
  console.log(JSON.stringify({ passed: true, times }));
} finally { rmSync(dir, { recursive: true, force: true }); }
