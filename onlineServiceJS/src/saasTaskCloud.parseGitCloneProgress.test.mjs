import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGitCloneProgressPhases, shouldEmitGitCloneProgressPercent } from './saasTaskCloud.mjs';

test('overall is 100 when unpack/checkout finished even if tail still has Receiving 9%', () => {
  const stderr = [
    'Receiving objects:   9% (1234/12345), 1.20 MiB | 200.00 KiB/s',
    'Resolving deltas: 100% (999/999), done.',
    'Checking out files: 100% (800/800), done.',
  ].join('\n');
  const phases = parseGitCloneProgressPhases(stderr);
  assert.equal(phases.recv, 9);
  assert.equal(phases.unpack, 100);
  assert.equal(phases.overall, 100);
});

test('overall follows receiving when unpack has not started', () => {
  const phases = parseGitCloneProgressPhases('Receiving objects:  42% (42/100)');
  assert.equal(phases.recv, 42);
  assert.equal(phases.unpack, null);
  assert.equal(phases.overall, 42);
});

test('overall follows unpack when receiving is absent', () => {
  const phases = parseGitCloneProgressPhases('Unpacking objects:  80% (8/10)');
  assert.equal(phases.recv, null);
  assert.equal(phases.unpack, 80);
  assert.equal(phases.overall, 80);
});

test('checkout 100% is kept when a later 12k tail only has Receiving 3%', () => {
  const checkout = 'Checking out files: 100% (800/800), done.\nResolving deltas: 100% (999/999), done.\n';
  const pad = 'x'.repeat(13000);
  const lateRecv = 'Receiving objects:   3% (12/400), 0.40 MiB | 80.00 KiB/s\n';
  const phases = parseGitCloneProgressPhases(checkout + pad + lateRecv);
  assert.equal(phases.recv, 3);
  assert.equal(phases.unpack, 100);
  assert.equal(phases.overall, 100);
});

test('shouldEmitGitCloneProgressPercent rejects regression after 100', () => {
  assert.equal(shouldEmitGitCloneProgressPercent(100, 3, 2000, 0), false);
  assert.equal(shouldEmitGitCloneProgressPercent(40, 41, 2000, 0), true);
  assert.equal(shouldEmitGitCloneProgressPercent(-1, 3, 0, 0), true);
});
