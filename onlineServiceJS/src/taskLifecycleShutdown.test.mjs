import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runTerminalShutdown,
  resetTerminalShutdownStateForTests,
} from './taskLifecycleShutdown.mjs';

test('runTerminalShutdown interrupts jobs, requests release, schedules exit', async () => {
  resetTerminalShutdownStateForTests();
  const interrupted = [];
  let releaseCalled = false;
  let exited = null;
  const result = await runTerminalShutdown(
    { terminal_kind: 'completed' },
    {
      listJobs: () => [
        { id: 'j1', status: 'running' },
        { id: 'j2', status: 'completed' },
        { id: 'j3', status: 'pending' },
      ],
      interruptJob: (id) => interrupted.push(id),
      mirrorLayerGraph: async () => true,
      postRelease: async () => {
        releaseCalled = true;
        return true;
      },
      exitProcess: true,
      exitDelayMs: 0,
      exitFn: (code) => {
        exited = code;
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(interrupted.sort(), ['j1', 'j3']);
  assert.equal(releaseCalled, true);
  assert.equal(result.release_ok, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(exited, 0);
});

test('runTerminalShutdown is idempotent while in flight', async () => {
  resetTerminalShutdownStateForTests();
  const p1 = runTerminalShutdown(
    { terminal_kind: 'cancelled' },
    {
      listJobs: () => [],
      interruptJob: () => {},
      mirrorLayerGraph: async () => {},
      postRelease: async () => true,
      exitProcess: false,
    },
  );
  const p2 = runTerminalShutdown({ terminal_kind: 'cancelled' }, { exitProcess: false });
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.ok, true);
  assert.equal(b.skipped, true);
});
