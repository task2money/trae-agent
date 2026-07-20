import assert from 'node:assert/strict';
import test from 'node:test';
import YAML from 'yaml';

import { resolveAgentConfigFromEnv } from './featureParamsEnvToYaml.mjs';

const minimalEnv = {
  TASK_AGENT_MAX_STEPS: '32',
  TASK_MODEL_PROVIDERS_JSON: '[]',
  TASK_TRAE_AGENT_MODEL_PROVIDER: 'openai',
  TASK_TRAE_AGENT_MODEL: 'gpt-4',
  TASK_LAKEVIEW_MODEL_PROVIDER: 'openai',
  TASK_LAKEVIEW_MODEL: 'gpt-4',
};

test('resolveAgentConfigFromEnv produces parseable yaml with max_steps', () => {
  const yamlText = resolveAgentConfigFromEnv(minimalEnv);
  const parsed = YAML.parse(yamlText);
  assert.equal(Number(parsed?.agents?.trae_agent?.max_steps), 32);
});
