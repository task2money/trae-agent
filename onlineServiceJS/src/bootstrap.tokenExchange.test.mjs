import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test, { mock } from 'node:test';

import {
  PersistedRefreshTokenStoreError,
  clearPersistedRefreshToken,
  containerRefreshTokenStorePath,
  formatTokenExchangeFailureLog,
  isExchangeRefreshFallbackEligibleError,
  isExchangeRefreshForbiddenError,
  isExchangeRefreshInvalidAccessError,
  isPersistedRefreshTokenStoreError,
  readPersistedRefreshToken,
  writePersistedRefreshToken,
} from './bootstrap.mjs';

const ENV_KEYS = ['ONLINE_PROJECT_STATE_ROOT', 'taskId', 'TASK_ID', 'CONTAINER_REFRESH_TOKEN'];

function snapshotEnv() {
  const out = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}

function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('isExchangeRefreshForbiddenError detects exchange-refresh 403 hint', () => {
  const err = new Error(
    'HTTP 403 http://api.example/cloud/server-container-token/exchange-refresh/: {"detail":"预埋 AccessToken 仅可用于首次换取 RefreshToken，请使用 server-container-token/refresh-access/ 接口"}',
  );
  assert.equal(isExchangeRefreshForbiddenError(err), true);
});

test('isExchangeRefreshForbiddenError detects TOKEN_EXCHANGE_ALREADY_DONE without refresh-access text', () => {
  const err = new Error(
    'HTTP 403 http://api.example/cloud/server-container-token/exchange-refresh/: {"detail":"预埋 AccessToken 仅可用于首次换取 RefreshToken","error_code":"TOKEN_EXCHANGE_ALREADY_DONE"}',
  );
  err.structuredPayload = {
    detail: '预埋 AccessToken 仅可用于首次换取 RefreshToken',
    error_code: 'TOKEN_EXCHANGE_ALREADY_DONE',
  };
  assert.equal(isExchangeRefreshForbiddenError(err), true);
  assert.equal(isExchangeRefreshFallbackEligibleError(err), true);
});

test('isExchangeRefreshForbiddenError ignores unrelated 403', () => {
  const err = new Error('HTTP 403 http://api.example/forbidden/: {"detail":"forbidden"}');
  assert.equal(isExchangeRefreshForbiddenError(err), false);
});

test('isExchangeRefreshInvalidAccessError detects exchange-refresh 401 TOKEN_ACCESS_INVALID', () => {
  const err = new Error(
    'HTTP 401 http://api.example/cloud/server-container-token/exchange-refresh/: {"detail":"无效的 access_token","error_code":"TOKEN_ACCESS_INVALID"}',
  );
  err.structuredPayload = { detail: '无效的 access_token', error_code: 'TOKEN_ACCESS_INVALID' };
  assert.equal(isExchangeRefreshInvalidAccessError(err), true);
  assert.equal(isExchangeRefreshFallbackEligibleError(err), true);
  assert.equal(isExchangeRefreshForbiddenError(err), false);
});

test('isExchangeRefreshInvalidAccessError ignores unrelated 401', () => {
  const err = new Error('HTTP 401 http://api.example/other/: {"detail":"unauthorized"}');
  assert.equal(isExchangeRefreshInvalidAccessError(err), false);
  assert.equal(isExchangeRefreshFallbackEligibleError(err), false);
});

test('isExchangeRefreshFallbackEligibleError covers 403 already-exchanged', () => {
  const err = new Error(
    'HTTP 403 http://api.example/cloud/server-container-token/exchange-refresh/: {"detail":"请使用 server-container-token/refresh-access/ 接口","error_code":"TOKEN_EXCHANGE_ALREADY_DONE"}',
  );
  assert.equal(isExchangeRefreshFallbackEligibleError(err), true);
});

test('writePersistedRefreshToken / readPersistedRefreshToken round-trip under runtimeDir', () => {
  const saved = snapshotEnv();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-token-persist-'));
  const taskId = 'task_persist_api';
  process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
  process.env.taskId = taskId;
  delete process.env.CONTAINER_REFRESH_TOKEN;

  try {
    const storePath = writePersistedRefreshToken({
      refreshToken: 'refresh_persisted_ok',
      accessToken: 'access_after_refresh',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    assert.equal(storePath, containerRefreshTokenStorePath());
    assert.ok(fs.existsSync(storePath));

    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(data.task_id, taskId);
    assert.equal(data.refresh_token, 'refresh_persisted_ok');
    assert.equal(data.access_token, 'access_after_refresh');
    assert.equal(data.expires_at, '2099-01-01T00:00:00Z');

    assert.equal(readPersistedRefreshToken(), 'refresh_persisted_ok');
  } finally {
    restoreEnv(saved);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('writePersistedRefreshToken throws PersistedRefreshTokenStoreError on disk failure', () => {
  const saved = snapshotEnv();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-token-persist-fail-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
  process.env.taskId = 'task_persist_fail';
  delete process.env.CONTAINER_REFRESH_TOKEN;

  const writeMock = mock.method(fs, 'writeFileSync', () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  });

  try {
    assert.throws(
      () => writePersistedRefreshToken({ refreshToken: 'refresh_should_fail' }),
      (err) => {
        assert.equal(isPersistedRefreshTokenStoreError(err), true);
        assert.equal(err instanceof PersistedRefreshTokenStoreError, true);
        assert.equal(err.code, 'TOKEN_PERSIST_FAILED');
        assert.match(String(err.message), /token-persist: FAIL write/);
        assert.match(String(err.message), /EACCES/);
        assert.ok(String(err.storePath).endsWith('container_refresh_token.json'));
        // 与令牌无效类错误可区分
        assert.equal(/TOKEN_ACCESS_INVALID|无效的 access_token/i.test(String(err.message)), false);
        return true;
      },
    );
  } finally {
    writeMock.mock.restore();
    restoreEnv(saved);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('isPersistedRefreshTokenStoreError distinguishes persist vs token-invalid errors', () => {
  const persist = new PersistedRefreshTokenStoreError('token-persist: FAIL write /tmp/x: EACCES', {
    storePath: '/tmp/x',
  });
  const tokenInvalid = new Error('HTTP 401: {"detail":"无效的 access_token","error_code":"TOKEN_ACCESS_INVALID"}');
  assert.equal(isPersistedRefreshTokenStoreError(persist), true);
  assert.equal(isPersistedRefreshTokenStoreError(tokenInvalid), false);
  assert.equal(isPersistedRefreshTokenStoreError({ code: 'TOKEN_PERSIST_FAILED' }), true);
});

test('formatTokenExchangeFailureLog tags persist failures separately from token invalid', () => {
  const persist = new PersistedRefreshTokenStoreError('token-persist: FAIL write /tmp/x: EACCES', {
    storePath: '/tmp/x',
  });
  const tokenInvalid = new Error('HTTP 401: {"detail":"无效的 access_token","error_code":"TOKEN_ACCESS_INVALID"}');
  const persistLine = formatTokenExchangeFailureLog(persist);
  const invalidLine = formatTokenExchangeFailureLog(tokenInvalid);
  assert.match(persistLine, /^token-exchange: FAIL_PERSIST error_code=TOKEN_PERSIST_FAILED /);
  assert.match(persistLine, /token-persist: FAIL write/);
  assert.match(invalidLine, /^token-exchange: FAIL /);
  assert.equal(/FAIL_PERSIST|TOKEN_PERSIST_FAILED/.test(invalidLine), false);
  assert.match(invalidLine, /TOKEN_ACCESS_INVALID/);
});

test('clearPersistedRefreshToken removes store file for external callers', () => {
  const saved = snapshotEnv();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-token-clear-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
  process.env.taskId = 'task_clear_api';
  delete process.env.CONTAINER_REFRESH_TOKEN;

  try {
    const storePath = writePersistedRefreshToken({ refreshToken: 'rt_to_clear' });
    assert.ok(fs.existsSync(storePath));
    assert.equal(storePath, containerRefreshTokenStorePath());
    clearPersistedRefreshToken();
    assert.equal(fs.existsSync(storePath), false);
    // idempotent
    clearPersistedRefreshToken();
    assert.equal(readPersistedRefreshToken(), '');
  } finally {
    restoreEnv(saved);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
