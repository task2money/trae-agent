import test from 'node:test';
import assert from 'node:assert/strict';

import {
  featureParamsEnvToYaml,
  normalizeDeepSeekBaseUrl,
} from './featureParamsEnvToYaml.mjs';

test('featureParamsEnvToYaml builds trae config from env', () => {
  const yaml = featureParamsEnvToYaml({
    TASK_LLM_PROVIDERS_JSON:
      '[{"provider":"openai","api_key":"sk-test","base_url":"https://api.openai.com/v1","supported_models":["gpt-4"],"use_sub_token":false}]',
    TASK_AGENT_MODEL: 'gpt-4',
    TASK_AGENT_MODEL_PROVIDER: 'openai',
    TASK_AGENT_MAX_STEPS: '100',
    TASK_SUMMARY_MODEL: 'gpt-3.5',
    TASK_SUMMARY_MODEL_PROVIDER: 'openai',
  });
  assert.match(yaml, /max_steps: 100/);
  assert.match(yaml, /model: gpt-4/);
  assert.match(yaml, /sk-test/);
  assert.match(yaml, /    openai:/);
  assert.match(yaml, /allow_mcp_servers: \[\]/);
  assert.doesNotMatch(yaml, /@playwright\/mcp/);
});

test('featureParamsEnvToYaml rejects invalid providers json', () => {
  assert.throws(
    () =>
      featureParamsEnvToYaml({
        TASK_LLM_PROVIDERS_JSON: '{"not":"array"}',
        TASK_AGENT_MAX_STEPS: '200',
      }),
    /JSON array/,
  );
});

test('featureParamsEnvToYaml uses defaults for empty providers', () => {
  const yaml = featureParamsEnvToYaml({
    TASK_LLM_PROVIDERS_JSON: '[]',
    TASK_AGENT_MAX_STEPS: '200',
  });
  assert.match(yaml, /<provider>:/);
  assert.match(yaml, /max_steps: 200/);
});

test('featureParamsEnvToYaml lowercases provider identifiers', () => {
  const yaml = featureParamsEnvToYaml({
    TASK_LLM_PROVIDERS_JSON:
      '[{"provider":"deepSeek","api_key":"sk-ds","base_url":"https://api.deepseek.com","supported_models":["deepseek-v4-pro"],"use_sub_token":false}]',
    TASK_AGENT_MODEL: 'deepseek-v4-pro',
    TASK_AGENT_MODEL_PROVIDER: 'deepSeek',
    TASK_AGENT_MAX_STEPS: '200',
    TASK_SUMMARY_MODEL: 'deepseek-v4-flash',
    TASK_SUMMARY_MODEL_PROVIDER: 'deepSeek',
  });
  assert.match(yaml, /    deepseek:/);
  assert.match(yaml, /provider: deepseek/);
  assert.match(yaml, /model_provider: deepseek/);
  assert.doesNotMatch(yaml, /deepSeek/);
});

test('normalizeDeepSeekBaseUrl keeps operator-typed paths and repairs concat only', () => {
  assert.equal(
    normalizeDeepSeekBaseUrl('deepseek', 'https://api.deepseek.com/anthropic'),
    'https://api.deepseek.com/anthropic',
  );
  assert.equal(
    normalizeDeepSeekBaseUrl('anthropic', 'https://api.deepseek.com/anthropic'),
    'https://api.deepseek.com/anthropic',
  );
  assert.equal(
    normalizeDeepSeekBaseUrl('deepseek', 'https://gateway.example.com/anthropic'),
    'https://gateway.example.com/anthropic',
  );
  assert.equal(
    normalizeDeepSeekBaseUrl(
      'deepseek',
      'https://api.deepseek.com/v1https://api.deepseek.com',
    ),
    'https://api.deepseek.com',
  );
});

test('featureParamsEnvToYaml keeps deepseek anthropic base_url', () => {
  const yaml = featureParamsEnvToYaml({
    TASK_LLM_PROVIDERS_JSON:
      '[{"provider":"deepseek","api_key":"sk","base_url":"https://api.deepseek.com/anthropic","supported_models":["deepseek-v4-flash"]}]',
    TASK_AGENT_MODEL: 'deepseek-v4-flash',
    TASK_AGENT_MODEL_PROVIDER: 'deepseek',
    TASK_AGENT_MAX_STEPS: '200',
    TASK_SUMMARY_MODEL: 'deepseek-v4-flash',
    TASK_SUMMARY_MODEL_PROVIDER: 'deepseek',
  });
  assert.match(yaml, /base_url: https:\/\/api\.deepseek\.com\/anthropic/);
});

test('featureParamsEnvToYaml enables playwright mcp when opted in', () => {
  const yaml = featureParamsEnvToYaml({
    TASK_LLM_PROVIDERS_JSON: '[]',
    TASK_AGENT_MAX_STEPS: '200',
    TASK_ENABLE_PLAYWRIGHT_MCP: '1',
  });
  assert.match(yaml, /allow_mcp_servers:\n    - playwright/);
  assert.match(yaml, /@playwright\/mcp@0\.0\.27/);
});
