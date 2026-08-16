// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildFeatureParamsEnvSnapshot,
  buildFeatureParamsEnvLogRecord,
  buildFeatureParamsEnvPulledSummary,
  appendFeatureParamsEnvLogBestEffort,
  isFeatureParamsEnvLogRedactEnabled,
} from './featureParamsEnvLog.mjs';

test('buildFeatureParamsEnvSnapshot 全量采集：空键忽略，值转字符串', () => {
  const got = buildFeatureParamsEnvSnapshot({
    TASK_AGENT_MAX_STEPS: 200,
    TASK_AGENT_MODEL: 'gpt-4',
    '': 'drop',
    '  ': 'drop2',
    FLAG: false,
  });
  assert.deepStrictEqual(got, {
    TASK_AGENT_MAX_STEPS: '200',
    TASK_AGENT_MODEL: 'gpt-4',
    FLAG: 'false',
  });
});

test('buildFeatureParamsEnvLogRecord 显式 redact=false 时不脱敏', () => {
  const now = new Date('2026-07-09T08:00:00.000Z');
  const line = buildFeatureParamsEnvLogRecord({
    envMapping: { TASK_AGENT_MAX_STEPS: '32', TASK_LLM_PROXY_TOKEN: 'tok_x' },
    now,
    redact: false,
  });
  assert.ok(line.endsWith('\n'));
  assert.deepStrictEqual(JSON.parse(line), {
    ts: now.toISOString(),
    event: 'onlineServiceJS.feature_params_env',
    redact: false,
    env: {
      TASK_AGENT_MAX_STEPS: '32',
      TASK_LLM_PROXY_TOKEN: 'tok_x',
    },
  });
});

test('buildFeatureParamsEnvLogRecord 默认脱敏：redact 未传时对敏感键打码', () => {
  const prevPolicy = process.env.FEATURE_PARAMS_ENV_LOG_REDACT;
  const prevGlobal = process.env.ENV_LOG_REDACT;
  delete process.env.FEATURE_PARAMS_ENV_LOG_REDACT;
  delete process.env.ENV_LOG_REDACT;
  try {
    const now = new Date('2026-07-09T08:00:00.000Z');
    const payload = JSON.parse(
      buildFeatureParamsEnvLogRecord({
        envMapping: { TASK_AGENT_MAX_STEPS: '32', TASK_LLM_PROXY_TOKEN: 'tok_x' },
        now,
      })
    );
    assert.equal(payload.redact, true);
    assert.equal(payload.env.TASK_LLM_PROXY_TOKEN, '(redacted len=5)');
    assert.equal(payload.env.TASK_AGENT_MAX_STEPS, '32');
  } finally {
    if (prevPolicy === undefined) delete process.env.FEATURE_PARAMS_ENV_LOG_REDACT;
    else process.env.FEATURE_PARAMS_ENV_LOG_REDACT = prevPolicy;
    if (prevGlobal === undefined) delete process.env.ENV_LOG_REDACT;
    else process.env.ENV_LOG_REDACT = prevGlobal;
  }
});

test('buildFeatureParamsEnvLogRecord 开启 redact 时打码敏感值', () => {
  const now = new Date('2026-07-09T08:00:00.000Z');
  const payload = JSON.parse(
    buildFeatureParamsEnvLogRecord({
      envMapping: {
        TASK_AGENT_MAX_STEPS: '32',
        TASK_LLM_PROXY_TOKEN: 'tok_secret',
        TASK_LLM_PROVIDERS_JSON: '[{"api_key":"sk-1","provider":"x"}]',
      },
      now,
      redact: true,
    })
  );
  assert.equal(payload.redact, true);
  assert.equal(payload.env.TASK_LLM_PROXY_TOKEN, '(redacted len=10)');
  assert.equal(payload.env.TASK_AGENT_MAX_STEPS, '32');
  assert.match(payload.env.TASK_LLM_PROVIDERS_JSON, /redacted len=4/);
  assert.doesNotMatch(payload.env.TASK_LLM_PROVIDERS_JSON, /sk-1/);
});

test('buildFeatureParamsEnvPulledSummary 生成短摘要便于面板检索', () => {
  const summary = buildFeatureParamsEnvPulledSummary({
    TASK_AGENT_MAX_STEPS: '200',
    TASK_LLM_PROXY_TOKEN: 'tok',
  });
  assert.equal(
    summary,
    '[onlineServiceJS] feature-params-env pulled: keys=TASK_AGENT_MAX_STEPS,TASK_LLM_PROXY_TOKEN count=2'
  );
});

test('appendFeatureParamsEnvLogBestEffort 写入文件并打印摘要+完整行', () => {
  const prevRoot = process.env.ONLINE_PROJECT_STATE_ROOT;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-params-env-log-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tempRoot;
  const printed = [];

  try {
    const result = appendFeatureParamsEnvLogBestEffort(
      {
        envMapping: {
          TASK_AGENT_MAX_STEPS: '64',
          TASK_LLM_PROVIDERS_JSON: '[{"provider":"openai","api_key":"sk-test"}]',
        },
        now: new Date('2026-07-09T08:00:01.000Z'),
        redact: false,
      },
      {
        logLine: (msg) => printed.push(msg),
      }
    );
    assert.equal(result.ok, true);
    assert.match(result.summary, /keys=TASK_AGENT_MAX_STEPS,TASK_LLM_PROVIDERS_JSON/);

    const filePath = path.join(tempRoot, 'logs', 'feature-params-env.log');
    const content = fs.readFileSync(filePath, 'utf8');
    const payload = JSON.parse(content.trimEnd());
    assert.equal(payload.event, 'onlineServiceJS.feature_params_env');
    assert.equal(payload.env.TASK_AGENT_MAX_STEPS, '64');
    assert.match(payload.env.TASK_LLM_PROVIDERS_JSON, /sk-test/);
    assert.equal(printed.length, 2);
    assert.match(printed[0], /feature-params-env pulled: keys=/);
    assert.match(printed[1], /feature-params-env pulled: \{/);
  } finally {
    if (prevRoot === undefined) delete process.env.ONLINE_PROJECT_STATE_ROOT;
    else process.env.ONLINE_PROJECT_STATE_ROOT = prevRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('appendFeatureParamsEnvLogBestEffort 写失败时返回错误状态', () => {
  const result = appendFeatureParamsEnvLogBestEffort(
    {
      envMapping: { TASK_AGENT_MAX_STEPS: '1' },
      now: new Date('2026-07-09T08:00:02.000Z'),
    },
    {
      writeFile: () => {
        throw new Error('disk full');
      },
      logLine: () => {},
    }
  );
  assert.equal(result.ok, false);
  assert.match(String(result.error), /disk full/);
});

test('isFeatureParamsEnvLogRedactEnabled 默认开启，显式 0/false/no/off 关闭', () => {
  const prevPolicy = process.env.FEATURE_PARAMS_ENV_LOG_REDACT;
  const prevGlobal = process.env.ENV_LOG_REDACT;
  delete process.env.FEATURE_PARAMS_ENV_LOG_REDACT;
  delete process.env.ENV_LOG_REDACT;
  try {
    assert.equal(isFeatureParamsEnvLogRedactEnabled(), true);
  } finally {
    if (prevPolicy === undefined) delete process.env.FEATURE_PARAMS_ENV_LOG_REDACT;
    else process.env.FEATURE_PARAMS_ENV_LOG_REDACT = prevPolicy;
    if (prevGlobal === undefined) delete process.env.ENV_LOG_REDACT;
    else process.env.ENV_LOG_REDACT = prevGlobal;
  }
  assert.equal(isFeatureParamsEnvLogRedactEnabled('1', ''), true);
  assert.equal(isFeatureParamsEnvLogRedactEnabled('', 'true'), true);
  assert.equal(isFeatureParamsEnvLogRedactEnabled('0', ''), false);
  assert.equal(isFeatureParamsEnvLogRedactEnabled('', 'off'), false);
  assert.equal(isFeatureParamsEnvLogRedactEnabled('0', 'no'), false);
});
