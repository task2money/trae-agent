/**
 * 长跑容器主动 refresh-access（对齐 go_relay ensureFreshAccessToken）。
 * access TTL 默认 1h；skew 默认 5m。失败 soft-skip，不杀进程。
 */
import { taskApiPrefix } from './saasTaskCloud.mjs';
import {
  readPersistedTokenStore,
  writePersistedRefreshToken,
} from './bootstrapTokenStore.mjs';
import { runRefreshAccessOnly } from './bootstrapTokenExchange.mjs';

/** @type {number} */
export const DEFAULT_PROACTIVE_REFRESH_SKEW_MS = 5 * 60 * 1000;
/** 无 expires_at 时的保守续签间隔（略短于 1h TTL） */
export const CONSERVATIVE_REFRESH_INTERVAL_MS = 50 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

/** credential / IssueToken 使用的 UTC 布局：`2006-01-02 15:04:05` */
const EXPIRES_LAYOUT_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * @param {string} raw
 * @returns {number} epoch ms or NaN
 */
export function parseAccessExpiresAtMs(raw) {
  const text = String(raw || '').trim();
  if (!text) return NaN;
  const m = EXPIRES_LAYOUT_RE.exec(text);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    );
  }
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * @param {number} expiresAtMs
 * @param {number} nowMs
 * @param {number} skewMs
 */
export function accessTokenNeedsProactiveRefresh(expiresAtMs, nowMs, skewMs) {
  if (!Number.isFinite(expiresAtMs)) return false;
  const skew = Number.isFinite(skewMs) && skewMs >= 0 ? skewMs : 0;
  return nowMs >= expiresAtMs - skew;
}

/**
 * @param {number} lastRefreshAtMs 0 = never
 * @param {number} nowMs
 * @param {number} intervalMs
 */
export function shouldConservativeRefresh(lastRefreshAtMs, nowMs, intervalMs) {
  const last = Number(lastRefreshAtMs) || 0;
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : CONSERVATIVE_REFRESH_INTERVAL_MS;
  if (last <= 0) return true;
  return nowMs - last >= interval;
}

export function proactiveRefreshSkewMsFromEnv() {
  const raw = String(process.env.TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC || '').trim();
  if (!raw) return DEFAULT_PROACTIVE_REFRESH_SKEW_MS;
  const sec = parseFloat(raw);
  if (!Number.isFinite(sec) || sec < 0) return DEFAULT_PROACTIVE_REFRESH_SKEW_MS;
  return Math.round(sec * 1000);
}

function pollIntervalMsFromEnv() {
  const raw = String(process.env.TRAE_ACCESS_TOKEN_REFRESH_POLL_SEC || '').trim();
  if (!raw) return DEFAULT_POLL_INTERVAL_MS;
  const sec = parseFloat(raw);
  if (!Number.isFinite(sec) || sec < 5) return DEFAULT_POLL_INTERVAL_MS;
  return Math.round(sec * 1000);
}

function tokenExchangeTimeoutSec() {
  const raw = String(process.env.TASK_API_TOKEN_EXCHANGE_TIMEOUT_SEC || '').trim();
  if (!raw) {
    return Math.max(1, parseFloat(process.env.TASK_API_BOOTSTRAP_TIMEOUT_SEC || '15') || 15);
  }
  return Math.max(1, parseFloat(raw) || 15);
}

function appendLog(line) {
  try {
    // lazy: bootstrap 的 appendTokenRefreshLog 经动态避免循环时测试需 mock
    // 默认打 stdout；deps.log 可覆盖
    console.log(`[onlineServiceJS] ${line}`);
  } catch {
    /* ignore */
  }
}

/**
 * 单次判定并（如需要）执行 refresh-access。
 * @param {{
 *   nowMs?: number,
 *   skewMs?: number,
 *   lastRefreshAtMs?: number,
 *   readStore?: () => { refreshToken: string, expiresAt: string },
 *   refreshAccess?: (prefix: string, refreshToken: string, timeoutSec: number) => Promise<{ accessToken: string, expiresAt: string }>,
 *   persist?: (tokens: { refreshToken: string, accessToken?: string, expiresAt?: string }) => void,
 *   taskPrefix?: () => string,
 *   log?: (line: string) => void,
 * }} [deps]
 * @returns {Promise<'skipped'|'refreshed'|'failed'>}
 */
export async function maybeProactiveRefreshAccess(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : appendLog;
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRAE_SKIP_PROACTIVE_ACCESS_REFRESH || '').toLowerCase())) {
    return 'skipped';
  }
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE || '').toLowerCase())) {
    return 'skipped';
  }

  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  const skewMs = Number.isFinite(deps.skewMs) ? deps.skewMs : proactiveRefreshSkewMsFromEnv();
  const readStore = typeof deps.readStore === 'function' ? deps.readStore : readPersistedTokenStore;
  const store = readStore() || {};
  const refreshToken = String(store.refreshToken || '').trim();
  if (!refreshToken) {
    return 'skipped';
  }

  const expiresAtMs = parseAccessExpiresAtMs(store.expiresAt);
  const lastRefreshAtMs = Number.isFinite(deps.lastRefreshAtMs) ? deps.lastRefreshAtMs : 0;
  const needsByTtl = accessTokenNeedsProactiveRefresh(expiresAtMs, nowMs, skewMs);
  const needsConservative =
    !Number.isFinite(expiresAtMs) &&
    shouldConservativeRefresh(lastRefreshAtMs, nowMs, CONSERVATIVE_REFRESH_INTERVAL_MS);
  if (!needsByTtl && !needsConservative) {
    return 'skipped';
  }

  let prefix = '';
  try {
    prefix = typeof deps.taskPrefix === 'function' ? deps.taskPrefix() : taskApiPrefix();
  } catch (e) {
    log(`token-refresh: proactive skip (task API prefix): ${e?.message || e}`);
    return 'skipped';
  }
  if (!prefix) return 'skipped';

  const reason = needsByTtl ? 'ttl-skew' : 'conservative-no-expires';
  log(`token-refresh: proactive begin reason=${reason}`);
  const refreshAccess =
    typeof deps.refreshAccess === 'function' ? deps.refreshAccess : runRefreshAccessOnly;
  const persist = typeof deps.persist === 'function' ? deps.persist : writePersistedRefreshToken;
  try {
    const result = await refreshAccess(prefix, refreshToken, tokenExchangeTimeoutSec());
    const accessToken = String(result?.accessToken || '').trim();
    const expiresAt = String(result?.expiresAt || '').trim();
    if (!accessToken) {
      log('token-refresh: proactive FAIL empty access_token');
      return 'failed';
    }
    persist({ refreshToken, accessToken, expiresAt });
    log('token-refresh: proactive OK ACCESS_TOKEN env updated');
    return 'refreshed';
  } catch (e) {
    log(`token-refresh: proactive FAIL ${e?.message || e}`);
    return 'failed';
  }
}

/**
 * @param {{
 *   maybeRefresh?: typeof maybeProactiveRefreshAccess,
 *   pollMs?: number,
 *   log?: (line: string) => void,
 * }} [opts]
 * @returns {() => void} stop
 */
export function startProactiveAccessRefreshLoop(opts = {}) {
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRAE_SKIP_PROACTIVE_ACCESS_REFRESH || '').toLowerCase())) {
    return () => {};
  }
  const maybeRefresh =
    typeof opts.maybeRefresh === 'function' ? opts.maybeRefresh : maybeProactiveRefreshAccess;
  const log = typeof opts.log === 'function' ? opts.log : appendLog;
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs >= 5000 ? opts.pollMs : pollIntervalMsFromEnv();

  let inFlight = false;
  let lastRefreshAtMs = 0;
  let consecutiveFailures = 0;

  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void maybeRefresh({ lastRefreshAtMs, log })
      .then((status) => {
        if (status === 'refreshed') {
          lastRefreshAtMs = Date.now();
          consecutiveFailures = 0;
        } else if (status === 'failed') {
          consecutiveFailures += 1;
          if (consecutiveFailures === 1 || consecutiveFailures % 3 === 0) {
            console.error(
              `[onlineServiceJS] proactive access refresh failed consecutive=${consecutiveFailures}`,
            );
          }
        }
      })
      .finally(() => {
        inFlight = false;
      });
  };

  tick();
  const intervalId = setInterval(tick, pollMs);
  if (typeof intervalId.unref === 'function') intervalId.unref();
  return () => clearInterval(intervalId);
}
