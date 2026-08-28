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
        at_mention_run: { source: 'auto_run', agent_comment_id: 'agent-42', parent_comment_id: 'cmt-parent' },
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
  assert.equal(backfillOpts.parentCommentId, 'cmt-parent');
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

test('triggerAutoRunDeliveryForJob backfills delivery failure into mounted agent comment', async () => {
  let backfillOpts = null;
  const result = await triggerAutoRunDeliveryForJob(
    {
      layer_id: 'L-fail',
      auto_run_first: true,
      mounted_agent_comment_id: 'agent-fail',
      output: 'job stdout',
    },
    {
      lastBootstrapTaskDetail: {
        task: { title: 'T', target_branch: 'feat/x', auto_run: true },
        at_mention_run: { source: 'auto_run', agent_comment_id: 'agent-fail' },
      },
      runAutoRunDelivery: async () => ({
        ok: false,
        pushResult: {
          httpStatus: 400,
          payload: { ok: false, detail: '该仓库未找到可用的 OAuth access_token' },
        },
      }),
      backfillAutoRunPrToAgentComment: async (opts) => {
        backfillOpts = opts;
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(backfillOpts.failed, true);
  assert.equal(backfillOpts.detail, '该仓库未找到可用的 OAuth access_token');
  assert.equal(backfillOpts.agentCommentId, 'agent-fail');
});

test('triggerAutoRunDeliveryForJob persists last_push_error for ztree', async () => {
  const remembered = [];
  const cleared = [];
  await triggerAutoRunDeliveryForJob(
    {
      layer_id: '20260822_092914_76165f',
      auto_run_first: true,
    },
    {
      lastBootstrapTaskDetail: { task: { title: 'T', target_branch: 'feat/x' } },
      runAutoRunDelivery: async () => ({
        ok: false,
        pushResult: {
          httpStatus: 400,
          payload: { ok: false, detail: '该仓库未找到可用的 OAuth access_token' },
        },
      }),
      rememberLayerLastPushError: (layerId, detail, opts) => {
        remembered.push({ layerId, detail, opts });
        return true;
      },
      clearLayerLastPushError: (layerId) => {
        cleared.push(layerId);
      },
    },
  );
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].layerId, '20260822_092914_76165f');
  assert.match(remembered[0].detail, /OAuth access_token/);
  assert.equal(cleared.length, 0);
});

test('triggerAutoRunDeliveryForJob backfills even when delivery skipped as done', async () => {
  let backfillOpts = null;
  const result = await triggerAutoRunDeliveryForJob(
    {
      layer_id: 'L-skip',
      auto_run_first: true,
      mounted_agent_comment_id: 'agent-skip',
    },
    {
      lastBootstrapTaskDetail: {
        task: { title: 'T', target_branch: 'feat/x', auto_run: true },
        at_mention_run: { source: 'auto_run', agent_comment_id: 'agent-skip' },
      },
      runAutoRunDelivery: async () => ({ ok: true, skipped: true, reason: 'done_marker' }),
      backfillAutoRunPrToAgentComment: async (opts) => {
        backfillOpts = opts;
        return { ok: true };
      },
      readLayerPrHtmlUrl: () => 'https://gitlab.example/a/b/-/merge_requests/4',
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(backfillOpts.agentCommentId, 'agent-skip');
  assert.equal(backfillOpts.rememberedPrUrl, 'https://gitlab.example/a/b/-/merge_requests/4');
});

test('triggerAutoRunDeliveryForJob resolves agent id from context_pack.at_mention_run', async () => {
  let backfillOpts = null;
  await triggerAutoRunDeliveryForJob(
    {
      layer_id: 'L-pack',
      auto_run_first: true,
    },
    {
      lastBootstrapTaskDetail: {
        task: { title: 'T', target_branch: 'feat/x', auto_run: true },
        context_pack: {
          at_mention_run: { source: 'auto_run', agent_comment_id: 'agent-pack' },
        },
      },
      runAutoRunDelivery: async () => ({
        ok: true,
        pushResult: {
          payload: {
            github_oauth_multirepo: {
              repos: [{ pr: { html_url: 'https://gitlab.example/a/b/-/merge_requests/5' } }],
            },
          },
        },
      }),
      backfillAutoRunPrToAgentComment: async (opts) => {
        backfillOpts = opts;
        return { ok: true };
      },
    },
  );
  assert.equal(backfillOpts.agentCommentId, 'agent-pack');
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
