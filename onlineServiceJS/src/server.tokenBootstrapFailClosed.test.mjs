import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ONLINE_SERVICE_JS_SKIP_MAIN = '1';

const { main } = await import('./server.mjs');
const {
  isTokenBootstrapFailed,
  setTokenBootstrapFailed,
  getTokenBootstrapFailReason,
} = await import('./auth.mjs');

test.afterEach(() => {
  setTokenBootstrapFailed(false);
  delete process.env.TASK_API_BOOTSTRAP_STRICT_STARTUP;
});

test('换票抛错且非 strict：启用 fail-closed（tokenExchangeFailed），不 exit', async () => {
  const prevStrict = process.env.TASK_API_BOOTSTRAP_STRICT_STARTUP;
  delete process.env.TASK_API_BOOTSTRAP_STRICT_STARTUP;
  try {
    await main({
      appendInitLog: () => ({ ok: true }),
      runBootstrapTokenExchangeOnlyFn: async () => {
        throw new Error('HTTP 401 TOKEN_ACCESS_INVALID');
      },
      startSsePingLoop: () => {},
      stopAfterBootstrapTokenExchangeOnly: true,
    });
    assert.equal(isTokenBootstrapFailed(), true);
    assert.match(getTokenBootstrapFailReason(), /TOKEN_ACCESS_INVALID/);
  } finally {
    if (prevStrict == null) delete process.env.TASK_API_BOOTSTRAP_STRICT_STARTUP;
    else process.env.TASK_API_BOOTSTRAP_STRICT_STARTUP = prevStrict;
  }
});

test('intentional skip（无 TaskApi）不启用 fail-closed', async () => {
  setTokenBootstrapFailed(false);
  await main({
    appendInitLog: () => ({ ok: true }),
    runBootstrapTokenExchangeOnlyFn: async () => ({ skipped: true }),
    startSsePingLoop: () => {},
    stopAfterBootstrapTokenExchangeOnly: true,
  });
  assert.equal(isTokenBootstrapFailed(), false);
});

test('换票成功不启用 fail-closed', async () => {
  setTokenBootstrapFailed(false);
  await main({
    appendInitLog: () => ({ ok: true }),
    runBootstrapTokenExchangeOnlyFn: async () => ({
      skipped: false,
      prefix: 'http://example/api/cloud',
      newAccess: 'fresh',
      timeout: 5,
    }),
    startSsePingLoop: () => {},
    stopAfterBootstrapTokenExchangeOnly: true,
  });
  assert.equal(isTokenBootstrapFailed(), false);
});
