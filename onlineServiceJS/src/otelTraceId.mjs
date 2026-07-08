import { createHash, randomBytes } from 'node:crypto';

const HEX32 = /^[0-9a-f]{32}$/i;

/** Map X-Trace-Id to Tempo-compatible 32-char hex (matches Python/Go). */
export function otelTraceIdHex(externalId) {
  const raw = String(externalId || '').trim();
  const compact = raw.replace(/-/g, '');
  if (HEX32.test(compact)) return compact.toLowerCase();
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function randomSpanIdHex() {
  return randomBytes(8).toString('hex');
}

const TRACEPARENT_RE = /^00-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$/i;

export function parseTraceparent(raw) {
  const s = String(raw || '').trim();
  const m = TRACEPARENT_RE.exec(s);
  if (!m) return null;
  let parent = m[2].toLowerCase();
  if (parent === '0000000000000000') parent = '';
  return { traceId: `tp-${m[1].toLowerCase()}`, parentSpanId: parent };
}

export function formatTraceparent(traceId, spanId) {
  const tid = String(traceId || '').trim();
  if (!tid) return '';
  const traceHex = otelTraceIdHex(tid);
  const parentHex = String(spanId || '').trim().toLowerCase() || '0000000000000000';
  return `00-${traceHex}-${parentHex}-01`;
}
