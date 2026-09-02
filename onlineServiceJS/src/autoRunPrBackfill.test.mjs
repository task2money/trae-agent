import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillAutoRunPrToAgentComment,
  buildContainerAgentCompleteUrl,
  completeMountedAgentComment,
  composeAutoRunPrBackfillReply,
  extractPrUrlsFromPushResult,
} from './autoRunPrBackfill.mjs';

test('extractPrUrlsFromPushResult reads repos[].pr.html_url', () => {
  const urls = extractPrUrlsFromPushResult({
    payload: {
      repos: [
        { pr: { html_url: 'https://github.com/a/b/pull/1' } },
        { pr: { html_url: 'https://github.com/a/b/pull/1' } },
        { pr: { html_url: 'https://gitlab.com/a/b/-/merge_requests/2' } },
      ],
    },
  });
  assert.deepEqual(urls, [
    'https://github.com/a/b/pull/1',
    'https://gitlab.com/a/b/-/merge_requests/2',
  ]);
});

test('extractPrUrlsFromPushResult reads github_oauth_multirepo.repos[].pr.html_url', () => {
  const urls = extractPrUrlsFromPushResult({
    payload: {
      ok: true,
      github_oauth_multirepo: {
        repos: [
          { pr: { html_url: 'https://gitlab-tencent-sh-1.aidevpush.com/ljy/somanyad/-/merge_requests/2' } },
        ],
      },
    },
  });
  assert.deepEqual(urls, [
    'https://gitlab-tencent-sh-1.aidevpush.com/ljy/somanyad/-/merge_requests/2',
  ]);
});

test('extractPrUrlsFromPushResult includes rememberedPrUrl when payload has no PR', () => {
  const urls = extractPrUrlsFromPushResult(
    { payload: { ok: true } },
    { rememberedPrUrl: 'https://gitlab.example/a/b/-/merge_requests/9' },
  );
  assert.deepEqual(urls, ['https://gitlab.example/a/b/-/merge_requests/9']);
});

test('composeAutoRunPrBackfillReply formats single and clean skip', () => {
  assert.match(
    composeAutoRunPrBackfillReply({ urls: ['https://pr'] }),
    /https:\/\/pr/,
  );
  assert.match(composeAutoRunPrBackfillReply({ skippedClean: true }), /干净/);
  assert.match(
    composeAutoRunPrBackfillReply({ failed: true, detail: '该仓库未找到可用的 OAuth access_token' }),
    /失败：该仓库未找到可用的 OAuth access_token/,
  );
});

test('buildContainerAgentCompleteUrl strips /cloud suffix', () => {
  const url = buildContainerAgentCompleteUrl('agent-9', () =>
    'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud',
  );
  assert.equal(
    url,
    'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/container-agent-comments/agent-9/complete',
  );
});

test('backfillAutoRunPrToAgentComment calls complete with PR text', async () => {
  let saw = null;
  const out = await backfillAutoRunPrToAgentComment({
    agentCommentId: 'agent-1',
    pushResult: {
      payload: { repos: [{ pr: { html_url: 'https://github.com/acme/demo/pull/3' } }] },
    },
    completeFn: async (opts) => {
      saw = opts;
      return { ok: true };
    },
    recordGitPrReplyFn: async () => ({ ok: true, skipped: true, reason: 'stub' }),
  });
  assert.equal(out.ok, true);
  assert.equal(saw.agentCommentId, 'agent-1');
  assert.match(saw.assistantResponse, /https:\/\/github.com\/acme\/demo\/pull\/3/);
});

test('backfillAutoRunPrToAgentComment records git_pr human reply after complete', async () => {
  let replyOpts = null;
  const out = await backfillAutoRunPrToAgentComment({
    agentCommentId: 'agent-1',
    parentCommentId: 'cmt-exec',
    pushResult: {
      payload: { repos: [{ pr: { html_url: 'https://github.com/acme/demo/pull/3' } }] },
    },
    completeFn: async () => ({ ok: true }),
    recordGitPrReplyFn: async (opts) => {
      replyOpts = opts;
      return { ok: true, replies: [{ ok: true, html_url: opts.urls[0], skipped: false }] };
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(replyOpts.urls, ['https://github.com/acme/demo/pull/3']);
  assert.equal(replyOpts.parentCommentId, 'cmt-exec');
  assert.equal(out.git_pr_replies.ok, true);
});

test('backfillAutoRunPrToAgentComment skips git_pr reply without urls', async () => {
  let replyCalled = false;
  const out = await backfillAutoRunPrToAgentComment({
    agentCommentId: 'agent-1',
    parentCommentId: 'cmt-exec',
    skippedClean: true,
    completeFn: async () => ({ ok: true }),
    recordGitPrReplyFn: async () => {
      replyCalled = true;
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(replyCalled, false);
  assert.equal(out.git_pr_replies, null);
});

test('backfillAutoRunPrToAgentComment uses rememberedPrUrl when payload has no repos', async () => {
  let saw = null;
  const out = await backfillAutoRunPrToAgentComment({
    agentCommentId: 'agent-1',
    pushResult: { payload: { ok: true } },
    rememberedPrUrl: 'https://gitlab.example/a/b/-/merge_requests/9',
    completeFn: async (opts) => {
      saw = opts;
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.match(saw.assistantResponse, /merge_requests\/9/);
});

test('backfillAutoRunPrToAgentComment skips without agent id and without parent PR', async () => {
  const out = await backfillAutoRunPrToAgentComment({ agentCommentId: '' });
  assert.equal(out.skipped, true);
});

test('backfillAutoRunPrToAgentComment records git_pr reply without agent comment', async () => {
  let completeCalled = false;
  let replyOpts = null;
  const out = await backfillAutoRunPrToAgentComment({
    agentCommentId: '',
    parentCommentId: 'cmt-exec',
    pushResult: {
      payload: { repos: [{ pr: { html_url: 'https://gitlab.example/a/b/-/merge_requests/27' } }] },
    },
    completeFn: async () => {
      completeCalled = true;
      return { ok: true };
    },
    recordGitPrReplyFn: async (opts) => {
      replyOpts = opts;
      return { ok: true, replies: [{ ok: true, html_url: opts.urls[0] }] };
    },
  });
  assert.equal(completeCalled, false);
  assert.equal(out.ok, true);
  assert.deepEqual(replyOpts.urls, ['https://gitlab.example/a/b/-/merge_requests/27']);
  assert.equal(replyOpts.parentCommentId, 'cmt-exec');
  assert.equal(out.git_pr_replies.ok, true);
});

test('backfillAutoRunPrToAgentComment appends PR after prior stream text', async () => {
  let saw = null;
  const out = await backfillAutoRunPrToAgentComment({
    agentCommentId: 'agent-1',
    priorAssistantResponse: 'streamed stdout',
    pushResult: {
      payload: { repos: [{ pr: { html_url: 'https://github.com/acme/demo/pull/3' } }] },
    },
    completeFn: async (opts) => {
      saw = opts;
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.match(saw.assistantResponse, /^streamed stdout\n\n/);
  assert.match(saw.assistantResponse, /pull\/3/);
});

test('completeMountedAgentComment body 带 COMMENT_ID', async () => {
  const prev = process.env.COMMENT_ID;
  process.env.COMMENT_ID = 'cmt-complete';
  try {
    const calls = [];
    const out = await completeMountedAgentComment({
      agentCommentId: 'agent-9',
      assistantResponse: 'done',
      accessToken: 'tok',
      prefixFn: () => 'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud',
      fetchFn: async (_url, init) => {
        calls.push(init);
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });
    assert.equal(out.ok, true);
    assert.equal(JSON.parse(calls[0].body).comment_id, 'cmt-complete');
    assert.equal(JSON.parse(calls[0].body).assistant_response, 'done');
  } finally {
    if (prev === undefined) delete process.env.COMMENT_ID;
    else process.env.COMMENT_ID = prev;
  }
});
