// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import {
  recordJobEvent,
  flushPendingJobStreamChunks,
} from './saasJobStreamPush.mjs';

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

const KEYS = [
  'TaskApiEndPoint',
  'TASK_API_ENDPOINT',
  'ACCESS_TOKEN',
  'TASK_JOB_STREAM_CHUNK_FLUSH_MS',
  'TASK_JOB_STREAM_CHUNK_MAX_CHARS',
  'TRAE_SKIP_SAAS_JOB_STREAM_PUSH',
  'tenantId',
  'workspaceId',
  'taskId',
];

function startJobStreamServer() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, bodies });
    });
  });
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCount(bodies, count, timeoutMs = 2000) {
  const start = Date.now();
  while (bodies.length < count && Date.now() - start < timeoutMs) {
    await sleepMs(10);
  }
}

test('连续 chunk 在短窗口内合并为单次 job-stream-push POST', async () => {
  const saved = snapshotEnv(KEYS);
  const { server, port, bodies } = await startJobStreamServer();
  try {
    delete process.env.TASK_JOB_STREAM_CHUNK_FLUSH_MS;
    delete process.env.TASK_JOB_STREAM_CHUNK_MAX_CHARS;
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/comment/cmt-a/cloud`;
    process.env.ACCESS_TOKEN = 'chunk-test-token';
    const jobId = `job-debounce-${Date.now()}`;

    for (let i = 0; i < 10; i += 1) recordJobEvent(jobId, 'chunk', `line-${i}\n`);
    flushPendingJobStreamChunks();
    await waitForCount(bodies, 1);

    assert.strictEqual(bodies.length, 1, `expected 1 merged POST, got ${bodies.length}`);
    assert.strictEqual(bodies[0].job_id, jobId);
    assert.strictEqual(bodies[0].phase, 'chunk');
    assert.strictEqual(bodies[0].message, 'line-0\nline-1\nline-2\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9\n');
    assert.strictEqual(bodies[0].seq, 9); // 合并后取最新 seq
  } finally {
    restoreEnv(saved);
    flushPendingJobStreamChunks();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('step 不被吞：先 flush 待发 chunk 再立即推送 step', async () => {
  const saved = snapshotEnv(KEYS);
  const { server, port, bodies } = await startJobStreamServer();
  try {
    delete process.env.TASK_JOB_STREAM_CHUNK_FLUSH_MS;
    delete process.env.TASK_JOB_STREAM_CHUNK_MAX_CHARS;
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/comment/cmt-a/cloud`;
    process.env.ACCESS_TOKEN = 'chunk-step-token';
    const jobId = `job-step-${Date.now()}`;

    recordJobEvent(jobId, 'chunk', 'partial output');
    recordJobEvent(jobId, 'step', 'step 1 执行', { step_number: 1 });
    await waitForCount(bodies, 2);

    assert.strictEqual(bodies.length, 2);
    assert.strictEqual(bodies[0].phase, 'chunk');
    assert.strictEqual(bodies[0].message, 'partial output');
    assert.strictEqual(bodies[1].phase, 'step');
    assert.strictEqual(bodies[1].message, 'step 1 执行');
    assert.strictEqual(bodies[1].step_number, 1);
  } finally {
    restoreEnv(saved);
    flushPendingJobStreamChunks();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('chunk 超过字符上限立即 flush', async () => {
  const saved = snapshotEnv(KEYS);
  const { server, port, bodies } = await startJobStreamServer();
  try {
    process.env.TASK_JOB_STREAM_CHUNK_MAX_CHARS = '512';
    delete process.env.TASK_JOB_STREAM_CHUNK_FLUSH_MS;
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/comment/cmt-a/cloud`;
    process.env.ACCESS_TOKEN = 'chunk-max-token';
    const jobId = `job-max-${Date.now()}`;

    // 每段 100 字符，推 6 段即超过 512 → 立即 flush
    for (let i = 0; i < 6; i += 1) {
      recordJobEvent(jobId, 'chunk', 'x'.repeat(100));
    }
    await waitForCount(bodies, 1);

    assert.strictEqual(bodies.length, 1);
    assert.strictEqual(bodies[0].phase, 'chunk');
    assert.strictEqual(bodies[0].message.length, 600);
  } finally {
    restoreEnv(saved);
    flushPendingJobStreamChunks();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
