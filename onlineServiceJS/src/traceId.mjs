import { formatTraceparent, parseTraceparent, randomSpanIdHex } from './otelTraceId.mjs';

export const TRACE_HEADER = 'X-Trace-Id';
export const SPAN_HEADER = 'X-Span-Id';
export const PARENT_SPAN_HEADER = 'X-Parent-Span-Id';
export const TRACEPARENT_HEADER = 'traceparent';

const SAFE_TRACE = /^[A-Za-z0-9._:-]{8,256}$/;
const HEX16 = /^[0-9a-fA-F]{16}$/;

function normalizeSpanId(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 32 || !HEX16.test(s)) return '';
  return s.toLowerCase();
}

export function startupTraceId() {
  return String(process.env.TRACE_ID || '').trim();
}

export function traceIdFromRequest(req) {
  if (!req) return '';
  const fromReq = String(req.traceId || '').trim();
  if (fromReq) return fromReq;
  const h = req.headers?.[TRACE_HEADER.toLowerCase()] ?? req.headers?.[TRACE_HEADER];
  return String(h || '').trim();
}

export function spanIdFromRequest(req) {
  if (!req) return '';
  const fromReq = String(req.spanId || '').trim();
  if (fromReq) return fromReq;
  const h = req.headers?.[SPAN_HEADER.toLowerCase()] ?? req.headers?.[SPAN_HEADER];
  return normalizeSpanId(h);
}

function parentSpanIdFromRequest(req) {
  if (!req) return '';
  const fromReq = String(req.parentSpanId || '').trim();
  if (fromReq) return normalizeSpanId(fromReq);
  const h = req.headers?.[PARENT_SPAN_HEADER.toLowerCase()] ?? req.headers?.[PARENT_SPAN_HEADER];
  return normalizeSpanId(h);
}

function normalizeTraceId(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 256 || !SAFE_TRACE.test(s)) return '';
  return s;
}

/** True when legacy callers send X-Trace-Id without parent span / traceparent. */
export function isTraceIdOnlyRequest(req) {
  const tid = normalizeTraceId(
    req?.headers?.[TRACE_HEADER.toLowerCase()] ?? req?.headers?.[TRACE_HEADER],
  );
  if (!tid) return false;
  if (parentSpanIdFromRequest(req)) return false;
  if (parseTraceparent(req?.headers?.[TRACEPARENT_HEADER] ?? req?.headers?.traceparent)) return false;
  return true;
}

/** Resolve inbound trace/span; always generates a new span id for this hop. */
export function resolveInboundCorrelation(req, newTraceIdFn) {
  const headerTrace = normalizeTraceId(
    req?.headers?.[TRACE_HEADER.toLowerCase()] ?? req?.headers?.[TRACE_HEADER],
  );
  let parentSpanId = parentSpanIdFromRequest(req);
  let tid =
    headerTrace ||
    normalizeTraceId(traceIdFromRequest(req)) ||
    (typeof newTraceIdFn === 'function' ? normalizeTraceId(newTraceIdFn()) : '');
  if (!tid) {
    const tp = parseTraceparent(req?.headers?.[TRACEPARENT_HEADER] ?? req?.headers?.traceparent);
    if (tp) {
      tid = tp.traceId;
      if (!parentSpanId) parentSpanId = tp.parentSpanId;
    }
  }
  return {
    traceId: tid,
    spanId: randomSpanIdHex(),
    parentSpanId,
  };
}

/**
 * Logs: explicit trace_id > request trace > startup env (only when useStartupEnv or no req).
 * Request-scoped logs must not fall back to stale process.env.TRACE_ID from container start.
 */
export function resolveTraceId({ traceId, req, useStartupEnv = false } = {}) {
  const explicit = String(traceId || '').trim();
  if (explicit) return explicit;
  const fromReq = traceIdFromRequest(req);
  if (fromReq) return fromReq;
  if (req) return '';
  if (useStartupEnv) return startupTraceId();
  return startupTraceId();
}

/**
 * Outbound SaaS: explicit traceId arg > startup env (bootstrap/heartbeat).
 * Pass req.traceId from HTTP handlers; omit for startup-only calls.
 */
export function resolveOutboundTraceId(traceIdOpt) {
  if (traceIdOpt !== undefined && traceIdOpt !== null) {
    return String(traceIdOpt).trim();
  }
  return startupTraceId();
}

export function traceHeadersForOutbound(traceIdOpt, spanIdOpt) {
  const headers = { 'Content-Type': 'application/json' };
  const tid = resolveOutboundTraceId(traceIdOpt);
  if (tid) headers[TRACE_HEADER] = tid;
  const sid = normalizeSpanId(spanIdOpt);
  if (sid) headers[PARENT_SPAN_HEADER] = sid;
  const tp = formatTraceparent(tid, sid);
  if (tp) headers[TRACEPARENT_HEADER] = tp;
  return headers;
}

export function traceHeadersFromRequest(req) {
  const tid = traceIdFromRequest(req);
  const sid = spanIdFromRequest(req);
  return traceHeadersForOutbound(tid || undefined, sid || undefined);
}
