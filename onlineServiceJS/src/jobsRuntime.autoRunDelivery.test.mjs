import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 交付钩子契约：仅 completed + auto_run_first/edit_run_delivery 触发。
 * mounted_agent_comment_id 不得参与门控（见 jobsRuntimeCloseSideEffects）。
 */
function shouldRunAutoRunDeliveryOnClose(rec, wasInterrupted) {
  return (
    !wasInterrupted &&
    rec?.status === 'completed' &&
    Boolean(rec?.auto_run_first || rec?.edit_run_delivery)
  );
}

test('delivery hook only on completed auto_run_first or edit_run_delivery', () => {
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'completed', auto_run_first: true }, false),
    true,
  );
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'failed', auto_run_first: true }, false),
    false,
  );
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'completed', auto_run_first: false }, false),
    false,
  );
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'completed', edit_run_delivery: true }, false),
    true,
  );
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'completed', auto_run_first: true }, true),
    false,
  );
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'interrupted', auto_run_first: true }, false),
    false,
  );
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'failed', edit_run_delivery: true }, false),
    false,
  );
});

test('delivery eligibility ignores empty mounted agent id', () => {
  // 回归：曾用 if (!mountedAgentId) return 误跳过交付
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'completed', auto_run_first: true }, false),
    true,
  );
});
