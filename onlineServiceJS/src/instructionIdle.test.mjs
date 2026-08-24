import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyIdlePolicyFromTaskDetail,
  cancelInstructionIdleTimer,
  currentIdleMinutes,
  fireInstructionIdleTimeout,
  maybeStartIdleAfterJob,
  preemptForNewInstruction,
  resetInstructionIdleStateForTests,
  startIdleWhenContainerReady,
  startInstructionIdleCountdown,
} from './instructionIdle.mjs';

test('applyIdlePolicyFromTaskDetail reads minutes and omits sts', () => {
  resetInstructionIdleStateForTests();
  applyIdlePolicyFromTaskDetail({ idle_recycle_minutes: 30 });
  assert.equal(currentIdleMinutes(), 30);
  applyIdlePolicyFromTaskDetail({ idle_recycle_minutes: 0 });
  assert.equal(currentIdleMinutes(), 0);
});

test('preemptForNewInstruction interrupts running and pending then clears idle', () => {
  resetInstructionIdleStateForTests();
  applyIdlePolicyFromTaskDetail({ idle_recycle_minutes: 15 });
  const jobs = new Map([
    ['a', { status: 'running' }],
    ['b', { status: 'pending' }],
    ['c', { status: 'completed' }],
  ]);
  const interrupted = [];
  const beats = [];
  const ids = preemptForNewInstruction({
    jobs,
    interruptFn: (id) => interrupted.push(id),
    heartbeatFn: (idle) => beats.push(idle),
  });
  assert.deepEqual(interrupted.sort(), ['a', 'b']);
  assert.deepEqual(ids.sort(), ['a', 'b']);
  assert.deepEqual(beats, [false]);
});

test('startInstructionIdleCountdown no-ops when minutes is 0', () => {
  resetInstructionIdleStateForTests();
  applyIdlePolicyFromTaskDetail({ idle_recycle_minutes: 0 });
  let fired = 0;
  const started = startInstructionIdleCountdown({
    delayMs: 1,
    setTimeoutFn: (fn) => {
      fired += 1;
      fn();
      return 1;
    },
    releaseFn: async () => true,
  });
  assert.equal(started, false);
  assert.equal(fired, 0);
});

test('idle timeout calls L1 release with instruction_idle', async () => {
  resetInstructionIdleStateForTests();
  applyIdlePolicyFromTaskDetail({ idle_recycle_minutes: 1 });
  const seen = [];
  const started = startInstructionIdleCountdown({
    delayMs: 0,
    setTimeoutFn: (fn) => {
      fn();
      return 1;
    },
    releaseFn: async (opts) => {
      seen.push(opts);
      return true;
    },
  });
  assert.equal(started, true);
  await Promise.resolve();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'instruction_idle');
});

test('L3 STS only when L1 fails and sts present', async () => {
  resetInstructionIdleStateForTests();
  applyIdlePolicyFromTaskDetail({
    idle_recycle_minutes: 1,
    machine_release_sts: { access_key_id: 'STS.x' },
  });
  let stsCalls = 0;
  await fireInstructionIdleTimeout({
    releaseFn: async () => false,
    deleteInstanceFn: async (sts) => {
      stsCalls += 1;
      assert.equal(sts.access_key_id, 'STS.x');
    },
  });
  assert.equal(stsCalls, 1);
  resetInstructionIdleStateForTests();
  applyIdlePolicyFromTaskDetail({ idle_recycle_minutes: 1 });
  stsCalls = 0;
  await fireInstructionIdleTimeout({
    releaseFn: async () => false,
    deleteInstanceFn: async () => {
      stsCalls += 1;
    },
  });
  assert.equal(stsCalls, 0);
});

test('maybeStartIdleAfterJob respects idleEligible gate', () => {
  resetInstructionIdleStateForTests();
  applyIdlePolicyFromTaskDetail({ idle_recycle_minutes: 10 });
  const beats = [];
  const started = maybeStartIdleAfterJob({
    idleEligible: false,
    heartbeatFn: (v) => beats.push(v),
    setTimeoutFn: (fn) => 1,
  });
  assert.equal(started, false);
  assert.equal(beats.length, 0);
  const ok = maybeStartIdleAfterJob({
    idleEligible: true,
    heartbeatFn: (v) => beats.push(v),
    setTimeoutFn: (fn) => 1,
    delayMs: 60_000,
  });
  assert.equal(ok, true);
  assert.deepEqual(beats, [true]);
  cancelInstructionIdleTimer();
});

test('startIdleWhenContainerReady marks idle after bootstrap without a job', () => {
  resetInstructionIdleStateForTests();
  applyIdlePolicyFromTaskDetail({ idle_recycle_minutes: 5 });
  const beats = [];
  const started = startIdleWhenContainerReady({
    heartbeatFn: (v) => beats.push(v),
    setTimeoutFn: (fn) => 1,
    delayMs: 60_000,
  });
  assert.equal(started, true);
  assert.deepEqual(beats, [true]);
  cancelInstructionIdleTimer();
});
