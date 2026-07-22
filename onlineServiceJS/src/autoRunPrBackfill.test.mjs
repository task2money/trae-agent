import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillAutoRunPrToAgentComment,
  buildContainerAgentCompleteUrl,
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

test('composeAutoRunPrBackfillReply formats single and clean skip', () => {
  assert.match(
    composeAutoRunPrBackfillReply({ urls: ['https://pr'] }),
    /https:\/\/pr/,
  );
  assert.match(composeAutoRunPrBackfillReply({ skippedClean: true }), /干净/);
});

test('buildContainerAgentCompleteUrl strips /cloud suffix', () => {
  const url = buildContainerAgentCompleteUrl('agent-9', () =>
    'https://api.example/api/tenant/t/workspace/w/task/task1/cloud',
  );
  assert.equal(
    url,
    'https://api.example/api/tenant/t/workspace/w/task/task1/container-agent-comments/agent-9/complete',
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
  });
  assert.equal(out.ok, true);
  assert.equal(saw.agentCommentId, 'agent-1');
  assert.match(saw.assistantResponse, /https:\/\/github.com\/acme\/demo\/pull\/3/);
});

test('backfillAutoRunPrToAgentComment skips without agent id', async () => {
  const out = await backfillAutoRunPrToAgentComment({ agentCommentId: '' });
  assert.equal(out.skipped, true);
});
