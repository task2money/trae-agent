import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONSERVATIVE_REFRESH_INTERVAL_MS,
  DEFAULT_PROACTIVE_REFRESH_SKEW_MS,
  accessTokenNeedsProactiveRefresh,
  maybeProactiveRefreshAccess,
  parseAccessExpiresAtMs,
  proactiveRefreshSkewMsFromEnv,
  shouldConservativeRefresh,
} from './proactiveAccessRefresh.mjs';

test('parseAccessExpiresAtMs parses credential UTC layout', () => {
  const ms = parseAccessExpiresAtMs('2026-07-19 12:00:32');
  assert.ok(Number.isFinite(ms));
  assert.equal(new Date(ms).toISOString(), '2026-07-19T12:00:32.000Z');
});

test('parseAccessExpiresAtMs returns NaN for empty/unparseable', () => {
  assert.ok(Number.isNaN(parseAccessExpiresAtMs('')));
  assert.ok(Number.isNaN(parseAccessExpiresAtMs('not-a-date')));
});

test('accessTokenNeedsProactiveRefresh false when expires unknown', () => {
  assert.equal(accessTokenNeedsProactiveRefresh(NaN, Date.now(), DEFAULT_PROACTIVE_REFRESH_SKEW_MS), false);
});

test('accessTokenNeedsProactiveRefresh false when remaining TTL above skew', () => {
  const now = Date.parse('2026-07-19T11:00:00.000Z');
  const expires = Date.parse('2026-07-19T12:00:00.000Z');
  assert.equal(accessTokenNeedsProactiveRefresh(expires, now, 5 * 60 * 1000), false);
});

test('accessTokenNeedsProactiveRefresh true when within skew', () => {
  const now = Date.parse('2026-07-19T11:56:00.000Z');
  const expires = Date.parse('2026-07-19T12:00:00.000Z');
  assert.equal(accessTokenNeedsProactiveRefresh(expires, now, 5 * 60 * 1000), true);
});

test('accessTokenNeedsProactiveRefresh true when already expired', () => {
  const now = Date.parse('2026-07-19T13:00:00.000Z');
  const expires = Date.parse('2026-07-19T12:00:00.000Z');
  assert.equal(accessTokenNeedsProactiveRefresh(expires, now, 5 * 60 * 1000), true);
});

test('shouldConservativeRefresh respects 50m interval', () => {
  const now = 10_000_000;
  assert.equal(shouldConservativeRefresh(0, now, CONSERVATIVE_REFRESH_INTERVAL_MS), true);
  assert.equal(
    shouldConservativeRefresh(now - CONSERVATIVE_REFRESH_INTERVAL_MS + 1, now, CONSERVATIVE_REFRESH_INTERVAL_MS),
    false,
  );
  assert.equal(
    shouldConservativeRefresh(now - CONSERVATIVE_REFRESH_INTERVAL_MS, now, CONSERVATIVE_REFRESH_INTERVAL_MS),
    true,
  );
});

test('proactiveRefreshSkewMsFromEnv defaults to 5 minutes', () => {
  const prev = process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC;
  delete process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC;
  try {
    assert.equal(proactiveRefreshSkewMsFromEnv(), DEFAULT_PROACTIVE_REFRESH_SKEW_MS);
  } finally {
    if (prev === undefined) delete process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC;
    else process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC = prev;
  }
});

test('proactiveRefreshSkewMsFromEnv reads TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC', () => {
  const prev = process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC;
  process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC = '120';
  try {
    assert.equal(proactiveRefreshSkewMsFromEnv(), 120_000);
  } finally {
    if (prev === undefined) delete process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC;
    else process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC = prev;
  }
});

test('maybeProactiveRefreshAccess refreshes when within skew', async () => {
  const calls = [];
  const persisted = [];
  const status = await maybeProactiveRefreshAccess({
    nowMs: Date.parse('2026-07-19T11:56:00.000Z'),
    skewMs: 5 * 60 * 1000,
    readStore: () => ({
      refreshToken: 'rt-1',
      expiresAt: '2026-07-19 12:00:00',
    }),
    taskPrefix: () => 'http://example/api/tenant/t/workspace/w/task/task1/cloud',
    refreshAccess: async (prefix, rt) => {
      calls.push({ prefix, rt });
      return { accessToken: 'at-new', expiresAt: '2026-07-19 13:00:00' };
    },
    persist: (t) => persisted.push(t),
    log: () => {},
  });
  assert.equal(status, 'refreshed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rt, 'rt-1');
  assert.equal(persisted[0].accessToken, 'at-new');
});

test('maybeProactiveRefreshAccess skips when TTL remaining above skew', async () => {
  let called = 0;
  const status = await maybeProactiveRefreshAccess({
    nowMs: Date.parse('2026-07-19T11:00:00.000Z'),
    skewMs: 5 * 60 * 1000,
    readStore: () => ({
      refreshToken: 'rt-1',
      expiresAt: '2026-07-19 12:00:00',
    }),
    taskPrefix: () => 'http://example/cloud',
    refreshAccess: async () => {
      called += 1;
      return { accessToken: 'x', expiresAt: '' };
    },
    persist: () => {},
    log: () => {},
  });
  assert.equal(status, 'skipped');
  assert.equal(called, 0);
});

test('maybeProactiveRefreshAccess conservative refresh when expires missing', async () => {
  let called = 0;
  const status = await maybeProactiveRefreshAccess({
    nowMs: 1_000_000,
    lastRefreshAtMs: 0,
    readStore: () => ({ refreshToken: 'rt-1', expiresAt: '' }),
    taskPrefix: () => 'http://example/cloud',
    refreshAccess: async () => {
      called += 1;
      return { accessToken: 'at-2', expiresAt: '2026-07-19 14:00:00' };
    },
    persist: () => {},
    log: () => {},
  });
  assert.equal(status, 'refreshed');
  assert.equal(called, 1);
});
