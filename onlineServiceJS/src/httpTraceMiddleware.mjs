import { startHttpSpan } from './otel.mjs';
import { isTraceIdOnlyRequest, resolveInboundCorrelation, SPAN_HEADER, TRACE_HEADER } from './traceId.mjs';
import { formatTraceparent } from './otelTraceId.mjs';

export function traceMiddleware(req, res, next) {
  if (isTraceIdOnlyRequest(req)) {
    res.status(400).json({
      detail:
        'trace propagation incomplete: require X-Parent-Span-Id or traceparent with X-Trace-Id',
    });
    return;
  }
  const corr = resolveInboundCorrelation(req, cryptoRandomId);
  res.setHeader(TRACE_HEADER, corr.traceId);
  res.setHeader(SPAN_HEADER, corr.spanId);
  const tp = formatTraceparent(corr.traceId, corr.spanId);
  if (tp) res.setHeader('traceparent', tp);
  req.traceId = corr.traceId;
  req.spanId = corr.spanId;
  req.parentSpanId = corr.parentSpanId;
  const { end } = startHttpSpan(req, corr);
  let ended = false;
  const finishSpan = () => {
    if (ended) return;
    ended = true;
    end();
  };
  res.on('finish', finishSpan);
  res.on('close', finishSpan);
  next();
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
