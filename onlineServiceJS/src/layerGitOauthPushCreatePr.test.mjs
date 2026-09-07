import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPullOrMergeRequestWithBaseFallback,
  expectedPrMissingDetail,
  prBaseFallbackCandidates,
} from './layerGitOauthPushCreatePr.mjs';

test('prBaseFallbackCandidates: main 回退 master，master 回退 main', () => {
  assert.deepEqual(prBaseFallbackCandidates('main'), ['main', 'master']);
  assert.deepEqual(prBaseFallbackCandidates('master'), ['master', 'main']);
  assert.deepEqual(prBaseFallbackCandidates('develop'), ['develop']);
});

test('expectedPrMissingDetail: push_ok 但无 PR 时生成明细', () => {
  const detail = expectedPrMissingDetail(
    [
      {
        push_ok: true,
        github_slug: 'ceshi/helloworld',
        pr_error: 'main:404 target branch does not exist',
      },
    ],
    { prBaseBranch: 'main', headName: 'feature/x' },
  );
  assert.match(detail, /未创建 PR\/MR/);
  assert.match(detail, /ceshi\/helloworld/);
  assert.match(detail, /merge_target=main/);
});

test('expectedPrMissingDetail: 无 prBase 或已有 PR 时为空', () => {
  assert.equal(
    expectedPrMissingDetail([{ push_ok: true, pr: { html_url: 'https://x/mr/1' } }], {
      prBaseBranch: 'main',
      headName: 'feature/x',
    }),
    '',
  );
  assert.equal(
    expectedPrMissingDetail([{ push_ok: true, pr_error: 'x' }], {
      prBaseBranch: '',
      headName: 'feature/x',
    }),
    '',
  );
});

test('createPullOrMergeRequestWithBaseFallback: main 失败后回退 master 成功', async () => {
  const basesTried = [];
  const out = await createPullOrMergeRequestWithBaseFallback({
    provider: 'gitlab',
    originUrl: 'https://gitlab.example/ceshi/helloworld.git',
    slugInfo: { owner: 'ceshi', repo: 'helloworld' },
    gitlabInfo: { owner: 'ceshi', repo: 'helloworld' },
    headName: 'feature/x',
    baseName: 'main',
    repoToken: 'tok',
    createGitlabMergeRequestFn: async ({ base }) => {
      basesTried.push(base);
      if (base === 'main') {
        return { ok: false, status: 400, json: null, text: 'target branch does not exist' };
      }
      return {
        ok: true,
        status: 201,
        json: {
          web_url: 'https://gitlab.example/ceshi/helloworld/-/merge_requests/9',
          iid: 9,
          state: 'opened',
        },
      };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.pr.html_url, 'https://gitlab.example/ceshi/helloworld/-/merge_requests/9');
  assert.equal(out.pr.base_branch, 'master');
  assert.deepEqual(basesTried, ['main', 'master']);
});

test('createPullOrMergeRequestWithBaseFallback: 全部 base 失败返回 pr_error', async () => {
  const out = await createPullOrMergeRequestWithBaseFallback({
    provider: 'github',
    slugInfo: { owner: 'acme', repo: 'demo' },
    headName: 'feature/x',
    baseName: 'main',
    repoToken: 'tok',
    createGithubPullRequestFn: async () => ({
      ok: false,
      status: 422,
      json: null,
      text: 'Validation Failed',
    }),
  });
  assert.equal(out.ok, false);
  assert.match(String(out.pr_error || ''), /main:.*master:/);
});
