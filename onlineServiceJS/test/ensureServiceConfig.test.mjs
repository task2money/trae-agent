import assert from 'node:assert/strict';
import test from 'node:test';

import { readOrPullServiceConfig } from '../src/ensureServiceConfig.mjs';

test('readOrPullServiceConfig：本地已有配置时直接返回，不请求 SaaS', async () => {
  let postCalls = 0;
  const result = await readOrPullServiceConfig({
    configPath: () => '/tmp/fake/service_config.yaml',
    existsSync: () => true,
    readFileSync: () => 'agents:\n  trae_agent:\n    max_steps: 1\n',
    taskApiPrefix: () => {
      throw new Error('should not call taskApiPrefix');
    },
    postJson: async () => {
      postCalls += 1;
      throw new Error('should not post');
    },
  });
  assert.equal(result.source, 'local');
  assert.match(result.yaml, /max_steps:\s*1/);
  assert.equal(postCalls, 0);
});

test('readOrPullServiceConfig：本地缺失时从 SaaS feature-params-env 拉取并落盘', async () => {
  let persistedEnv = null;
  const result = await readOrPullServiceConfig({
    configPath: () => '/tmp/fake/service_config.yaml',
    existsSync: () => false,
    readFileSync: () => 'agents:\n  trae_agent:\n    max_steps: 32\n',
    taskApiPrefix: () => 'http://saas.example/api/tenant/t/workspace/w/task/x/cloud',
    accessToken: () => 'tok_test',
    timeoutSec: () => 7,
    postJson: async (url, body, timeout, opts) => {
      assert.match(url, /\/server-container-token\/feature-params-env\/$/);
      assert.deepEqual(body, { access_token: 'tok_test' });
      assert.equal(timeout, 7);
      assert.equal(opts?.traceId, 'trace-abc');
      return { env: { TASK_AGENT_MAX_STEPS: '32' } };
    },
    persistFeatureParamsEnv: (envMap) => {
      persistedEnv = envMap;
      return '/tmp/fake/service_config.yaml';
    },
    postOpts: { traceId: 'trace-abc', spanId: 'span1' },
  });
  assert.equal(result.source, 'saas');
  assert.equal(result.path, '/tmp/fake/service_config.yaml');
  assert.deepEqual(persistedEnv, { TASK_AGENT_MAX_STEPS: '32' });
  assert.match(result.yaml, /max_steps:\s*32/);
});

test('readOrPullServiceConfig：无 TaskApi 前缀时抛出 SAAS_CONFIG_UNAVAILABLE', async () => {
  await assert.rejects(
    () =>
      readOrPullServiceConfig({
        configPath: () => '/tmp/fake/service_config.yaml',
        existsSync: () => false,
        taskApiPrefix: () => null,
        accessToken: () => 'tok',
      }),
    (err) => err && err.code === 'SAAS_CONFIG_UNAVAILABLE',
  );
});

test('readOrPullServiceConfig：SaaS 响应缺 env 时失败且不静默成功', async () => {
  await assert.rejects(
    () =>
      readOrPullServiceConfig({
        configPath: () => '/tmp/fake/service_config.yaml',
        existsSync: () => false,
        taskApiPrefix: () => 'http://saas.example/api/tenant/t/workspace/w/task/x/cloud',
        accessToken: () => 'tok',
        timeoutSec: () => 5,
        postJson: async () => ({}),
        persistFeatureParamsEnv: () => {
          throw new Error('should not persist');
        },
      }),
    /missing env/i,
  );
});
