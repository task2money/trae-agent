// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import {
  publishLayerGraphSnapshotToSaas,
  startSaasLayerGraphPushLoop,
} from './saasTaskCloud.mjs';

function snapshotEnv(keys) {
  const out = {};
  for (const k of keys) {
    out[k] = process.env[k];
  }
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
  'TRAE_SKIP_SAAS_LAYER_GRAPH_PUSH',
  'TRAE_SAAS_LAYER_GRAPH_PUSH_INTERVAL_SEC',
  'TRAE_SAAS_LAYER_GRAPH_PUSH_INITIAL_DELAY_SEC',
];

test('publishLayerGraphSnapshotToSaas：POST layer-graph-push 且 body 含 layers/jobs', async () => {
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
      res.end(JSON.stringify({ ok: true, task_id: 'td1' }));
    });
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    delete process.env.tenantId;
    delete process.env.workspaceId;
    delete process.env.taskId;
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/cloud`;
    process.env.ACCESS_TOKEN = 'lg-test-token';
    const ok = await publishLayerGraphSnapshotToSaas({
      layers: [{ layer_id: 'L1' }],
      jobs: [{ id: 'J1' }],
      layers_root: '/tmp/layers',
      bootstrap_layer_id: 'L1',
    });
    assert.strictEqual(ok, true);
    assert.ok(reqUrl.includes('/server-container-token/layer-graph-push/'), `path=${reqUrl}`);
    const body = JSON.parse(received);
    assert.strictEqual(body.access_token, 'lg-test-token');
    assert.deepStrictEqual(body.layers, [{ layer_id: 'L1' }]);
    assert.deepStrictEqual(body.jobs, [{ id: 'J1' }]);
    assert.strictEqual(body.layers_root, '/tmp/layers');
    assert.strictEqual(body.bootstrap_layer_id, 'L1');
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('publishLayerGraphSnapshotToSaas：COMMENT_ID 写入 layer-graph-push body', async () => {
  const saved = snapshotEnv([...KEYS, 'COMMENT_ID', 'CONTAINER_NAME']);
  let received = '';
  const server = http.createServer((req, res) => {
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
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    delete process.env.tenantId;
    delete process.env.workspaceId;
    delete process.env.taskId;
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/cloud`;
    process.env.ACCESS_TOKEN = 'lg-cmt-token';
    process.env.COMMENT_ID = 'cmt-a';
    process.env.CONTAINER_NAME = 'task_td1_cmt-a';
    const ok = await publishLayerGraphSnapshotToSaas({ layers: [{ layer_id: 'L1' }], jobs: [] });
    assert.strictEqual(ok, true);
    const body = JSON.parse(received);
    assert.strictEqual(body.comment_id, 'cmt-a');
    assert.strictEqual(body.container_name, 'task_td1_cmt-a');
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('startSaasLayerGraphPushLoop：按间隔调用 getSnapshot 并推送', async () => {
  const saved = snapshotEnv(KEYS);
  let pushCount = 0;
  const server = http.createServer((req, res) => {
    if ((req.url || '').includes('layer-graph-push')) pushCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  let stop = () => {};
  try {
    delete process.env.TRAE_SKIP_SAAS_LAYER_GRAPH_PUSH;
    process.env.TRAE_SAAS_LAYER_GRAPH_PUSH_INITIAL_DELAY_SEC = '0';
    process.env.TRAE_SAAS_LAYER_GRAPH_PUSH_INTERVAL_SEC = '10';
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/cloud`;
    process.env.ACCESS_TOKEN = 'lg-loop-token';
    let snapCalls = 0;
    stop = startSaasLayerGraphPushLoop(() => {
      snapCalls += 1;
      return { layers: [{ layer_id: `L${snapCalls}` }], jobs: [] };
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(snapCalls >= 1, `snapCalls=${snapCalls}`);
    assert.ok(pushCount >= 1, `pushCount=${pushCount}`);
  } finally {
    stop();
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('startSaasLayerGraphPushLoop：TRAE_SKIP_SAAS_LAYER_GRAPH_PUSH 时不推送', async () => {
  const saved = snapshotEnv(KEYS);
  let snapCalls = 0;
  try {
    process.env.TRAE_SKIP_SAAS_LAYER_GRAPH_PUSH = '1';
    const stop = startSaasLayerGraphPushLoop(() => {
      snapCalls += 1;
      return { layers: [], jobs: [] };
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    assert.strictEqual(snapCalls, 0);
  } finally {
    restoreEnv(saved);
  }
});
