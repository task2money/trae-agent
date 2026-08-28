import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGitPrReplyInboundUrl,
  gitPrProviderOf,
  recordAutoRunGitPrReplyComments,
  uniquePrHtmlUrls,
} from './autoRunGitPrReplyComment.mjs';

test('gitPrProviderOf matches FE gitlab vs github', () => {
  assert.equal(
    gitPrProviderOf('https://gitlab-tencent-sh-1.aidevpush.com/ljy/somanyad/-/merge_requests/2'),
    'gitlab',
  );
  assert.equal(gitPrProviderOf('https://github.com/acme/demo/pull/3'), 'github');
});

test('uniquePrHtmlUrls drops blanks and duplicates', () => {
  assert.deepEqual(
    uniquePrHtmlUrls([' https://pr/1 ', 'https://pr/1', '', 'https://pr/2']),
    ['https://pr/1', 'https://pr/2'],
  );
});

test('buildGitPrReplyInboundUrl uses cloud server-container-token path', () => {
  const url = buildGitPrReplyInboundUrl(
    () => 'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud',
  );
  assert.equal(
    url,
    'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud/server-container-token/git-pr-reply/',
  );
});

test('recordAutoRunGitPrReplyComments skips without parent or urls', async () => {
  const noUrl = await recordAutoRunGitPrReplyComments({
    parentCommentId: 'cmt-p',
    accessToken: 'tok',
    prefixFn: () => 'https://api.example/cloud',
    postJsonFn: async () => {
      throw new Error('should not post');
    },
  });
  assert.equal(noUrl.skipped, true);
  assert.equal(noUrl.reason, 'no_pr_urls');

  const noParent = await recordAutoRunGitPrReplyComments({
    urls: ['https://github.com/acme/demo/pull/1'],
    parentCommentId: '',
    accessToken: 'tok',
    prefixFn: () => 'https://api.example/cloud',
    postJsonFn: async () => {
      throw new Error('should not post');
    },
  });
  assert.equal(noParent.skipped, true);
  assert.equal(noParent.reason, 'no_parent_comment_id');
});

test('recordAutoRunGitPrReplyComments posts independent git_pr once per unique url', async () => {
  const calls = [];
  const out = await recordAutoRunGitPrReplyComments({
    urls: [
      'https://github.com/acme/demo/pull/9',
      'https://github.com/acme/demo/pull/9',
    ],
    parentCommentId: 'cmt-exec',
    accessToken: 'tok',
    prefixFn: () => 'https://api.example/api/tenant/t/workspace/w/task/task1/comment/cmt_1/cloud',
    postJsonFn: async (url, body) => {
      calls.push({ url, body });
      return { ok: true, id: 'cmt_pr', skipped: false };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/server-container-token\/git-pr-reply\/$/);
  assert.equal(calls[0].body.access_token, 'tok');
  assert.equal(calls[0].body.parent_comment_id, 'cmt-exec');
  assert.equal(calls[0].body.html_url, 'https://github.com/acme/demo/pull/9');
  assert.equal(calls[0].body.git_pr.provider, 'github');
  assert.equal(calls[0].body.git_pr.html_url, 'https://github.com/acme/demo/pull/9');
});

test('recordAutoRunGitPrReplyComments treats skipped replay as ok and does not retry extra urls', async () => {
  const calls = [];
  const out = await recordAutoRunGitPrReplyComments({
    urls: ['https://gitlab.example/a/b/-/merge_requests/4'],
    parentCommentId: 'cmt-exec',
    accessToken: 'tok',
    prefixFn: () => 'https://api.example/cloud',
    postJsonFn: async (url, body) => {
      calls.push(body.html_url);
      return { ok: true, id: 'cmt_pr_existing', skipped: true };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.replies[0].skipped, true);
  assert.equal(calls.length, 1);
  assert.equal(out.replies[0].id, 'cmt_pr_existing');
});
