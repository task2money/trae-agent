import fs from 'fs';
import path from 'path';

import { isTruthyEnvFlag, redactEnvSnapshot } from './envLogRedact.mjs';
import { logsDir } from './paths.mjs';

/**
 * 将 feature-params-env 拉取结果规范为可落盘的字符串键值表。
 * @param {Record<string, unknown>|null|undefined} envMapping
 * @returns {Record<string, string>}
 */
export function buildFeatureParamsEnvSnapshot(envMapping) {
  const out = {};
  const source = envMapping && typeof envMapping === 'object' ? envMapping : {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = String(rawKey ?? '').trim();
    if (!key) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * @param {unknown} rawPolicy
 * @returns {boolean}
 */
export function isFeatureParamsEnvLogRedactEnabled(
  rawPolicy = process.env.FEATURE_PARAMS_ENV_LOG_REDACT,
  rawGlobal = process.env.ENV_LOG_REDACT
) {
  return isTruthyEnvFlag(rawPolicy) || isTruthyEnvFlag(rawGlobal);
}

/**
 * @param {Record<string, string>} envSnapshot
 * @returns {string}
 */
export function buildFeatureParamsEnvPulledSummary(envSnapshot) {
  const keys = Object.keys(envSnapshot || {}).sort();
  return `[onlineServiceJS] feature-params-env pulled: keys=${keys.join(',') || '(none)'} count=${keys.length}`;
}

/**
 * @param {{
 *   envMapping: Record<string, unknown>,
 *   now?: Date|number|string,
 *   redact?: boolean,
 * }} args
 * @returns {string}
 */
export function buildFeatureParamsEnvLogRecord({ envMapping, now, redact }) {
  const ts = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
  const raw = buildFeatureParamsEnvSnapshot(envMapping);
  const env = redactEnvSnapshot(raw, Boolean(redact));
  return `${JSON.stringify({
    ts,
    event: 'onlineServiceJS.feature_params_env',
    redact: Boolean(redact),
    env,
  })}\n`;
}

/**
 * 追加写入 `{ONLINE_PROJECT_STATE_ROOT}/logs/feature-params-env.log`，
 * 并向 stdout 打印：1) 短摘要行（便于启动日志面板检索）2) 完整 JSON 快照行。
 * 写失败不抛错，返回 { ok, error }。
 */
export function appendFeatureParamsEnvLogBestEffort(
  { envMapping, now, redact = isFeatureParamsEnvLogRedactEnabled() },
  { writeFile = fs.appendFileSync, logLine = console.log } = {}
) {
  const record = buildFeatureParamsEnvLogRecord({ envMapping, now, redact });
  const snapshot = redactEnvSnapshot(buildFeatureParamsEnvSnapshot(envMapping), Boolean(redact));
  const summary = buildFeatureParamsEnvPulledSummary(snapshot);
  try {
    const file = path.join(logsDir(), 'feature-params-env.log');
    writeFile(file, record);
  } catch (error) {
    return { ok: false, error };
  }
  try {
    // 先打短摘要，保证 relay/启动日志面板即使在长 JSON 被截断时也能看到「已拉取」证据
    logLine(summary);
    logLine(`[onlineServiceJS] feature-params-env pulled: ${record.trimEnd()}`);
  } catch {
    /* ignore console failures */
  }
  return { ok: true, error: null, summary };
}
