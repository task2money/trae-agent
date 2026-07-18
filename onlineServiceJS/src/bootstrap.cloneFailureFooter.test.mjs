import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatBootstrapCloneFailureFooter,
  resolveBootstrapCloneFailurePolicy,
} from './bootstrap.mjs';

test('formatBootstrapCloneFailureFooter: empty list still has 已结束（存在失败，引导继续）', () => {
  const out = formatBootstrapCloneFailureFooter([]);
  assert.match(out, /【项目克隆】已结束（存在失败，引导继续）。/);
  assert.doesNotMatch(out, /失败仓库（/);
});

test('formatBootstrapCloneFailureFooter: lists failed repo name, url and err', () => {
  const out = formatBootstrapCloneFailureFooter([
    {
      raw: 'https://gitlab.daydaymoney.com/ljy124818167/relayToTrae.git',
      repoDir: '/app/onlineProject_state/layers/x/relayToTrae',
      errMsg: 'git exit 128: repository not found',
    },
    {
      raw: 'https://gitlab.daydaymoney.com/ljy124818167/scripts.git',
      repoDir: '/app/onlineProject_state/layers/x/scripts',
      errMsg: 'fatal: not found',
    },
  ]);
  assert.match(out, /【项目克隆】已结束（存在失败，引导继续）。/);
  assert.match(out, /失败仓库（2）：/);
  assert.match(
    out,
    /- relayToTrae — https:\/\/gitlab\.daydaymoney\.com\/ljy124818167\/relayToTrae\.git（git exit 128/,
  );
  assert.match(
    out,
    /- scripts — https:\/\/gitlab\.daydaymoney\.com\/ljy124818167\/scripts\.git（fatal: not found）/,
  );
});

test('resolveBootstrapCloneFailurePolicy: never aborts bootstrap on partial or total clone failure', () => {
  const ok = resolveBootstrapCloneFailurePolicy({ failedCount: 0, totalCount: 3 });
  assert.equal(ok.abort, false);
  assert.equal(ok.level, 'ok');

  const partial = resolveBootstrapCloneFailurePolicy({
    failedCount: 1,
    totalCount: 5,
    failedNames: 'docs',
  });
  assert.equal(partial.abort, false);
  assert.equal(partial.level, 'partial');
  assert.match(partial.progressMessage, /部分失败/);
  assert.match(partial.progressMessage, /引导继续/);

  const allFailed = resolveBootstrapCloneFailurePolicy({
    failedCount: 3,
    totalCount: 3,
    failedNames: 'a、b、c',
  });
  assert.equal(allFailed.abort, false);
  assert.equal(allFailed.level, 'partial');
});

test('formatBootstrapCloneFailureFooter: omits empty err paren', () => {
  const out = formatBootstrapCloneFailureFooter([
    {
      raw: 'https://example.com/a/b.git',
      repoDir: '/tmp/b',
      errMsg: '',
    },
  ]);
  assert.match(out, /- b — https:\/\/example\.com\/a\/b\.git\n/);
  assert.doesNotMatch(out, /- b — https:\/\/example\.com\/a\/b\.git（/);
});
