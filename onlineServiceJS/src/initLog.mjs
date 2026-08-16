import fs from 'fs';
import path from 'path';

import { isEnvRedactDisabled, redactEnvSnapshot } from './envLogRedact.mjs';
import { logsDir } from './paths.mjs';

export function parseInitLogEnvKeysPolicy(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const keys = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (keys.length === 0) return null;
  return new Set(keys);
}

/**
 * init.log 脱敏：默认开启；INIT_LOG_REDACT 或全局 ENV_LOG_REDACT 显式 `0/false/no/off` 才关闭。
 * @param {unknown} [rawInit]
 * @param {unknown} [rawGlobal]
 */
export function isInitLogRedactEnabled(
  rawInit = process.env.INIT_LOG_REDACT,
  rawGlobal = process.env.ENV_LOG_REDACT
) {
  return !isEnvRedactDisabled(rawGlobal) && !isEnvRedactDisabled(rawInit);
}

export function buildInitLogEnvSnapshot(envMapping, rawPolicy, redact = false) {
  const policy = parseInitLogEnvKeysPolicy(rawPolicy);
  const out = {};
  const source = envMapping && typeof envMapping === 'object' ? envMapping : {};

  for (const [rawKey, value] of Object.entries(source)) {
    const key = String(rawKey ?? '').trim();
    if (!key) continue;
    if (policy && !policy.has(key)) continue;
    out[key] = String(value);
  }

  return redactEnvSnapshot(out, Boolean(redact));
}

export function buildInitLogRecord({ pid, port, envMapping, now, rawPolicy, redact }) {
  const ts = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
  const shouldRedact = redact === undefined ? isInitLogRedactEnabled() : Boolean(redact);
  return `${JSON.stringify({
    ts,
    event: 'onlineServiceJS.init',
    pid,
    port: String(port ?? ''),
    redact: shouldRedact,
    env: buildInitLogEnvSnapshot(envMapping, rawPolicy, shouldRedact),
  })}\n`;
}

export function appendInitLogBestEffort(
  { pid, port, envMapping, now, rawPolicy, redact },
  { writeFile = fs.appendFileSync } = {}
) {
  try {
    const file = path.join(logsDir(), 'init.log');
    writeFile(file, buildInitLogRecord({ pid, port, envMapping, now, rawPolicy, redact }));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}
