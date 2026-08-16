// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { publishJobStreamEventToSaas } from './saasTaskCloudJobStream.mjs';

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
  'tenantId',
  'workspaceId',
  'taskId',
  'ACCESS_TOKEN',
  'COMMENT_ID',
  'TRAE_SKIP_SAAS_JOB_STREAM_PUSH',
];

test('publishJobStreamEventToSaas：POST job-stream-push 含 job_id/phase/seq', async () => {
  const saved = snapshotEnv(KEYS);
  /** @type {string} */
  let received = '';
  /** @type {string} */
  let reqUrl = '';
  const server = http.createServer((req, res) => {
    reqUrl = req.url || '';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job_id: 'J1' }));
    });
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    delete process.env.TRAE_SKIP_SAAS_JOB_STREAM_PUSH;
    process.env.tenantId = 'ta';
    process.env.workspaceId = 'ws1';
    process.env.taskId = 'td1';
    process.env.COMMENT_ID = 'cmt-a';
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/comment/cmt-a/cloud`;
    process.env.ACCESS_TOKEN = 'js-test-token';
    const ok = await publishJobStreamEventToSaas({
      job_id: 'J1',
      phase: 'step',
      seq: 2,
      message: 'step 1: think',
      step_number: 1,
      delivery_summary: 'think',
      state: 'completed',
    });
    assert.strictEqual(ok, true);
    assert.ok(reqUrl.includes('/server-container-token/job-stream-push/'), `path=${reqUrl}`);
    const body = JSON.parse(received);
    assert.strictEqual(body.access_token, 'js-test-token');
    assert.strictEqual(body.job_id, 'J1');
    assert.strictEqual(body.phase, 'step');
    assert.strictEqual(body.seq, 2);
    assert.strictEqual(body.comment_id, 'cmt-a');
    assert.strictEqual(body.step_number, 1);
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(resolve));
  }
});
