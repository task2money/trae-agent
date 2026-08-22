import assert from 'node:assert/strict';
import test from 'node:test';

import { finalizeJobCloseSideEffects } from './jobsRuntimeCloseSideEffects.mjs';

test('auto_run completed without mounted agent still triggers delivery', async () => {
  const seen = [];
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: false,
    mountedAgentId: '',
    rec: { status: 'completed', auto_run_first: true, output: 'done' },
    exitCode: 0,
    triggerAutoRunDeliveryForJobAndMirror: async (rec) => {
      seen.push(rec);
    },
    completeMountedAgentComment: async () => {
      throw new Error('should not complete agent without mount');
    },
  });
  assert.equal(out.deliveryTriggered, true);
  assert.equal(seen.length, 1);
});

test('edit_run completed without mounted agent still triggers delivery', async () => {
  let delivered = false;
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: false,
    mountedAgentId: '',
    rec: { status: 'completed', edit_run_delivery: true },
    exitCode: 0,
    triggerAutoRunDeliveryForJobAndMirror: async () => {
      delivered = true;
    },
  });
  assert.equal(out.deliveryTriggered, true);
  assert.equal(delivered, true);
});

test('interrupted job skips delivery even with auto_run_first', async () => {
  let delivered = false;
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: true,
    mountedAgentId: '',
    rec: { status: 'interrupted', auto_run_first: true },
    exitCode: null,
    triggerAutoRunDeliveryForJobAndMirror: async () => {
      delivered = true;
    },
  });
  assert.equal(out.deliveryTriggered, false);
  assert.equal(out.reason, 'interrupted');
  assert.equal(out.idleEligible, false);
  assert.equal(delivered, false);
});

test('mounted agent with empty output still delivers (PR backfill must run)', async () => {
  const calls = [];
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: false,
    mountedAgentId: 'cmt_agent_1',
    rec: { status: 'completed', auto_run_first: true, output: '' },
    exitCode: 0,
    completeMountedAgentComment: async () => {
      calls.push('complete');
    },
    triggerAutoRunDeliveryForJobAndMirror: async () => {
      calls.push('deliver');
    },
  });
  assert.equal(out.deliveryTriggered, true);
  assert.deepEqual(calls, ['deliver']);
});

test('with mounted agent: complete comment then deliver', async () => {
  const calls = [];
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: false,
    mountedAgentId: 'cmt_agent_1',
    rec: { status: 'completed', auto_run_first: true, output: 'hello' },
    exitCode: 0,
    completeMountedAgentComment: async (opts) => {
      calls.push(['complete', opts.agentCommentId, opts.assistantResponse]);
    },
    triggerAutoRunDeliveryForJobAndMirror: async () => {
      calls.push(['deliver']);
    },
  });
  assert.equal(out.deliveryTriggered, true);
  assert.deepEqual(calls, [
    ['complete', 'cmt_agent_1', 'hello'],
    ['deliver'],
  ]);
});

test('failed job with mount fails agent but does not deliver', async () => {
  const calls = [];
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: false,
    mountedAgentId: 'cmt_agent_1',
    rec: { status: 'failed', auto_run_first: true },
    exitCode: 1,
    failMountedAgentComment: async (opts) => {
      calls.push(['fail', opts.detail]);
    },
    triggerAutoRunDeliveryForJobAndMirror: async () => {
      calls.push(['deliver']);
    },
  });
  assert.equal(out.deliveryTriggered, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'fail');
});

test('delivery throw is not idle eligible', async () => {
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: false,
    mountedAgentId: '',
    rec: { status: 'completed', auto_run_first: true },
    exitCode: 0,
    triggerAutoRunDeliveryForJobAndMirror: async () => {
      throw new Error('push failed');
    },
  });
  assert.equal(out.deliveryTriggered, false);
  assert.equal(out.idleEligible, false);
  assert.equal(out.reason, 'delivery_threw');
});

test('ordinary completed job is idle eligible', async () => {
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: false,
    mountedAgentId: '',
    rec: { status: 'completed' },
    exitCode: 0,
  });
  assert.equal(out.idleEligible, true);
});

test('mounted complete throw is not idle eligible', async () => {
  const out = await finalizeJobCloseSideEffects({
    wasInterrupted: false,
    mountedAgentId: 'cmt_agent_1',
    rec: { status: 'completed', output: 'hello' },
    exitCode: 0,
    completeMountedAgentComment: async () => {
      throw new Error('comment 502');
    },
  });
  assert.equal(out.idleEligible, false);
  assert.equal(out.reason, 'mounted_complete_failed');
});
