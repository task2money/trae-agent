import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveAutoRunDeliveryTargetBranch,
  retryPendingAutoRunDeliveries,
  triggerAutoRunDeliveryForJob,
} from './autoRunDeliveryHooks.mjs';

test('resolveAutoRunDeliveryTargetBranch falls back to branch_strategy', () => {
  assert.equal(
    resolveAutoRunDeliveryTargetBranch({
      task: {
        parameters: { branch_strategy: { work_branch_name: 'feat/from-strategy' } },
      },
    }),
    'feat/from-strategy',
  );
  assert.equal(
    resolveAutoRunDeliveryTargetBranch({ task: { target_branch: 'feat/direct' } }),
    'feat/direct',
  );
});

test('triggerAutoRunDeliveryForJob passes identities and remirrors', async () => {
  const calls = [];
  const mirrors = [];
  const result = await triggerAutoRunDeliveryForJob(
    {
      layer_id: 'L1',
      auto_run_commit_message: 'title',
    },
    {
      lastBootstrapTaskDetail: {
        task: { title: 'T', target_branch: 'feat/x' },
        repo_git_identities: [{ repo_url: 'https://x/a.git', user_name: 'A', user_email: 'a@e.com' }],
      },
      runAutoRunDelivery: async (opts) => {
        calls.push(opts);
        return { ok: true };
      },
      mirrorLayerGraphToTaskCloudSSE: async () => {
        mirrors.push(1);
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls[0].layerId, 'L1');
  assert.equal(calls[0].targetBranch, 'feat/x');
  assert.equal(calls[0].commitMessage, 'title');
  assert.equal(calls[0].identities.length, 1);
  assert.equal(mirrors.length, 1);
});

test('retryPendingAutoRunDeliveries only retries unfinished auto_run_first completed jobs', async () => {
  const triggered = [];
  const out = await retryPendingAutoRunDeliveries({
    listJobs: () => [
      { id: 'a', auto_run_first: true, status: 'completed' },
      { id: 'b', auto_run_first: true, status: 'failed' },
      { id: 'c', auto_run_first: false, status: 'completed' },
      { id: 'd', auto_run_first: true, status: 'completed' },
    ],
    shouldSkipAutoRunDelivery: () => false,
    triggerAutoRunDeliveryForJob: async (rec) => {
      triggered.push(rec.id);
      return { ok: true };
    },
  });
  assert.equal(out.attempted, 2);
  assert.deepEqual(triggered.sort(), ['a', 'd']);
});
