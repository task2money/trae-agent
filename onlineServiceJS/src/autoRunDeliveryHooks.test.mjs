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

test('triggerAutoRunDeliveryForJob backfills PR into mounted agent comment', async () => {
  let backfillOpts = null;
  const result = await triggerAutoRunDeliveryForJob(
    {
      layer_id: 'L2',
      auto_run_first: true,
      auto_run_commit_message: 't',
      mounted_agent_comment_id: 'agent-42',
      output: 'job stdout',
    },
    {
      lastBootstrapTaskDetail: {
        task: { title: 'T', target_branch: 'feat/x', auto_run: true },
        at_mention_run: { source: 'auto_run', agent_comment_id: 'agent-42' },
      },
      runAutoRunDelivery: async () => ({
        ok: true,
        pushResult: {
          payload: { repos: [{ pr: { html_url: 'https://github.com/acme/x/pull/9' } }] },
        },
      }),
      backfillAutoRunPrToAgentComment: async (opts) => {
        backfillOpts = opts;
        return { ok: true, urls: ['https://github.com/acme/x/pull/9'] };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(backfillOpts.agentCommentId, 'agent-42');
  assert.equal(backfillOpts.priorAssistantResponse, 'job stdout');
  assert.equal(backfillOpts.pushResult.payload.repos[0].pr.html_url, 'https://github.com/acme/x/pull/9');
  assert.equal(result.pr_backfill?.ok, true);
});

test('triggerAutoRunDeliveryForJob edit_run forces delivery and backfills', async () => {
  const deliveryOpts = [];
  let backfillOpts = null;
  let ensureCalled = false;
  const rec = {
    id: 'J-edit',
    layer_id: 'L3',
    edit_run_delivery: true,
    auto_run_commit_message: 'fix cmd',
    mounted_parent_comment_id: 'cmt-p',
    edit_run_installed_image_id: 'img-1',
    output: 'edited output',
  };
  const result = await triggerAutoRunDeliveryForJob(rec, {
    lastBootstrapTaskDetail: {
      task: { title: 'T', target_branch: 'feat/y' },
      repo_git_identities: [],
    },
    runAutoRunDelivery: async (opts) => {
      deliveryOpts.push(opts);
      return {
        ok: true,
        pushResult: {
          payload: { github_pull_request: { html_url: 'https://github.com/acme/y/pull/3' } },
        },
      };
    },
    ensureEditRunMountedAgentComment: async (r) => {
      ensureCalled = true;
      r.mounted_agent_comment_id = 'agent-edit';
      return { ok: true, id: 'agent-edit' };
    },
    backfillAutoRunPrToAgentComment: async (opts) => {
      backfillOpts = opts;
      return { ok: true, urls: ['https://github.com/acme/y/pull/3'] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(deliveryOpts[0].force, true);
  assert.equal(deliveryOpts[0].editRunJobId, 'J-edit');
  assert.equal(ensureCalled, true);
  assert.equal(backfillOpts.agentCommentId, 'agent-edit');
  assert.equal(backfillOpts.kind, 'edit_run');
  assert.equal(backfillOpts.priorAssistantResponse, 'edited output');
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
