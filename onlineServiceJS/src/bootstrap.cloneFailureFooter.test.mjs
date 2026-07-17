import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBootstrapCloneFailureFooter } from './bootstrap.mjs';

test('formatBootstrapCloneFailureFooter: empty list still has 已结束（存在失败）', () => {
  const out = formatBootstrapCloneFailureFooter([]);
  assert.match(out, /【项目克隆】已结束（存在失败）。/);
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
  assert.match(out, /【项目克隆】已结束（存在失败）。/);
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
