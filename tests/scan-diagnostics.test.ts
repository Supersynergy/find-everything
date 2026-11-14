import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CloudScanDiagnostics} from '../src/scan-diagnostics';

test('collect only complete timeout hints inside the indexed cloud directory', () => {
  const cloud = '/home/u/Library/CloudStorage';
  const root = cloud + '/provider';
  const dir = root + '/.privat – ß';
  const parser = new CloudScanDiagnostics([root], cloud);
  parser.push('[fd error]: ' + dir + ': Opera');
  parser.push('tion timed out (os error 60)\nfind: ' + dir + ': Operation timed out\n');
  for (const wrong of [root+'-copy', root+'/../outside', cloud+'X', '/private']) {
    parser.push('find: '+wrong+': Operation timed out\n');
  }
  parser.push('x'.repeat(9000));
  parser.push('find: '+root+'/bad: Operation timed out\nfind: '+root+'/private: Permission denied\n');
  parser.push('find: '+root+': Operation timed out');
  assert.deepEqual(parser.finish(), {retryDirectories:[dir,root], retryDirectoriesTruncated:false});
});
