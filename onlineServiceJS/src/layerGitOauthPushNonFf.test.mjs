// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gitPushHeadRetryOnNonFastForward,
  isGitNonFastForward,
} from './layerGitOauthPushNonFf.mjs';

test('isGitNonFastForward 识别 fetch first / rejected', () => {
  assert.equal(
    isGitNonFastForward(
      " ! [rejected]        HEAD -> feature/x (fetch first)\nerror: failed to push some refs",
    ),
    true,
  );
  assert.equal(isGitNonFastForward('non-fast-forward'), true);
  assert.equal(isGitNonFastForward('Authentication failed'), false);
});

test('gitPushHeadRetryOnNonFastForward: 首次 non-ff 后 fetch+rebase 再推成功', async () => {
  /** @type {string[][]} */
  const calls = [];
  let pushN = 0;
  await gitPushHeadRetryOnNonFastForward(
    async (args) => {
      calls.push(args);
      if (args[0] === 'push') {
        pushN += 1;
        if (pushN === 1) {
          throw new Error(' ! [rejected] HEAD -> feature/x (fetch first)');
        }
      }
    },
    {
      httpsRemote: 'https://gitlab.example/owner/repo.git',
      dstRef: 'refs/heads/feature/x',
      workdir: '/tmp/repo',
      env: {},
    },
  );
  assert.deepEqual(
    calls.map((a) => a[0]),
    ['push', 'fetch', 'rebase', 'push'],
  );
  assert.equal(calls[1][2], 'feature/x');
  assert.equal(calls[2][1], 'FETCH_HEAD');
});

test('gitPushHeadRetryOnNonFastForward: 非 non-ff 错误不 rebase', async () => {
  await assert.rejects(
    () =>
      gitPushHeadRetryOnNonFastForward(
        async () => {
          throw new Error('Authentication failed');
        },
        {
          httpsRemote: 'https://gitlab.example/owner/repo.git',
          dstRef: 'refs/heads/feature/x',
          workdir: '/tmp/repo',
          env: {},
        },
      ),
    /Authentication failed/,
  );
});
