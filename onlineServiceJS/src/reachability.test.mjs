// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'http';

import {
  isSaasColocatedWithContainer,
  reachabilityFromBusinessEndpointEnv,
  registerReachabilityAfterBootstrap,
  resolveReachableIp,
} from './reachability.mjs';

const KEYS = [
  'BusinessApiEndPoint',
  'BUSINESS_API_ENDPOINT',
  'DOCKER_GATEWAY_HOSTNAME',
  'DOCKER_HOST_GATEWAY_IP',
  'PORT',
  'TRAE_HOST_HTTP_PORT',
  'TRAE_SAAS_COLOCATED',
  'TRAE_REGISTER_LOOPBACK',
  'TRAE_PUBLIC_IP',
  'PUBLIC_IP',
  'TASK_API_ENDPOINT_ORIGIN',
  'TASK_API_ENDPOINT',
  'TaskApiEndPoint',
  'ACCESS_TOKEN',
  'TRAE_SKIP_REACHABILITY_REGISTER',
  'COMMENT_ID',
  'CONTAINER_NAME',
];

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

test('reachabilityFromBusinessEndpointEnv：域名 BUSINESS_API_ENDPOINT 直接用于注册', () => {
  const saved = snapshotEnv(KEYS);
  try {
    process.env.BUSINESS_API_ENDPOINT = 'https://3009-47-86-27-42.ngrok-free.app/api';
    delete process.env.BusinessApiEndPoint;
    const got = reachabilityFromBusinessEndpointEnv();
    assert.deepStrictEqual(got, {
      businessApiEndpoint: 'https://3009-47-86-27-42.ngrok-free.app/api',
      serverUrl: 'https://3009-47-86-27-42.ngrok-free.app',
      publicIp: null,
    });
  } finally {
    restoreEnv(saved);
  }
});

test('reachabilityFromBusinessEndpointEnv：IP BUSINESS_API_ENDPOINT 可提取 public_ip', () => {
  const saved = snapshotEnv(KEYS);
  try {
    process.env.BusinessApiEndPoint = 'http://203.0.113.8:8765/api';
    delete process.env.BUSINESS_API_ENDPOINT;
    const got = reachabilityFromBusinessEndpointEnv();
    assert.deepStrictEqual(got, {
      businessApiEndpoint: 'http://203.0.113.8:8765/api',
      serverUrl: 'http://203.0.113.8:8765',
      publicIp: '203.0.113.8',
    });
  } finally {
    restoreEnv(saved);
  }
});

test('reachabilityFromBusinessEndpointEnv：IP 无显式端口时补 hostMappedHttpPort（与换票规范化一致）', () => {
  const saved = snapshotEnv(KEYS);
  try {
    delete process.env.TRAE_HOST_HTTP_PORT;
    process.env.PORT = '37521';
    process.env.BUSINESS_API_ENDPOINT = 'http://203.0.113.9/api';
    delete process.env.BusinessApiEndPoint;
    const got = reachabilityFromBusinessEndpointEnv();
    assert.deepStrictEqual(got, {
      businessApiEndpoint: 'http://203.0.113.9:37521/api',
      serverUrl: 'http://203.0.113.9:37521',
      publicIp: '203.0.113.9',
    });
  } finally {
    restoreEnv(saved);
  }
});

test('reachabilityFromBusinessEndpointEnv：域名仍写 :8765 且 TRAE_HOST_HTTP_PORT 为映射口时改用映射口', () => {
  const saved = snapshotEnv(KEYS);
  try {
    process.env.TRAE_HOST_HTTP_PORT = '49152';
    process.env.PORT = '8765';
    process.env.BUSINESS_API_ENDPOINT = 'http://debug.aidevpm.com:8765/api';
    delete process.env.BusinessApiEndPoint;
    const got = reachabilityFromBusinessEndpointEnv();
    assert.deepStrictEqual(got, {
      businessApiEndpoint: 'http://debug.aidevpm.com:49152/api',
      serverUrl: 'http://debug.aidevpm.com:49152',
      publicIp: null,
    });
  } finally {
    restoreEnv(saved);
  }
});

test('reachabilityFromBusinessEndpointEnv：loopback BUSINESS_API 返回 null（改走 resolveReachableIp）', () => {
  const saved = snapshotEnv(KEYS);
  try {
    process.env.BUSINESS_API_ENDPOINT = 'http://127.0.0.1:8765/api';
    delete process.env.BusinessApiEndPoint;
    assert.equal(reachabilityFromBusinessEndpointEnv(), null);
  } finally {
    restoreEnv(saved);
  }
});

test('isSaasColocatedWithContainer：TRAE_SAAS_COLOCATED 显式开启', () => {
  const saved = snapshotEnv(KEYS);
  try {
    delete process.env.TASK_API_ENDPOINT_ORIGIN;
    delete process.env.TASK_API_ENDPOINT;
    delete process.env.TaskApiEndPoint;
    delete process.env.TRAE_REGISTER_LOOPBACK;
    process.env.TRAE_SAAS_COLOCATED = '1';
    assert.equal(isSaasColocatedWithContainer(), true);
  } finally {
    restoreEnv(saved);
  }
});

test('isSaasColocatedWithContainer：TASK_API_ENDPOINT_ORIGIN 为 loopback 时同机', () => {
  const saved = snapshotEnv(KEYS);
  try {
    delete process.env.TRAE_SAAS_COLOCATED;
    delete process.env.TRAE_REGISTER_LOOPBACK;
    process.env.TASK_API_ENDPOINT_ORIGIN = 'http://127.0.0.1:8011';
    assert.equal(isSaasColocatedWithContainer(), true);
  } finally {
    restoreEnv(saved);
  }
});

test('isSaasColocatedWithContainer：公网 TASK_API 非同机', () => {
  const saved = snapshotEnv(KEYS);
  try {
    delete process.env.TRAE_SAAS_COLOCATED;
    delete process.env.TRAE_REGISTER_LOOPBACK;
    process.env.TASK_API_ENDPOINT_ORIGIN = 'http://203.0.113.8:8011';
    assert.equal(isSaasColocatedWithContainer(), false);
  } finally {
    restoreEnv(saved);
  }
});

test('registerReachabilityAfterBootstrap：POST body 含 comment_id/container_name', async () => {
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
      res.end('{}');
    });
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    // TaskApiEndPoint 指向本地 server；BusinessApiEndPoint 带公网 IP 避免 resolveReachableIp
    delete process.env.TASK_API_ENDPOINT_ORIGIN;
    delete process.env.TASK_API_ENDPOINT;
    delete process.env.TRAE_SKIP_REACHABILITY_REGISTER;
    delete process.env.TRAE_SAAS_COLOCATED;
    process.env.TaskApiEndPoint = `http://127.0.0.1:${port}/api/tenant/ta/workspace/ws1/task/td1/comment/cmt-a/cloud`;
    process.env.BusinessApiEndPoint = 'http://203.0.113.8:8765/api';
    process.env.ACCESS_TOKEN = 'reach-scope-token';
    process.env.COMMENT_ID = ' cmt_9 ';
    process.env.CONTAINER_NAME = 'task_9_cmt_9';
    await registerReachabilityAfterBootstrap({
      prefix: `http://127.0.0.1:${port}`,
      timeout: 2,
      skipped: false,
    });
    assert.ok(reqUrl.endsWith('/server-container-token/register-reachability/'), `unexpected path: ${reqUrl}`);
    const body = JSON.parse(received);
    assert.strictEqual(body.comment_id, 'cmt_9');
    assert.strictEqual(body.container_name, 'task_9_cmt_9');
  } finally {
    restoreEnv(saved);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test('resolveReachableIp：仅认 TRAE_PUBLIC_IP / PUBLIC_IP，不探测外网', async () => {
  const saved = snapshotEnv(KEYS);
  try {
    delete process.env.TRAE_PUBLIC_IP;
    delete process.env.PUBLIC_IP;
    await assert.rejects(
      () => resolveReachableIp(),
      (err) => {
        assert.match(String(err?.message || err), /TRAE_PUBLIC_IP|PUBLIC_IP/);
        assert.doesNotMatch(String(err?.message || err), /ipw\.cn|ipip\.net/);
        return true;
      },
    );
    process.env.TRAE_PUBLIC_IP = '203.0.113.10';
    assert.equal(await resolveReachableIp(), '203.0.113.10');
    delete process.env.TRAE_PUBLIC_IP;
    process.env.PUBLIC_IP = '203.0.113.11';
    assert.equal(await resolveReachableIp(), '203.0.113.11');
  } finally {
    restoreEnv(saved);
  }
});
