import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGitCloneProgressPhases } from './saasTaskCloud.mjs';

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
