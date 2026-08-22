import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOauthAccessPushAuthFromTokenPayload } from './layerGitOauthPushAuthMaps.mjs';

test('GitLab match-key 字符串图转为 oauth_auth_by_repo，不占用 github slug 图', () => {
  const origin = 'https://gitlab-tencent-sh-1.aidevpush.com/ljy124818167/somanyad.git';
  const matchKey = 'gitlab-tencent-sh-1.aidevpush.com/ljy124818167/somanyad';
  const auth = buildOauthAccessPushAuthFromTokenPayload(
    {
      github_auth_by_repo: { 'ljy124818167/somanyad': 'glpat-from-slug' },
      git_auth_by_repo_match_key: { [matchKey]: 'glpat-from-match' },
    },
    'layer-1',
    {
      collectOauthRepoWriteTargets: () => [
        {
          originUrl: origin,
          repoMatchKey: matchKey,
          githubSlug: '',
        },
      ],
    },
  );
  assert.equal(auth.accessTokenByRepoSlug['ljy124818167/somanyad'], 'glpat-from-slug');
  const byUrl = auth.oauthAuthByRepo['https://gitlab-tencent-sh-1.aidevpush.com/ljy124818167/somanyad'];
  const byMatch = auth.oauthAuthByRepo[matchKey];
  assert.equal(byUrl?.provider, 'gitlab');
  assert.equal(byUrl?.access_token, 'glpat-from-match');
  assert.equal(byMatch?.provider, 'gitlab');
  assert.equal(byMatch?.access_token, 'glpat-from-match');
});

test('仅 github_auth_by_repo 的 GitHub 仓不伪造 gitlab provider', () => {
  const auth = buildOauthAccessPushAuthFromTokenPayload(
    { github_auth_by_repo: { 'acme/demo': 'gho_x' } },
    'layer-2',
    {
      collectOauthRepoWriteTargets: () => [
        {
          originUrl: 'https://github.com/acme/demo.git',
          repoMatchKey: 'github.com/acme/demo',
          githubSlug: 'acme/demo',
        },
      ],
    },
  );
  assert.equal(auth.accessTokenByRepoSlug['acme/demo'], 'gho_x');
  assert.equal(auth.oauthAuthByRepo['https://github.com/acme/demo']?.provider, 'github');
});
