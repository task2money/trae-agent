import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runJobAsync } from './jobsRuntimeRunJob.mjs';

// 隔离 state 目录，避免测试写 repo 内 onlineProject_state。
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'online-state-'));
process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = { on() {} };
  proc.stderr = { on() {} };
  return proc;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('runJobAsync close triggers delivery even without mounted agent', async () => {
  const proc = makeFakeProc();
  let spawnCalls = 0;
  const spawnFn = () => {
    spawnCalls += 1;
    return proc;
  };

  let deliveryCalls = 0;
  let deliveredRec = null;
  const drainCalls = [];
  const rec = {
    id: 'job_delivery1',
    layer_id: 'layer1',
    command_kind: 'shell',
    command: 'echo hi',
    auto_run_first: true,
    status: 'running',
    output: 'hello world',
  };
  runJobAsync(rec, '/tmp', {
    drainQueuedJobsForLayer: (layerId, jobId) => {
      drainCalls.push([layerId, jobId]);
    },
    triggerAutoRunDeliveryForJobAndMirror: async (r) => {
      deliveryCalls += 1;
      deliveredRec = r;
    },
    spawn: spawnFn,
  });

  assert.equal(spawnCalls, 1, 'spawn should be called once');
  proc.emit('close', 0);
  await flush();

  assert.equal(rec.status, 'completed', 'exit 0 should mark completed');
  assert.equal(typeof rec.finished_at, 'string');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.finished_at), 'finished_at must be ISO');
  assert.equal(deliveryCalls, 1, 'delivery must trigger with no mounted agent');
  assert.equal(deliveredRec, rec, 'delivery receives the job rec');
  assert.deepEqual(drainCalls, [['layer1', 'job_delivery1']], 'drain queued should run');
});

test('runJobAsync interrupted close does not deliver', async () => {
  const proc = makeFakeProc();
  let deliveryCalls = 0;
  const rec = {
    id: 'job_interrupted1',
    layer_id: 'layer1',
    command_kind: 'shell',
    command: 'echo hi',
    auto_run_first: true,
    status: 'running',
    output: '',
  };
  runJobAsync(rec, '/tmp', {
    drainQueuedJobsForLayer: () => {},
    triggerAutoRunDeliveryForJobAndMirror: async () => {
      deliveryCalls += 1;
    },
    spawn: () => proc,
  });

  rec.status = 'interrupted';
  rec.finished_at = '2026-08-22T10:00:00.000Z';
  proc.emit('close', 1);
  await flush();

  assert.equal(deliveryCalls, 0, 'interrupted must not deliver');
  assert.equal(rec.status, 'interrupted');
  assert.equal(rec.finished_at, '2026-08-22T10:00:00.000Z', 'close must not overwrite interrupt time');
});

test('runJobAsync close on non-delivery-eligible job does not deliver', async () => {
  const proc = makeFakeProc();
  let deliveryCalls = 0;
  const rec = {
    id: 'job_plain1',
    layer_id: 'layer1',
    command_kind: 'shell',
    command: 'echo hi',
    auto_run_first: false,
    status: 'running',
    output: '',
  };
  runJobAsync(rec, '/tmp', {
    drainQueuedJobsForLayer: () => {},
    triggerAutoRunDeliveryForJobAndMirror: async () => {
      deliveryCalls += 1;
    },
    spawn: () => proc,
  });

  proc.emit('close', 0);
  await flush();

  assert.equal(deliveryCalls, 0, 'plain job must not deliver');
  assert.equal(rec.status, 'completed');
  assert.equal(typeof rec.finished_at, 'string');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.finished_at));
});

test('runJobAsync error stamps finished_at', async () => {
  const proc = makeFakeProc();
  const rec = {
    id: 'job_err1',
    layer_id: 'layer1',
    command_kind: 'shell',
    command: 'echo hi',
    status: 'running',
    output: '',
  };
  runJobAsync(rec, '/tmp', {
    drainQueuedJobsForLayer: () => {},
    triggerAutoRunDeliveryForJobAndMirror: async () => {},
    spawn: () => proc,
  });

  proc.emit('error', new Error('spawn failed'));
  await flush();

  assert.equal(rec.status, 'failed');
  assert.equal(typeof rec.finished_at, 'string');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.finished_at));
});
