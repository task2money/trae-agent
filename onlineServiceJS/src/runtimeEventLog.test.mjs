import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { emitRuntimeEvent, postRuntimeEventToSaas, RUNTIME_EVENT_NAMES } from './runtimeEventLog.mjs';

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
const ENV_KEYS = ['TaskApiEndPoint', 'TASK_API_ENDPOINT', 'ACCESS_TOKEN', 'tenantId', 'workspaceId', 'taskId'];

function startServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, received });
    });
  });
}

test('RUNTIME_EVENT_NAMES includes bootstrap and auto_run keys', () => {
  assert.ok(RUNTIME_EVENT_NAMES.has('BOOTSTRAP_COMPLETE'));
  assert.ok(RUNTIME_EVENT_NAMES.has('AUTO_RUN_FIRST_INSTRUCTION_START'));
  assert.ok(RUNTIME_EVENT_NAMES.has('AUTO_RUN_FIRST_SKIP'));
  assert.ok(RUNTIME_EVENT_NAMES.has('AGENT_KICKOFF_DEFERRED'));
  assert.ok(RUNTIME_EVENT_NAMES.has('AGENT_KICKOFF_RESUME'));
  assert.ok(RUNTIME_EVENT_NAMES.has('AUTO_RUN_GIT_PR_REPLY_OK'));
  assert.ok(RUNTIME_EVENT_NAMES.has('AUTO_RUN_GIT_PR_REPLY_FAILED'));
  assert.ok(RUNTIME_EVENT_NAMES.has('CONTAINER_AGENT_COMMENT_CREATED'));
});

test('emitRuntimeEvent posts allowed events via postFn', async () => {
  const calls = [];
  emitRuntimeEvent('BOOTSTRAP_PHASE', {
    phase: 'clone_begin',
    message: 'start clone',
    fields: { layer_id: 'L' },
    postFn: async (p) => {
      calls.push(p);
      return true;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'BOOTSTRAP_PHASE');
  assert.equal(calls[0].phase, 'clone_begin');
});

test('emitRuntimeEvent ignores unsupported event names', async () => {
  let called = 0;
  emitRuntimeEvent('NOPE', {
    postFn: async () => {
      called += 1;
      return true;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, 0);
});

// OPT-20260819-044: BOOTSTRAP_FAILED 透传 trace_id（克隆凭证 502 的 X-Trace-Id）
test('emitRuntimeEvent passes trace_id to postFn payload', async () => {
  const calls = [];
  emitRuntimeEvent('BOOTSTRAP_FAILED', {
    level: 'error',
    phase: 'task_detail_or_credentials',
    message: 'repo-clone-credentials 502',
    trace_id: 'resp-trace-abc',
    postFn: async (p) => {
      calls.push(p);
      return true;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trace_id, 'resp-trace-abc');
});

// OPT-20260819-044: runtime-event POST body 必须含 trace_id，供 Cloud firstNonEmptyTraceID 读取
test('postRuntimeEventToSaas writes trace_id into body', async () => {
  const saved = snapshotEnv(ENV_KEYS);
  const { server, port, received } = await startServer();
  try {
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/t1/comment/c1/cloud`;
    process.env.ACCESS_TOKEN = 'tok';
    const ok = await postRuntimeEventToSaas({
      event: 'BOOTSTRAP_FAILED',
      level: 'error',
      phase: 'task_detail_or_credentials',
      message: 'boom',
      trace_id: 'trace-abc',
    });
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    const body = JSON.parse(received[0]);
    assert.equal(body.event, 'BOOTSTRAP_FAILED');
    assert.equal(body.trace_id, 'trace-abc');
  } finally {
    server.close();
    restoreEnv(saved);
  }
});

test('postRuntimeEventToSaas returns false without token/prefix', async () => {
  const prev = process.env.ACCESS_TOKEN;
  delete process.env.ACCESS_TOKEN;
  try {
    const ok = await postRuntimeEventToSaas({ event: 'BOOTSTRAP_COMPLETE' });
    assert.equal(ok, false);
  } finally {
    if (prev !== undefined) process.env.ACCESS_TOKEN = prev;
  }
});
