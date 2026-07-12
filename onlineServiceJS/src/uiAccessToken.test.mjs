// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rememberStaleAccessToken,
  isRememberedStaleAccessToken,
  resolveUiPathAccessToken,
  clearRememberedStaleAccessTokensForTest,
} from './uiAccessToken.mjs';

const SCOPE_KEYS = ['tenantId', 'workspaceId', 'taskId', 'TaskApiEndPoint', 'TASK_API_ENDPOINT'];

function snapshotEnv() {
  /** @type {Record<string, string|undefined>} */
  const o = {};
  for (const k of SCOPE_KEYS) o[k] = process.env[k];
  return o;
}

function restoreEnv(saved) {
  for (const k of SCOPE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

test.beforeEach(() => {
  clearRememberedStaleAccessTokensForTest();
});

test('resolveUiPathAccessToken: 当前 token 直接放行', () => {
  const r = resolveUiPathAccessToken('tok-new', 'tok-new');
  assert.deepEqual(r, { ok: true, serveToken: 'tok-new' });
});

test('resolveUiPathAccessToken: 已记住的旧 token 重定向到 scoped path', () => {
  const saved = snapshotEnv();
  try {
    process.env.tenantId = 't1';
    process.env.workspaceId = 'w1';
    process.env.taskId = 'task1';
    delete process.env.TaskApiEndPoint;
    delete process.env.TASK_API_ENDPOINT;
    rememberStaleAccessToken('tok-bootstrap');
    const r = resolveUiPathAccessToken('tok-bootstrap', 'tok-new');
    assert.equal(r.ok, false);
    assert.equal(r.redirectTo, '/ui/tenant/t1/workspace/w1/task/task1/tok-new');
  } finally {
    restoreEnv(saved);
  }
});

test('resolveUiPathAccessToken: 无 scope 时旧 token 重定向到 /ui/{current}', () => {
  const saved = snapshotEnv();
  try {
    delete process.env.tenantId;
    delete process.env.workspaceId;
    delete process.env.taskId;
    delete process.env.TaskApiEndPoint;
    delete process.env.TASK_API_ENDPOINT;
    rememberStaleAccessToken('tok-bootstrap');
    const r = resolveUiPathAccessToken('tok-bootstrap', 'tok-new');
    assert.equal(r.ok, false);
    assert.equal(r.redirectTo, '/ui/tok-new');
  } finally {
    restoreEnv(saved);
  }
});

test('resolveUiPathAccessToken: 未知旧 token 401', () => {
  const r = resolveUiPathAccessToken('tok-random', 'tok-new');
  assert.deepEqual(r, { ok: false, unauthorized: true });
});

test('isRememberedStaleAccessToken', () => {
  assert.equal(isRememberedStaleAccessToken('x'), false);
  rememberStaleAccessToken('x');
  assert.equal(isRememberedStaleAccessToken('x'), true);
});
