// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { listAgentStepFullDocsFromTaeJsonDir } from './jobStepEvents.mjs';
import { archiveJobStepFullToSaas } from './saasStepFullArchive.mjs';

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
  'TRAE_SKIP_SAAS_STEP_FULL_ARCHIVE',
  'ONLINE_PROJECT_STATE_ROOT',
];

test('listAgentStepFullDocsFromTaeJsonDir 读出 agent_step_full.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tae-json-'));
  const s1 = path.join(root, 'step_1');
  fs.mkdirSync(s1);
  fs.writeFileSync(
    path.join(s1, 'agent_step_full.json'),
    JSON.stringify({ type: 'agent_step_full', step_number: 1, delivery_summary: 'think', llm: { n: 1 } }),
  );
  const docs = listAgentStepFullDocsFromTaeJsonDir(root);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].delivery_summary, 'think');
  assert.equal(docs[0].llm.n, 1);
});

test('archiveJobStepFullToSaas：POST job-step-full-push 含 steps 全文', async () => {
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
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'online-state-'));
  const taeDir = path.join(stateRoot, 'runtime', 'job_logs', 'trae_agent_json', 'Jfull');
  fs.mkdirSync(path.join(taeDir, 'step_1'), { recursive: true });
  fs.writeFileSync(
    path.join(taeDir, 'step_1', 'agent_step_full.json'),
    JSON.stringify({ step_number: 1, delivery_summary: 'bash ls', output: 'ok' }),
  );
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    delete process.env.TRAE_SKIP_SAAS_STEP_FULL_ARCHIVE;
    process.env.ONLINE_PROJECT_STATE_ROOT = stateRoot;
    process.env.tenantId = 'ta';
    process.env.workspaceId = 'ws1';
    process.env.taskId = 'td1';
    process.env.COMMENT_ID = 'cmt-a';
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/comment/cmt-a/cloud`;
    process.env.ACCESS_TOKEN = 'js-test-token';
    const ok = await archiveJobStepFullToSaas({ id: 'Jfull', status: 'completed', layer_id: 'L1' });
    assert.strictEqual(ok, true);
    assert.ok(reqUrl.includes('/server-container-token/job-step-full-push/'), `path=${reqUrl}`);
    const body = JSON.parse(received);
    assert.strictEqual(body.access_token, 'js-test-token');
    assert.strictEqual(body.job_id, 'Jfull');
    assert.strictEqual(body.comment_id, 'cmt-a');
    assert.ok(Array.isArray(body.steps));
    assert.strictEqual(body.steps[0].output, 'ok');
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(resolve));
  }
});
