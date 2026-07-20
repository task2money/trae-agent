import {
  appendOutboundReqLog,
  isDebugAgentEnabled,
  debugAgentStringify,
} from './outboundReqLog.mjs';

export function createDebugAgentInboundLoggerMiddleware({
  isEnabled = isDebugAgentEnabled,
  appendLog = appendOutboundReqLog,
  stringify = debugAgentStringify,
} = {}) {
  return (req, res, next) => {
    if (!isEnabled()) return next();
    const requestHeaders = { ...req.headers };
    const requestBody = req.body;
    let responseBody;
    const origJson = typeof res.json === 'function' ? res.json.bind(res) : null;
    const origSend = typeof res.send === 'function' ? res.send.bind(res) : null;
    if (origJson) {
      res.json = (payload) => {
        responseBody = payload;
        return origJson(payload);
      };
    }
    if (origSend) {
      res.send = (payload) => {
        responseBody = payload;
        return origSend(payload);
      };
    }
    res.on('finish', () => {
      try {
        const responseHeaders =
          typeof res.getHeaders === 'function' ? res.getHeaders() : {};
        appendLog(
          `DEBUG_AGENT inbound request method=${req.method} url=${req.originalUrl} headers=${stringify(requestHeaders)} body=${stringify(requestBody)} response_status=${res.statusCode} response_headers=${stringify(responseHeaders)} response_body=${stringify(responseBody)}`,
        );
      } catch {
        /* ignore */
      }
    });
    next();
  };
}
