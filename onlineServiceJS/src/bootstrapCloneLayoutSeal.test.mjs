import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReposLayoutReadyForJobs,
  isBootstrapReposLayoutReady,
  setBootstrapReposLayoutReady,
} from './bootstrapCloneLayoutSeal.mjs';

test('默认未密封；set 后可读', () => {
  setBootstrapReposLayoutReady(false);
  assert.equal(isBootstrapReposLayoutReady(), false);
  setBootstrapReposLayoutReady(true);
  assert.equal(isBootstrapReposLayoutReady(), true);
  setBootstrapReposLayoutReady(false);
});

test('assertReposLayoutReadyForJobs: 无 git 时提示先克隆', () => {
  setBootstrapReposLayoutReady(true);
  assert.throws(() => assertReposLayoutReadyForJobs(false), /请先完成「克隆仓库」/);
});

test('assertReposLayoutReadyForJobs: enforceSeal 且未密封时拒绝建任务', () => {
  setBootstrapReposLayoutReady(false);
  assert.throws(
    () => assertReposLayoutReadyForJobs(true, { enforceSeal: true }),
    /克隆层布局尚未锁定/,
  );
});

test('assertReposLayoutReadyForJobs: 无 enforceSeal 时不拦未密封（单测兼容）', () => {
  setBootstrapReposLayoutReady(false);
  assert.doesNotThrow(() => assertReposLayoutReadyForJobs(true));
});

test('assertReposLayoutReadyForJobs: enforceSeal 且已密封通过', () => {
  setBootstrapReposLayoutReady(true);
  assert.doesNotThrow(() => assertReposLayoutReadyForJobs(true, { enforceSeal: true }));
  setBootstrapReposLayoutReady(false);
});
