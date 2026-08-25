import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseGitCloneReceivedBytes,
  resolveGitCloneReceivedBytes,
} from './saasTaskCloudGitProgress.mjs';

test('parseGitCloneReceivedBytes reads last Receiving objects size', () => {
  const stderr = [
    'Receiving objects:  50% (10/20), 512.00 KiB | 1.00 MiB/s\r',
    'Receiving objects: 100% (20/20), 1.50 MiB | 2.00 MiB/s, done.\n',
  ].join('');
  assert.equal(parseGitCloneReceivedBytes(stderr), Math.round(1.5 * 1024 * 1024));
});

test('parseGitCloneReceivedBytes returns 0 when git omits size', () => {
  assert.equal(parseGitCloneReceivedBytes('Receiving objects: 100% (3/3), done.\n'), 0);
});

test('resolveGitCloneReceivedBytes prefers stderr over pack dir', () => {
  const n = resolveGitCloneReceivedBytes(
    'Receiving objects: 100% (8/8), 2.00 KiB | 1.00 KiB/s, done.\n',
    '/tmp/does-not-exist-clone-dir',
  );
  assert.equal(n, 2048);
});
