/**
 * TaskApi JSON POST：瞬时断连重试 + loopback 主机回退 + 调试出站日志。
 * 从 saasTaskCloud.mjs 抽出，作为所有 SaaS POST（换票/心跳/层图推送/克隆进度）的汇合点（OPT-20260815-023）。
 */
import {
  appendOutboundReqLog,
  sanitizeUrlForOutboundLog,
  isDebugAgentEnabled,
  debugAgentStringify,
} from './outboundReqLog.mjs';
import { traceHeadersForOutbound } from './traceId.mjs';
import { withSaasInboundScope } from './saasInboundScope.mjs';

function loopbackFallbackUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
      return parsed.toString();
    }
    if (parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'localhost';
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function fetchCauseCode(err) {
  const code = err && typeof err === 'object' ? err?.cause?.code : '';
  return String(code || '').trim();
}

function isAbortLikeError(err) {
  const names = [
    String(err?.name || ''),
    String(err?.cause?.name || ''),
    fetchCauseCode(err),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (names.includes('abort')) return true;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('aborted') || msg.includes('timeout');
}

export function formatErrorWithCause(err) {
  const message = String(err?.message || err || '').trim();
  const code = fetchCauseCode(err);
  const causeMessage = String(err?.cause?.message || '').trim();
  const extra = [];
  if (code) extra.push(code);
  if (causeMessage && causeMessage !== message) extra.push(causeMessage);
  if (!extra.length) return message;
  return `${message} (${extra.join(': ')})`;
}

function normalizePostJsonError(err) {
  const detail = formatErrorWithCause(err);
  if (detail === String(err?.message || err || '').trim()) return err;
  const wrapped = new Error(detail);
  if (err && typeof err === 'object' && err.structuredPayload) {
    wrapped.structuredPayload = err.structuredPayload;
  }
  return wrapped;
}

/** APISIX/nginx 在上游重启、路由未注册时常见；401/400/403 仍视为永久业务错误。 */
export const TRANSIENT_HTTP_STATUS = new Set([404, 408, 409, 425, 429, 502, 503, 504]);

export function isTransientHttpStatus(status) {
  const n = Number(status);
  return Number.isFinite(n) && TRANSIENT_HTTP_STATUS.has(n);
}

function httpStatusFromError(err) {
  const flagged = Number(err?.retryableHttpStatus);
  if (Number.isFinite(flagged) && flagged > 0) return flagged;
  const msg = String(err?.message || err || '');
  const m = msg.match(/\bHTTP\s+(\d{3})\b/i);
  if (m) return Number(m[1]);
  return 0;
}

function isRetryableLoopbackFetchError(err) {
  if (!err || typeof err !== 'object') return false;
  if (isAbortLikeError(err)) return false;
  if (isTransientHttpStatus(httpStatusFromError(err))) return true;
  if (err.structuredPayload) return false;
  const code = fetchCauseCode(err).toUpperCase();
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('connection reset') ||
    msg.includes('connection refused') ||
    msg.includes('und_err_socket') ||
    msg.includes('other side closed')
  );
}

/**
 * TaskApi 瞬时断连重试次数（含首次）。默认 5：覆盖 runAll 重启/端口短暂不可达窗口。
 * 环境变量 `TASK_API_POST_JSON_TRANSIENT_RETRIES`。
 */
export function postJsonTransientRetryConfigFromEnv() {
  const retriesRaw = parseInt(String(process.env.TASK_API_POST_JSON_TRANSIENT_RETRIES || '5'), 10);
  const backoffRaw = parseInt(String(process.env.TASK_API_POST_JSON_TRANSIENT_BACKOFF_MS || '400'), 10);
  const maxAttempts = Number.isFinite(retriesRaw) ? Math.max(1, Math.min(20, retriesRaw)) : 5;
  const backoffMs = Number.isFinite(backoffRaw) ? Math.max(50, Math.min(10000, backoffRaw)) : 400;
  return { maxAttempts, backoffMs };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * @param {string} url
 * @param {object} body
 * @param {number} [timeoutSec]
 * @param {{ reqLogFile?: string, traceId?: string, spanId?: string }} [opts]
 *   — `reqLogFile: 'heartbeat.log'` 时写入 reqLogs/heartbeat.log
 *   — `traceId` 转发请求的 X-Trace-Id；省略则用启动时 TRACE_ID env
 *   — `spanId` 当前请求的 span，作为下游 X-Parent-Span-Id
 */
export async function postJson(url, body, timeoutSec = 8, opts = {}) {
  const payload = withSaasInboundScope(body);
  const reqLogFile = opts && typeof opts === 'object' ? opts.reqLogFile : undefined;
  const outboundTraceId = opts && typeof opts === 'object' ? opts.traceId : undefined;
  const outboundSpanId = opts && typeof opts === 'object' ? opts.spanId : undefined;
  const safeUrl = sanitizeUrlForOutboundLog(url);
  const fallbackUrl = loopbackFallbackUrl(url);
  const safeFallbackUrl = fallbackUrl ? sanitizeUrlForOutboundLog(fallbackUrl) : '';
  const t0 = Date.now();
  const logOpts = reqLogFile ? { filename: reqLogFile } : {};
  const hostAttempts = [url];
  if (fallbackUrl && fallbackUrl !== url) hostAttempts.push(fallbackUrl);
  const { maxAttempts, backoffMs } = postJsonTransientRetryConfigFromEnv();
  let lastErr = null;

  for (let round = 1; round <= maxAttempts; round += 1) {
    // 每轮独立超时，避免瞬时重试吃掉整段 timeout
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutSec * 1000);
    let idx = 0;
    try {
      while (idx < hostAttempts.length) {
        const targetUrl = hostAttempts[idx];
        const safeTargetUrl = sanitizeUrlForOutboundLog(targetUrl);
        const headers = traceHeadersForOutbound(outboundTraceId, outboundSpanId);
        try {
          if (isDebugAgentEnabled()) {
            appendOutboundReqLog(
              `DEBUG_AGENT outbound request method=POST url=${targetUrl} headers=${debugAgentStringify(headers)} body=${debugAgentStringify(payload)}`,
              logOpts,
            );
          }
          const r = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: ac.signal,
          });
          const text = await r.text();
          if (isDebugAgentEnabled()) {
            appendOutboundReqLog(
              `DEBUG_AGENT outbound response method=POST url=${targetUrl} status=${r.status} headers=${debugAgentStringify(Object.fromEntries(r.headers.entries()))} body=${text}`,
              logOpts,
            );
          }
          const ms = Date.now() - t0;
          appendOutboundReqLog(`postJson POST ${safeTargetUrl} -> HTTP ${r.status} ${ms}ms`, logOpts);
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            if (isTransientHttpStatus(r.status)) {
              const err = new Error(`HTTP ${r.status} ${targetUrl}: ${text.slice(0, 200)}`);
              err.retryableHttpStatus = r.status;
              throw err;
            }
            throw new Error(`Invalid JSON from ${targetUrl}: ${text.slice(0, 200)}`);
          }
          if (!r.ok) {
            const err = new Error(`HTTP ${r.status} ${targetUrl}: ${JSON.stringify(data).slice(0, 500)}`);
            if (data && typeof data === 'object' && data.error_code) {
              err.structuredPayload = data;
            }
            if (isTransientHttpStatus(r.status)) {
              err.retryableHttpStatus = r.status;
            }
            throw err;
          }
          return data;
        } catch (e) {
          if (isDebugAgentEnabled()) {
            appendOutboundReqLog(
              `DEBUG_AGENT outbound error method=POST url=${targetUrl} message=${formatErrorWithCause(e)}`,
              logOpts,
            );
          }
          if (
            idx === 0 &&
            hostAttempts.length > 1 &&
            isRetryableLoopbackFetchError(e) &&
            !String(e?.name || '').includes('AbortError')
          ) {
            appendOutboundReqLog(
              `postJson POST ${safeTargetUrl} -> retry loopback ${safeFallbackUrl} reason=${formatErrorWithCause(e).slice(0, 240)}`,
              logOpts,
            );
            idx += 1;
            continue;
          }
          throw normalizePostJsonError(e);
        }
      }
      throw new Error(`postJson exhausted attempts for ${safeUrl}`);
    } catch (e) {
      lastErr = normalizePostJsonError(e);
      const retryable =
        isRetryableLoopbackFetchError(lastErr) &&
        !isAbortLikeError(lastErr) &&
        !lastErr?.structuredPayload;
      if (!retryable || round >= maxAttempts) {
        const ms = Date.now() - t0;
        appendOutboundReqLog(
          `postJson POST ${safeUrl} -> error ${formatErrorWithCause(lastErr).slice(0, 400)} ${ms}ms`,
          logOpts,
        );
        throw lastErr;
      }
      const waitMs = backoffMs * round;
      appendOutboundReqLog(
        `postJson POST ${safeUrl} -> transient retry ${round}/${maxAttempts} after ${waitMs}ms reason=${formatErrorWithCause(lastErr).slice(0, 240)}`,
        logOpts,
      );
      await sleepMs(waitMs);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error(`postJson exhausted attempts for ${safeUrl}`);
}
