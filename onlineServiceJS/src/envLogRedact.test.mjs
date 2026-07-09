// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSensitiveEnvKey,
  redactSecretValue,
  redactEnvSnapshot,
  redactNestedValue,
} from './envLogRedact.mjs';

test('isSensitiveEnvKey 识别 token/api_key/secret 类键名', () => {
  assert.equal(isSensitiveEnvKey('TASK_LLM_PROXY_TOKEN'), true);
  assert.equal(isSensitiveEnvKey('ACCESS_TOKEN'), true);
  assert.equal(isSensitiveEnvKey('openai_api_key'), true);
  assert.equal(isSensitiveEnvKey('CLIENT_SECRET'), true);
  assert.equal(isSensitiveEnvKey('TASK_AGENT_MAX_STEPS'), false);
  assert.equal(isSensitiveEnvKey('TASK_AI_ENDPOINT_BASE_URL'), false);
});

test('redactSecretValue 保留长度摘要', () => {
  assert.equal(redactSecretValue(''), '(empty)');
  assert.equal(redactSecretValue('tok_abc'), '(redacted len=7)');
});

test('redactEnvSnapshot 关闭时原样返回', () => {
  const src = { ACCESS_TOKEN: 'tok', TASK_AGENT_MAX_STEPS: '200' };
  assert.deepStrictEqual(redactEnvSnapshot(src, false), src);
});

test('redactEnvSnapshot 开启时脱敏顶层敏感键与嵌套 JSON api_key', () => {
  const got = redactEnvSnapshot(
    {
      TASK_LLM_PROXY_TOKEN: 'tok_secret',
      TASK_AGENT_MAX_STEPS: '200',
      TASK_LLM_PROVIDERS_JSON: JSON.stringify([
        { provider: 'openai', api_key: 'sk-live', base_url: 'https://api.openai.com' },
      ]),
    },
    true
  );
  assert.equal(got.TASK_LLM_PROXY_TOKEN, '(redacted len=10)');
  assert.equal(got.TASK_AGENT_MAX_STEPS, '200');
  const providers = JSON.parse(got.TASK_LLM_PROVIDERS_JSON);
  assert.equal(providers[0].api_key, '(redacted len=7)');
  assert.equal(providers[0].provider, 'openai');
  assert.equal(providers[0].base_url, 'https://api.openai.com');
});

test('redactNestedValue 对非法 JSON 字符串保持原样', () => {
  assert.equal(redactNestedValue('{not-json'), '{not-json');
});
