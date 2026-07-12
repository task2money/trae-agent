// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScopedUiPath,
  resolveUiScopeFromEnv,
  extractAccessTokenFromUiPathname,
  parseTenantWorkspaceTaskFromPath,
} from './scopedUiPath.mjs';

const KEYS = [
  'tenantId',
  'workspaceId',
  'taskId',
  'TaskApiEndPoint',
  'TASK_API_ENDPOINT',
];

function snapshotEnv() {
  /** @type {Record<string, string|undefined>} */
  const o = {};
  for (const k of KEYS) o[k] = process.env[k];
  return o;
}

function restoreEnv(saved) {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

test('buildScopedUiPath: 有 scope 时含三 ID', () => {
  const path = buildScopedUiPath('tok_abc', {
    tenantId: 't1',
    workspaceId: 'w1',
    taskId: 'task_1',
  });
  assert.equal(path, '/ui/tenant/t1/workspace/w1/task/task_1/tok_abc');
});

test('buildScopedUiPath: 无 scope 回退 /ui/{token}', () => {
  assert.equal(buildScopedUiPath('tok_x', null), '/ui/tok_x');
});

test('buildScopedUiPath: 对 token 做 encodeURIComponent', () => {
  const path = buildScopedUiPath('a/b', {
    tenantId: 't',
    workspaceId: 'w',
    taskId: 'task',
  });
  assert.equal(path, '/ui/tenant/t/workspace/w/task/task/a%2Fb');
});

test('resolveUiScopeFromEnv: 读环境变量', () => {
  const saved = snapshotEnv();
  try {
    process.env.tenantId = '850';
    process.env.workspaceId = '861';
    process.env.taskId = 'task_129';
    delete process.env.TaskApiEndPoint;
    delete process.env.TASK_API_ENDPOINT;
    assert.deepEqual(resolveUiScopeFromEnv(), {
      tenantId: '850',
      workspaceId: '861',
      taskId: 'task_129',
    });
  } finally {
    restoreEnv(saved);
  }
});

test('resolveUiScopeFromEnv: 从 TaskApiEndPoint 解析', () => {
  const saved = snapshotEnv();
  try {
    delete process.env.tenantId;
    delete process.env.workspaceId;
    delete process.env.taskId;
    process.env.TaskApiEndPoint =
      'https://agentsupport.api.example/api/tenant/tA/workspace/wB/task/taskC/cloud';
    assert.deepEqual(resolveUiScopeFromEnv(), {
      tenantId: 'tA',
      workspaceId: 'wB',
      taskId: 'taskC',
    });
  } finally {
    restoreEnv(saved);
  }
});

test('extractAccessTokenFromUiPathname: scoped + 旧 path', () => {
  assert.equal(
    extractAccessTokenFromUiPathname('/ui/tenant/t/workspace/w/task/task1/tok_x'),
    'tok_x',
  );
  assert.equal(
    extractAccessTokenFromUiPathname(
      '/ui/tenant/t/workspace/w/task/task1/tok_x/render-hints',
    ),
    'tok_x',
  );
  assert.equal(extractAccessTokenFromUiPathname('/ui/tok_legacy'), 'tok_legacy');
  assert.equal(
    extractAccessTokenFromUiPathname('/ui/tok_legacy/render-hints'),
    'tok_legacy',
  );
});

test('parseTenantWorkspaceTaskFromPath: UI scoped', () => {
  assert.deepEqual(
    parseTenantWorkspaceTaskFromPath(
      '/ui/tenant/t1/workspace/w1/task/task1/tok',
    ),
    { tenant: 't1', workspace: 'w1', task: 'task1' },
  );
});
