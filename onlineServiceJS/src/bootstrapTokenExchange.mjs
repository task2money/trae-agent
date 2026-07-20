import fs from 'fs';
import path from 'path';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import { logsDir } from './paths.mjs';
import { rewriteDockerInternal, taskApiPrefix } from './saasTaskCloud.mjs';
import { hostMappedHttpPort } from './reachability.mjs';
import { rememberStaleAccessToken } from './uiAccessToken.mjs';
import { setBootstrapReposLayoutReady } from './bootstrapCloneLayoutSeal.mjs';
import {
  setBootstrapCloneLayerId,
  setBootstrapRegisterCloneJob,
  setBootstrapRepoLogState,
} from './bootstrapState.mjs';
import { postJsonWithAbortRetry } from './bootstrapRepoInputs.mjs';
import {
  formatTokenExchangeFailureLog,
  isExchangeRefreshFallbackEligibleError,
  isExchangeRefreshForbiddenError,
  isPersistedRefreshTokenStoreError,
  readPersistedRefreshToken,
  writePersistedRefreshToken,
} from './bootstrapTokenStore.mjs';

/** 换票专用日志：onlineProject_state/logs/tokenRefresh.log，便于与 reqLogs/outbound.log 区分排查 */
function appendTokenRefreshLog(line) {
  try {
    fs.appendFileSync(path.join(logsDir(), 'tokenRefresh.log'), `${new Date().toISOString()} | ${line}\n`);
  } catch {
    /* ignore */
  }
}

/** 换票调试：不落库明文，仅长度等摘要。 */
function summarizeSecret(value) {
  const s = String(value || '');
  if (!s) return '(empty)';
  return `len=${s.length}`;
}

function logTokenExchange(line) {
  const msg = `token-exchange: ${line}`;
  appendOutboundReqLog(msg);
  appendTokenRefreshLog(msg);
  console.log(`[onlineServiceJS] ${msg}`);
}

/**
 * 规范化换票用的 business_api_endpoint：
 * - 编排模板常见错误 `http://<ip>:/api`（`${PORT}` 为空）在部分校验器下非法；WHATWG URL 会折叠为无端口 origin。
 * - 若折叠后仍无显式端口且 host 像可达 IP/localhost：补全为 {@link hostMappedHttpPort}（与 listen / register-reachability 一致，含 PORT 未设时默认 8765）。
 */
function normalizeBusinessApiEndpointUrl(raw) {
  let candidate = String(raw || '').trim();
  if (!candidate) return candidate;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `http://${candidate}`;
  }
  let u;
  try {
    u = new URL(candidate);
  } catch {
    throw new Error(`Invalid BusinessApiEndPoint/BUSINESS_API_ENDPOINT (not a valid URL): ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('BusinessApiEndPoint must be http or https');
  }
  const host = u.hostname || '';
  const looksLikeIp =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost';
  if (!u.port && looksLikeIp) {
    u.port = String(hostMappedHttpPort());
  }
  return u.href.replace(/\/$/, '');
}

function businessApiEndpoint() {
  let raw = String(process.env.BusinessApiEndPoint || process.env.BUSINESS_API_ENDPOINT || '').trim();
  if (!raw) {
    throw new Error('BusinessApiEndPoint/BUSINESS_API_ENDPOINT empty');
  }
  raw = rewriteDockerInternal(raw);
  return normalizeBusinessApiEndpointUrl(raw);
}

/** 仅当显式设置 TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE 时跳过换票（本地/unit 专用）。勿用语义启发式跳过：SSH 隧道把远端 SaaS 映射到 127.0.0.1 时会误判并导致 DB 中 container_refresh_token 永不写入。 */
function skipContainerTokenExchangeByEnv() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE || '').trim().toLowerCase(),
  );
}

function bootstrapTimeoutSec() {
  return Math.max(1, parseFloat(process.env.TASK_API_BOOTSTRAP_TIMEOUT_SEC || '15') || 15);
}

function tokenExchangeTimeoutSec() {
  const raw = String(process.env.TASK_API_TOKEN_EXCHANGE_TIMEOUT_SEC || '').trim();
  if (!raw) return bootstrapTimeoutSec();
  return Math.max(1, parseFloat(raw) || 15);
}

export async function runRefreshAccessOnly(prefix, refreshToken, tokenTimeout) {
  const rt = String(refreshToken || '').trim();
  if (!rt) throw new Error('refresh-access: empty refresh_token');
  logTokenExchange(
    `POST ${prefix}/server-container-token/refresh-access/ refresh_token ${summarizeSecret(rt)}`,
  );
  const ref = await postJsonWithAbortRetry(
    `${prefix}/server-container-token/refresh-access/`,
    { refresh_token: rt },
    tokenTimeout,
    'refresh-access',
    logTokenExchange,
  );
  const at = ref.access_token;
  if (!at || typeof at !== 'string') throw new Error('refresh-access missing access_token');
  const prevAccess = String(process.env.ACCESS_TOKEN || '').trim();
  if (prevAccess && prevAccess !== at) {
    rememberStaleAccessToken(prevAccess);
  }
  process.env.ACCESS_TOKEN = at;
  const expiresAt = String(ref.expires_at || '').trim();
  logTokenExchange(
    `refresh-access OK new_access_token ${summarizeSecret(at)} ACCESS_TOKEN env updated`,
  );
  return { accessToken: at, expiresAt };
}

/**
 * HTTP 监听前：解析 TaskApi 前缀并完成换票（若需要）。
 * 任务详情拉取、仓库克隆、service_config.yaml 写入在 {@link runBootstrapAfterListen}（由 `server.mjs`
 * 在 register-reachability 与 SaaS 心跳启动之后异步执行，避免克隆阻塞 `server_url` 与心跳）。
 */
export async function runBootstrapTokenExchangeOnly() {
  setBootstrapCloneLayerId(null);
  setBootstrapRepoLogState(null);
  setBootstrapRegisterCloneJob(false);
  setBootstrapReposLayoutReady(false);
  let prefix;
  try {
    prefix = taskApiPrefix();
  } catch (e) {
    const skipLine = `bootstrap skip: ${e.message}`;
    appendOutboundReqLog(skipLine);
    appendTokenRefreshLog(skipLine);
    return { skipped: true };
  }
  if (!prefix) {
    const skipLine = 'bootstrap skip: empty task API prefix';
    appendOutboundReqLog(skipLine);
    appendTokenRefreshLog(skipLine);
    return { skipped: true };
  }

  const timeout = bootstrapTimeoutSec();
  const tokenTimeout = tokenExchangeTimeoutSec();
  let business;
  try {
    business = businessApiEndpoint();
  } catch (e) {
    const line = `bootstrap: business API endpoint: ${e && e.message ? String(e.message) : String(e)}`;
    appendOutboundReqLog(line);
    appendTokenRefreshLog(line);
    throw e;
  }
  let newAccess = String(process.env.ACCESS_TOKEN || '').trim();
  if (!newAccess) {
    const failLine = 'token-exchange: FAIL ACCESS_TOKEN empty for bootstrap';
    appendTokenRefreshLog(failLine);
    throw new Error('ACCESS_TOKEN empty for bootstrap');
  }

  logTokenExchange(
    `begin prefix=${prefix} timeout_sec=${timeout} token_timeout_sec=${tokenTimeout} business_api_endpoint=${business} initial_access_token ${summarizeSecret(newAccess)}`,
  );

  if (!skipContainerTokenExchangeByEnv()) {
    try {
      let refreshToken = '';
      try {
        logTokenExchange(`POST ${prefix}/server-container-token/exchange-refresh/`);
        const ex = await postJsonWithAbortRetry(
          `${prefix}/server-container-token/exchange-refresh/`,
          { access_token: newAccess, business_api_endpoint: business },
          tokenTimeout,
          'exchange-refresh',
          logTokenExchange,
        );
        refreshToken = ex.refresh_token;
        if (!refreshToken) throw new Error('exchange-refresh missing refresh_token');
        logTokenExchange(`exchange-refresh OK refresh_token ${summarizeSecret(refreshToken)}`);
        writePersistedRefreshToken({ refreshToken });
      } catch (e) {
        if (!isExchangeRefreshFallbackEligibleError(e)) {
          throw e;
        }
        const reason = isExchangeRefreshForbiddenError(e)
          ? '403 already-exchanged'
          : '401 invalid/expired access';
        refreshToken = readPersistedRefreshToken();
        if (!refreshToken) {
          logTokenExchange(
            `exchange-refresh ${reason} and no persisted refresh_token; run env-prepare / 重新生成令牌 before start`,
          );
          throw e;
        }
        logTokenExchange(
          `exchange-refresh ${reason}: fallback to refresh-access using persisted refresh_token`,
        );
        const fb = await runRefreshAccessOnly(prefix, refreshToken, tokenTimeout);
        newAccess = fb.accessToken;
        writePersistedRefreshToken({
          refreshToken,
          accessToken: newAccess,
          expiresAt: fb.expiresAt,
        });
        logTokenExchange('done (refresh-access fallback)');
        return { skipped: false, prefix, newAccess, timeout };
      }

      const refreshed = await runRefreshAccessOnly(prefix, refreshToken, tokenTimeout);
      newAccess = refreshed.accessToken;
      writePersistedRefreshToken({
        refreshToken,
        accessToken: newAccess,
        expiresAt: refreshed.expiresAt,
      });
      logTokenExchange('done');
    } catch (e) {
      const failLine = formatTokenExchangeFailureLog(e);
      appendOutboundReqLog(failLine);
      appendTokenRefreshLog(failLine);
      const tag = isPersistedRefreshTokenStoreError(e) ? 'FAIL_PERSIST' : 'FAIL';
      console.error(`[onlineServiceJS] token-exchange: ${tag}`, e);
      throw e;
    }
  } else {
    const skipExLine = 'bootstrap: skip exchange (TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE)';
    appendOutboundReqLog(skipExLine);
    appendTokenRefreshLog(skipExLine);
    logTokenExchange('skipped (TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE), using initial ACCESS_TOKEN as-is');
  }

  return { skipped: false, prefix, newAccess, timeout };
}
