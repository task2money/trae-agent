import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 交付钩子契约：仅 completed + auto_run_first 触发（与 jobsRuntime close 钩子一致）。
 */
function shouldRunAutoRunDeliveryOnClose(rec, wasInterrupted) {
  return !wasInterrupted && rec?.status === 'completed' && Boolean(rec?.auto_run_first);
}

test('delivery hook only on completed auto_run_first', () => {
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
    shouldRunAutoRunDeliveryOnClose({ status: 'completed', auto_run_first: true }, true),
    false,
  );
  assert.equal(
    shouldRunAutoRunDeliveryOnClose({ status: 'interrupted', auto_run_first: true }, false),
    false,
  );
});
