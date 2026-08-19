// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import {
  postJson,
  postJsonTransientRetryConfigFromEnv,
} from './saasPostJson.mjs';

function snapshotEnv(keys) {
  const out = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

function restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = [
  'TaskApiEndPoint',
  'TASK_API_ENDPOINT',
  'TASK_API_POST_JSON_TRANSIENT_RETRIES',
  'TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS',
  'TRAE_SKIP_PROACTIVE_ACCESS_REFRESH',
  'TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE',
  'ACCESS_TOKEN',
];

/** 起一个只记录请求、按队列返回指定响应的本地 HTTP server。 */
function startServer(responses, onBody) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      received.push(text ? JSON.parse(text) : {});
      if (onBody) onBody(text);
      const spec = responses.length ? responses.shift() : { status: 200, body: {} };
      res.writeHead(spec.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(spec.body));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, received });
    });
  });
}

test('postJson 无 on401Refresh 时 401 不盲重试（仅 1 次请求）', async () => {
  const saved = snapshotEnv(ENV_KEYS);
  const { server, port, received } = await startServer([
    { status: 401, body: { error_code: 'UNAUTHORIZED' } },
  ]);
  try {
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/t1`;
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/server-container-token/heartbeat/`,
          { access_token: 'old-token' },
          2,
          { on401Refresh: false },
        ),
      /HTTP 401/,
    );
    assert.strictEqual(received.length, 1);
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('postJson 401 走 on401Refresh 换新 token 后重试一次成功', async () => {
  const saved = snapshotEnv(ENV_KEYS);
  let refreshCalls = 0;
  const { server, port, received } = await startServer([
    { status: 401, body: { error_code: 'UNAUTHORIZED' } },
    { status: 200, body: { ok: true } },
  ]);
  try {
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/t1`;
    const data = await postJson(
      `http://127.0.0.1:${port}/server-container-token/heartbeat/`,
      { access_token: 'old-token', message: 'ping' },
      2,
      {
        on401Refresh: async () => {
          refreshCalls += 1;
          return 'new-token';
        },
      },
    );
    assert.deepStrictEqual(data, { ok: true });
    assert.strictEqual(refreshCalls, 1);
    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].access_token, 'old-token');
    assert.strictEqual(received[1].access_token, 'new-token');
    assert.strictEqual(received[1].message, 'ping');
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('postJson 401 刷新返回 null 时不盲重试', async () => {
  const saved = snapshotEnv(ENV_KEYS);
  const { server, port, received } = await startServer([
    { status: 401, body: { error_code: 'UNAUTHORIZED' } },
  ]);
  try {
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/t1`;
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/server-container-token/heartbeat/`,
          { access_token: 'old-token' },
          2,
          { on401Refresh: async () => null },
        ),
      /HTTP 401/,
    );
    assert.strictEqual(received.length, 1);
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('postJson 默认瞬时重试窗口覆盖连续 404（旧 5 次会放弃、新窗口内成功）', async () => {
  const saved = snapshotEnv(ENV_KEYS);
  // 前 5 次 404（旧窗口就会放弃），第 6 次成功——证明新默认窗口 > 5
  const responses = [];
  for (let i = 0; i < 5; i += 1) responses.push({ status: 404, body: {} });
  responses.push({ status: 200, body: { ok: true } });
  const { server, port, received } = await startServer(responses);
  try {
    delete process.env.TASK_API_POST_JSON_TRANSIENT_RETRIES;
    delete process.env.TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS;
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/t1`;
    const cfg = postJsonTransientRetryConfigFromEnv();
    assert.ok(cfg.maxAttempts >= 10, `default maxAttempts should cover ~30s, got ${cfg.maxAttempts}`);
    const data = await postJson(
      `http://127.0.0.1:${port}/server-container-token/heartbeat/`,
      { access_token: 'tok' },
      2,
    );
    assert.deepStrictEqual(data, { ok: true });
    assert.strictEqual(received.length, 6);
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('postJson 非 2xx 失败携带响应头 X-Trace-Id（OPT-20260819-044）', async () => {
  const saved = snapshotEnv(ENV_KEYS);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'X-Trace-Id': 'trace-header-1',
      });
      res.end('{}');
    });
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  try {
    process.env.TASK_API_POST_JSON_TRANSIENT_RETRIES = '1';
    process.env.TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS = '0';
    await assert.rejects(
      () => postJson(`http://127.0.0.1:${port}/server-container-token/repo-clone-credentials/`, { access_token: 'tok' }, 2),
      (err) => {
        assert.strictEqual(err.responseTraceId, 'trace-header-1');
        return true;
      },
    );
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('postJsonTransientRetryConfigFromEnv 默认 15 次/400ms，环境变量可覆盖', () => {
  const saved = snapshotEnv(ENV_KEYS);
  try {
    delete process.env.TASK_API_POST_JSON_TRANSIENT_RETRIES;
    delete process.env.TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS;
    const cfg = postJsonTransientRetryConfigFromEnv();
    assert.strictEqual(cfg.maxAttempts, 15);
    assert.strictEqual(cfg.backoffMs, 400);

    process.env.TASK_API_POST_JSON_TRANSIENT_RETRIES = '3';
    process.env.TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS = '120';
    const overridden = postJsonTransientRetryConfigFromEnv();
    assert.strictEqual(overridden.maxAttempts, 3);
    assert.strictEqual(overridden.backoffMs, 120);
  } finally {
    restoreEnv(saved);
  }
});
