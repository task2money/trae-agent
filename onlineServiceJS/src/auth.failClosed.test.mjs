import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authMiddleware,
  setTokenBootstrapFailed,
  isTokenBootstrapFailed,
  getTokenBootstrapFailReason,
  tokenBootstrapFailClosedDetail,
  respondTokenBootstrapFailClosed,
} from './auth.mjs';

function mockRes() {
  /** @type {{ statusCode?: number, body?: unknown }} */
  const state = {};
  const res = {
    status(code) {
      state.statusCode = code;
      return res;
    },
    json(body) {
      state.body = body;
      return res;
    },
  };
  return { res, state };
}

test.afterEach(() => {
  setTokenBootstrapFailed(false);
  delete process.env.ACCESS_TOKEN;
});

test('setTokenBootstrapFailed toggles fail-closed state and reason', () => {
  assert.equal(isTokenBootstrapFailed(), false);
  setTokenBootstrapFailed(true, 'exchange-refresh boom');
  assert.equal(isTokenBootstrapFailed(), true);
  assert.equal(getTokenBootstrapFailReason(), 'exchange-refresh boom');
  assert.match(tokenBootstrapFailClosedDetail(), /exchange-refresh boom/);
  setTokenBootstrapFailed(false);
  assert.equal(isTokenBootstrapFailed(), false);
  assert.equal(getTokenBootstrapFailReason(), '');
});

test('authMiddleware returns 503 TOKEN_BOOTSTRAP_FAILED when fail-closed', () => {
  process.env.ACCESS_TOKEN = 'stale-bootstrap-token';
  setTokenBootstrapFailed(true, 'HTTP 401 TOKEN_ACCESS_INVALID');
  const { res, state } = mockRes();
  let nextCalled = false;
  authMiddleware(
    { query: { access_token: 'stale-bootstrap-token' }, headers: {} },
    res,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 503);
  assert.equal(state.body?.error_code, 'TOKEN_BOOTSTRAP_FAILED');
  assert.match(String(state.body?.detail || ''), /token bootstrap failed/i);
  assert.match(String(state.body?.detail || ''), /TOKEN_ACCESS_INVALID/);
});

test('authMiddleware still validates token when not fail-closed', () => {
  process.env.ACCESS_TOKEN = 'good-token';
  setTokenBootstrapFailed(false);
  const { res, state } = mockRes();
  let nextCalled = false;
  authMiddleware(
    { query: { access_token: 'wrong' }, headers: {} },
    res,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);

  const ok = mockRes();
  authMiddleware(
    { query: { access_token: 'good-token' }, headers: {} },
    ok.res,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);
  assert.equal(ok.state.statusCode, undefined);
});

test('respondTokenBootstrapFailClosed emits stable error_code', () => {
  setTokenBootstrapFailed(true, 'no refresh');
  const { res, state } = mockRes();
  respondTokenBootstrapFailClosed(res);
  assert.equal(state.statusCode, 503);
  assert.equal(state.body?.error_code, 'TOKEN_BOOTSTRAP_FAILED');
});
