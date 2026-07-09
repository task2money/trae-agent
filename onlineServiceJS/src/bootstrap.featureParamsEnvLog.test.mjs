// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyFeatureParamsEnvToProcess,
  persistFeatureParamsEnv,
} from './bootstrap.mjs';

test('applyFeatureParamsEnvToProcess 写入目标 env 并跳过空键', () => {
  const target = { KEEP: '1' };
  const keys = applyFeatureParamsEnvToProcess(
    {
      TASK_FEATURE_PARAMS_SCOPE: 'company',
      '  ': 'ignored',
      TASK_AGENT_MAX_STEPS: 200,
    },
    target,
  );
  assert.deepEqual(keys, ['TASK_AGENT_MAX_STEPS', 'TASK_FEATURE_PARAMS_SCOPE']);
  assert.equal(target.TASK_FEATURE_PARAMS_SCOPE, 'company');
  assert.equal(target.TASK_AGENT_MAX_STEPS, '200');
  assert.equal(target.KEEP, '1');
  assert.equal(Object.prototype.hasOwnProperty.call(target, '  '), false);
});

test('persistFeatureParamsEnv 拉取后会调用 env 日志并写入 yaml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-feature-params-'));
  const dest = path.join(dir, 'service_config.yaml');
  const logged = [];
  const errors = [];
  const processEnv = {};

  const written = persistFeatureParamsEnv(
    {
      TASK_AGENT_MAX_STEPS: '48',
      TASK_AGENT_MODEL: 'demo-model',
      TASK_FEATURE_PARAMS_SCOPE: 'workspace',
    },
    {
      appendEnvLog: ({ envMapping }) => {
        logged.push(envMapping);
        return { ok: true, error: null };
      },
      resolveConfig: () => 'agents:\n  trae_agent:\n    max_steps: 48\n',
      configPath: () => dest,
      parseYaml: () => ({ agents: { trae_agent: { max_steps: 48 } } }),
      logError: (...args) => errors.push(args),
      processEnv,
    }
  );

  assert.equal(written, dest);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].TASK_AGENT_MAX_STEPS, '48');
  assert.equal(processEnv.TASK_FEATURE_PARAMS_SCOPE, 'workspace');
  assert.equal(processEnv.TASK_AGENT_MAX_STEPS, '48');
  assert.ok(fs.existsSync(dest));
  assert.equal(errors.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persistFeatureParamsEnv 缺少 TASK_AGENT_MAX_STEPS 时失败且不写文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-feature-params-miss-'));
  const dest = path.join(dir, 'service_config.yaml');
  let logged = 0;
  assert.throws(
    () =>
      persistFeatureParamsEnv(
        { TASK_AGENT_MODEL: 'x' },
        {
          appendEnvLog: () => {
            logged += 1;
            return { ok: true, error: null };
          },
          configPath: () => dest,
        }
      ),
    /TASK_AGENT_MAX_STEPS/
  );
  assert.equal(logged, 0);
  assert.equal(fs.existsSync(dest), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persistFeatureParamsEnv 日志写失败不阻断 yaml 落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-feature-params-logfail-'));
  const dest = path.join(dir, 'service_config.yaml');
  const errors = [];
  persistFeatureParamsEnv(
    { TASK_AGENT_MAX_STEPS: '10' },
    {
      appendEnvLog: () => ({ ok: false, error: new Error('disk full') }),
      resolveConfig: () => 'agents: {}\n',
      configPath: () => dest,
      parseYaml: () => ({}),
      logError: (...args) => errors.push(args.join(' ')),
    }
  );
  assert.ok(fs.existsSync(dest));
  assert.ok(errors.some((line) => String(line).includes('feature-params-env.log append error')));
  fs.rmSync(dir, { recursive: true, force: true });
});
