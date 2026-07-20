import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { resolveAgentConfigFromEnv } from './featureParamsEnvToYaml.mjs';
import { appendFeatureParamsEnvLogBestEffort } from './featureParamsEnvLog.mjs';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import { configFilePath } from './paths.mjs';

/**
 * 将 feature-params-env 映射写入进程环境，供后续子进程（trae-cli / bash）继承。
 * 空键跳过；值统一转为字符串。
 * @param {Record<string, unknown>} envMap
 * @param {NodeJS.ProcessEnv} [targetEnv]
 * @returns {string[]} 实际写入的键名（已排序）
 */
export function applyFeatureParamsEnvToProcess(envMap, targetEnv = process.env) {
  const applied = [];
  if (envMap == null || typeof envMap !== 'object') {
    return applied;
  }
  for (const [rawKey, value] of Object.entries(envMap)) {
    const key = String(rawKey ?? '').trim();
    if (!key) continue;
    targetEnv[key] = String(value ?? '');
    applied.push(key);
  }
  return applied.sort();
}

/**
 * 将 feature-params-env 响应写入进程环境、落盘为 service_config.yaml，并写入/打印 env 快照日志。
 * @param {Record<string, unknown>} envMap
 * @param {{
 *   appendEnvLog?: typeof appendFeatureParamsEnvLogBestEffort,
 *   resolveConfig?: typeof resolveAgentConfigFromEnv,
 *   configPath?: () => string,
 *   writeFile?: typeof fs.writeFileSync,
 *   mkdirSync?: typeof fs.mkdirSync,
 *   parseYaml?: typeof YAML.parse,
 *   logError?: (...args: unknown[]) => void,
 *   applyToProcess?: typeof applyFeatureParamsEnvToProcess,
 *   processEnv?: NodeJS.ProcessEnv,
 * }} [deps]
 * @returns {string} 写入的配置文件路径
 */
export function persistFeatureParamsEnv(envMap, deps = {}) {
  const appendEnvLog = deps.appendEnvLog || appendFeatureParamsEnvLogBestEffort;
  const resolveConfig = deps.resolveConfig || resolveAgentConfigFromEnv;
  const configPath = deps.configPath || configFilePath;
  const writeFile = deps.writeFile || fs.writeFileSync;
  const mkdir = deps.mkdirSync || fs.mkdirSync.bind(fs);
  const parseYaml = deps.parseYaml || YAML.parse.bind(YAML);
  const logError = deps.logError || console.error.bind(console);
  const applyToProcess = deps.applyToProcess || applyFeatureParamsEnvToProcess;
  const processEnv = deps.processEnv || process.env;

  if (envMap == null || typeof envMap !== 'object') {
    throw new Error('feature-params-env missing env');
  }
  if (envMap.TASK_AGENT_MAX_STEPS == null) {
    throw new Error('feature-params-env missing TASK_AGENT_MAX_STEPS');
  }

  const appliedKeys = applyToProcess(envMap, processEnv);
  appendOutboundReqLog(
    `bootstrap: applied feature-params-env to process.env keys=${appliedKeys.join(',') || '(none)'}`,
  );

  const envLogResult = appendEnvLog({ envMapping: envMap });
  if (envLogResult && envLogResult.ok === false) {
    logError('[onlineServiceJS] feature-params-env.log append error:', envLogResult.error);
  }
  appendOutboundReqLog(
    `bootstrap: feature-params-env keys=${Object.keys(envMap).sort().join(',')}`,
  );

  const yamlText = resolveConfig(envMap);
  parseYaml(yamlText);
  const dest = configPath();
  mkdir(path.dirname(dest), { recursive: true });
  writeFile(dest, yamlText, 'utf8');
  appendOutboundReqLog(`bootstrap: wrote ${dest}`);
  return dest;
}
