import assert from 'node:assert/strict';
import test from 'node:test';

import { emitRuntimeEvent, postRuntimeEventToSaas, RUNTIME_EVENT_NAMES } from './runtimeEventLog.mjs';

test('RUNTIME_EVENT_NAMES includes bootstrap and auto_run keys', () => {
  assert.ok(RUNTIME_EVENT_NAMES.has('BOOTSTRAP_COMPLETE'));
  assert.ok(RUNTIME_EVENT_NAMES.has('AUTO_RUN_FIRST_INSTRUCTION_START'));
  assert.ok(RUNTIME_EVENT_NAMES.has('AUTO_RUN_FIRST_SKIP'));
});

test('emitRuntimeEvent posts allowed events via postFn', async () => {
  const calls = [];
  emitRuntimeEvent('BOOTSTRAP_PHASE', {
    phase: 'clone_begin',
    message: 'start clone',
    fields: { layer_id: 'L' },
    postFn: async (p) => {
      calls.push(p);
      return true;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'BOOTSTRAP_PHASE');
  assert.equal(calls[0].phase, 'clone_begin');
});

test('emitRuntimeEvent ignores unsupported event names', async () => {
  let called = 0;
  emitRuntimeEvent('NOPE', {
    postFn: async () => {
      called += 1;
      return true;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, 0);
});

test('postRuntimeEventToSaas returns false without token/prefix', async () => {
  const prev = process.env.ACCESS_TOKEN;
  delete process.env.ACCESS_TOKEN;
  try {
    const ok = await postRuntimeEventToSaas({ event: 'BOOTSTRAP_COMPLETE' });
    assert.equal(ok, false);
  } finally {
    if (prev !== undefined) process.env.ACCESS_TOKEN = prev;
  }
});
