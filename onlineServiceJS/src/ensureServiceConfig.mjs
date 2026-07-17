/**
 * 读取本地 service_config.yaml；缺失时回源 SaaS feature-params-env 并落盘。
 */
import fs from 'fs';

import { persistFeatureParamsEnv } from './bootstrap.mjs';
import { configFilePath } from './paths.mjs';
import { postJson, taskApiPrefix } from './saasTaskCloud.mjs';

function saasUnavailable(message) {
  const err = new Error(message);
  err.code = 'SAAS_CONFIG_UNAVAILABLE';
  return err;
}

function defaultTimeoutSec() {
  return Math.max(1, parseFloat(process.env.TASK_API_BOOTSTRAP_TIMEOUT_SEC || '15') || 15);
}

/**
 * @param {{
 *   configPath?: () => string,
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   taskApiPrefix?: typeof taskApiPrefix,
 *   postJson?: typeof postJson,
 *   persistFeatureParamsEnv?: typeof persistFeatureParamsEnv,
 *   accessToken?: string | (() => string),
 *   timeoutSec?: number | (() => number),
 *   postOpts?: { traceId?: string, spanId?: string },
 * }} [deps]
 * @returns {Promise<{ path: string, yaml: string, source: 'local' | 'saas' }>}
 */
export async function readOrPullServiceConfig(deps = {}) {
  const configPath = deps.configPath || configFilePath;
  const existsSync = deps.existsSync || fs.existsSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const resolvePrefix = deps.taskApiPrefix || taskApiPrefix;
  const post = deps.postJson || postJson;
  const persist = deps.persistFeatureParamsEnv || persistFeatureParamsEnv;
  const tokenResolver =
    deps.accessToken !== undefined
      ? deps.accessToken
      : () => String(process.env.ACCESS_TOKEN || '').trim();
  const timeoutResolver = deps.timeoutSec !== undefined ? deps.timeoutSec : defaultTimeoutSec;

  const dest = configPath();
  if (existsSync(dest)) {
    return { path: dest, yaml: readFileSync(dest, 'utf8'), source: 'local' };
  }

  let prefix;
  try {
    prefix = resolvePrefix();
  } catch (e) {
    throw saasUnavailable(
      `saas config pull unavailable: ${e && e.message ? String(e.message) : String(e)}`,
    );
  }
  if (!prefix) {
    throw saasUnavailable('saas config pull unavailable: empty task API prefix');
  }

  const accessToken =
    typeof tokenResolver === 'function' ? String(tokenResolver() || '').trim() : String(tokenResolver || '').trim();
  if (!accessToken) {
    throw saasUnavailable('saas config pull unavailable: ACCESS_TOKEN empty');
  }

  const timeoutSec =
    typeof timeoutResolver === 'function' ? Number(timeoutResolver()) : Number(timeoutResolver);
  const timeout = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : defaultTimeoutSec();
  const postOpts = deps.postOpts && typeof deps.postOpts === 'object' ? deps.postOpts : {};

  const body = await post(
    `${prefix}/server-container-token/feature-params-env/`,
    { access_token: accessToken },
    timeout,
    postOpts,
  );
  if (body == null || typeof body !== 'object' || body.env == null || typeof body.env !== 'object') {
    throw new Error('saas feature-params-env missing env');
  }

  const written = persist(body.env);
  return { path: written, yaml: readFileSync(written, 'utf8'), source: 'saas' };
}
