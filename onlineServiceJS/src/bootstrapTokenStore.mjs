import fs from 'fs';
import path from 'path';
import { runtimeDir } from './paths.mjs';

function bootstrapTaskIdForTokenStore() {
  return String(process.env.taskId || process.env.TASK_ID || '').trim();
}

/**
 * 换票 HTTP 已成功，但本地 refresh/access 落盘失败。
 * 与 TOKEN_ACCESS_INVALID（令牌本身无效）区分，避免误判为需重新签发 access。
 */
export class PersistedRefreshTokenStoreError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, storePath?: string }} [opts]
   */
  constructor(message, opts = {}) {
    const cause = opts.cause;
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PersistedRefreshTokenStoreError';
    /** @type {'TOKEN_PERSIST_FAILED'} */
    this.code = 'TOKEN_PERSIST_FAILED';
    this.storePath = String(opts.storePath || '').trim();
  }
}

/** @param {unknown} e */
export function isPersistedRefreshTokenStoreError(e) {
  return (
    e instanceof PersistedRefreshTokenStoreError ||
    (Boolean(e) && typeof e === 'object' && e.code === 'TOKEN_PERSIST_FAILED')
  );
}

export function containerRefreshTokenStorePath() {
  return path.join(runtimeDir(), 'container_refresh_token.json');
}

/**
 * 读取落盘换票结果（refresh / access / expires_at），供主动续签与 go_relay 同步。
 * @returns {{ refreshToken: string, accessToken: string, expiresAt: string }}
 */
export function readPersistedTokenStore() {
  const fromEnv = String(process.env.CONTAINER_REFRESH_TOKEN || '').trim();
  if (fromEnv) {
    return { refreshToken: fromEnv, accessToken: '', expiresAt: '' };
  }
  const storePath = containerRefreshTokenStorePath();
  if (!fs.existsSync(storePath)) {
    return { refreshToken: '', accessToken: '', expiresAt: '' };
  }
  try {
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const taskId = bootstrapTaskIdForTokenStore();
    const storedTask = String(data.task_id || '').trim();
    if (taskId && storedTask && taskId !== storedTask) {
      return { refreshToken: '', accessToken: '', expiresAt: '' };
    }
    return {
      refreshToken: String(data.refresh_token || '').trim(),
      accessToken: String(data.access_token || '').trim(),
      expiresAt: String(data.expires_at || '').trim(),
    };
  } catch {
    return { refreshToken: '', accessToken: '', expiresAt: '' };
  }
}

export function readPersistedRefreshToken() {
  return readPersistedTokenStore().refreshToken;
}

/**
 * 落盘容器换票结果，供 go_relayToTrae 在子进程换票后同步 status-push state
 *（与云主机路径一致：首次 exchange 由 onlineServiceJS 完成）。
 * @param {{ refreshToken: string, accessToken?: string, expiresAt?: string } | string} tokens
 * @returns {string | undefined} 写入路径；refresh 为空时不写盘并返回 undefined
 * @throws {PersistedRefreshTokenStoreError} 落盘失败（非令牌无效）
 */
export function writePersistedRefreshToken(tokens) {
  const refreshToken = String(
    typeof tokens === 'string' ? tokens : tokens?.refreshToken || '',
  ).trim();
  if (!refreshToken) return undefined;
  const accessToken = String(
    typeof tokens === 'string' ? '' : tokens?.accessToken || '',
  ).trim();
  const expiresAt = String(typeof tokens === 'string' ? '' : tokens?.expiresAt || '').trim();
  const payload = {
    task_id: bootstrapTaskIdForTokenStore(),
    refresh_token: refreshToken,
    updated_at: new Date().toISOString(),
  };
  if (accessToken) payload.access_token = accessToken;
  if (expiresAt) payload.expires_at = expiresAt;
  let storePath = '';
  try {
    storePath = containerRefreshTokenStorePath();
    fs.writeFileSync(storePath, `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      // 0644：selected_image 下 state 目录 bind-mount 到宿主机时，go_relay 需可读以同步 token。
      // 路径仍在 ONLINE_PROJECT_STATE_ROOT 私有目录下，不扩大到世界可读的通用位置。
      mode: 0o644,
    });
  } catch (e) {
    if (isPersistedRefreshTokenStoreError(e)) throw e;
    const causeMsg = e && e.message ? String(e.message) : String(e);
    throw new PersistedRefreshTokenStoreError(
      `token-persist: FAIL write ${storePath || 'container_refresh_token.json'}: ${causeMsg}`,
      { cause: e, storePath },
    );
  }
  return storePath;
}

export function clearPersistedRefreshToken() {
  try {
    fs.unlinkSync(containerRefreshTokenStorePath());
  } catch {
    /* ignore missing file / already cleared */
  }
}

/**
 * exchange-refresh 返回 403：库中已有 refresh，须改走 refresh-access。
 * 匹配 error_code / 中文 detail；兼容旧测例文案中的 refresh-access 提示。
 */
export function isExchangeRefreshForbiddenError(e) {
  const code = String(e?.structuredPayload?.error_code || '').trim();
  if (code === 'TOKEN_EXCHANGE_ALREADY_DONE') return true;
  const msg = String(e?.message || e || '');
  if (!/HTTP\s+403\b/i.test(msg)) return false;
  return (
    /TOKEN_EXCHANGE_ALREADY_DONE/i.test(msg) ||
    /仅可用于首次换取\s*RefreshToken/i.test(msg) ||
    /refresh-access/i.test(msg)
  );
}

/**
 * exchange-refresh 返回 401：预埋/过期 access 已失效（常见于容器重启仍注入首次 ACCESS_TOKEN）。
 * 若本地仍有 refresh_token，应与 403 一样回退 refresh-access，否则进程会带着无效 ACCESS_TOKEN 监听，
 * 平台按 credential by-scope 转发时全线 401（Invalid or missing access token）。
 */
export function isExchangeRefreshInvalidAccessError(e) {
  const code = String(e?.structuredPayload?.error_code || '').trim();
  if (code === 'TOKEN_ACCESS_INVALID' || code === 'TOKEN_EXPIRED') return true;
  const msg = String(e?.message || e || '');
  if (!/HTTP\s+401\b/i.test(msg)) return false;
  return (
    /TOKEN_ACCESS_INVALID/i.test(msg) ||
    /无效的 access_token/i.test(msg) ||
    /TOKEN_EXPIRED/i.test(msg)
  );
}

/** 可凭落盘 refresh_token 自愈的 exchange-refresh 错误（403 已换票 / 401 预埋 access 失效）。 */
export function isExchangeRefreshFallbackEligibleError(e) {
  return isExchangeRefreshForbiddenError(e) || isExchangeRefreshInvalidAccessError(e);
}

/**
 * 换票失败日志行：落盘失败用 FAIL_PERSIST + TOKEN_PERSIST_FAILED，与普通 FAIL（含令牌无效）区分。
 * @param {unknown} e
 */
export function formatTokenExchangeFailureLog(e) {
  const detail = e && typeof e === 'object' && e.message != null ? String(e.message) : String(e);
  const persistFail = isPersistedRefreshTokenStoreError(e);
  const tag = persistFail ? 'FAIL_PERSIST' : 'FAIL';
  const code =
    persistFail && e && typeof e === 'object' && e.code ? String(e.code) : 'TOKEN_PERSIST_FAILED';
  const codeHint = persistFail ? ` error_code=${code}` : '';
  return `token-exchange: ${tag}${codeHint} ${detail}`;
}
