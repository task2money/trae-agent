import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { postJson } from './saasTaskCloud.mjs';

const ENV_KEYS = [
  'DEBUG_AGENT',
  'ONLINE_PROJECT_STATE_ROOT',
  'TRACE_ID',
  'TASK_API_POST_JSON_TRANSIENT_RETRIES',
  'TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS',
  'COMMENT_ID',
  'CONTAINER_NAME',
];

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

function connRefusedError() {
  const err = new Error('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8011'), {
    code: 'ECONNREFUSED',
  });
  return err;
}

test('postJson 对 ECONNREFUSED 做瞬时重试后成功', async () => {
  const saved = snapshotEnv();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postjson-transient-'));
  let calls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls < 3) throw connRefusedError();
    return new Response(JSON.stringify({ ok: true, n: calls }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    process.env.DEBUG_AGENT = 'false';
    process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
    process.env.TASK_API_POST_JSON_TRANSIENT_RETRIES = '4';
    process.env.TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS = '10';
    delete process.env.TRACE_ID;

    const data = await postJson('http://127.0.0.1:8011/api/demo', { a: 1 }, 2);
    assert.deepEqual(data, { ok: true, n: 3 });
    assert.ok(calls >= 3, `expected >=3 fetch attempts, got ${calls}`);

    const logPath = path.join(stateRoot, 'reqLogs', 'outbound.log');
    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /transient retry/);
  } finally {
    fetchMock.mock.restore();
    restoreEnv(saved);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('postJson 瞬时重试耗尽后抛出原始网络错误', async () => {
  const saved = snapshotEnv();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postjson-transient-fail-'));
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw connRefusedError();
  });
  try {
    process.env.DEBUG_AGENT = 'false';
    process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
    process.env.TASK_API_POST_JSON_TRANSIENT_RETRIES = '2';
    process.env.TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS = '5';
    delete process.env.TRACE_ID;

    await assert.rejects(
      () => postJson('http://127.0.0.1:8011/api/demo', { a: 1 }, 2),
      (err) => {
        assert.match(String(err?.message || err), /ECONNREFUSED|fetch failed/i);
        return true;
      },
    );
  } finally {
    fetchMock.mock.restore();
    restoreEnv(saved);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('postJson 对业务 4xx 不重试', async () => {
  const saved = snapshotEnv();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postjson-no-retry-4xx-'));
  let calls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(JSON.stringify({ detail: 'bad token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    process.env.DEBUG_AGENT = 'false';
    process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
    process.env.TASK_API_POST_JSON_TRANSIENT_RETRIES = '4';
    process.env.TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS = '5';
    delete process.env.TRACE_ID;

    await assert.rejects(
      () => postJson('http://127.0.0.1:8011/api/demo', { a: 1 }, 2),
      /HTTP 401/,
    );
    assert.equal(calls, 1);
  } finally {
    fetchMock.mock.restore();
    restoreEnv(saved);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
