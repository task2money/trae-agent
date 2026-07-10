// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rememberStaleAccessToken,
  isRememberedStaleAccessToken,
  resolveUiPathAccessToken,
  clearRememberedStaleAccessTokensForTest,
} from './uiAccessToken.mjs';

test.beforeEach(() => {
  clearRememberedStaleAccessTokensForTest();
});

test('resolveUiPathAccessToken: 当前 token 直接放行', () => {
  const r = resolveUiPathAccessToken('tok-new', 'tok-new');
  assert.deepEqual(r, { ok: true, serveToken: 'tok-new' });
});

test('resolveUiPathAccessToken: 已记住的旧 token 重定向到当前', () => {
  rememberStaleAccessToken('tok-bootstrap');
  const r = resolveUiPathAccessToken('tok-bootstrap', 'tok-new');
  assert.equal(r.ok, false);
  assert.equal(r.redirectTo, '/ui/tok-new');
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
