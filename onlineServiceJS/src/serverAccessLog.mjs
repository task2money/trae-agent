import fs from 'fs';
import path from 'path';
import { logsDir } from './paths.mjs';
import { logJson } from './jsonLog.mjs';
import { TRACE_HEADER } from './traceId.mjs';

const accessLogPath = () => path.join(logsDir(), 'requests.log');
function logReq(req, res, start, statusOverride) {
  try {
    const ms = Date.now() - start;
    const tid = String(res.getHeader(TRACE_HEADER) || req.headers[TRACE_HEADER.toLowerCase()] || '')
      .trim()
      .replace(/\s+/g, '_');
    const status =
      statusOverride != null ? statusOverride : res.statusCode;
    logJson('info', 'http_request', {
      trace_id: tid || undefined,
      method: req.method,
      path: req.originalUrl,
      status: String(status),
      duration_ms: ms,
    });
    const line = `${req.ip || '-'} trace=${tid || '-'} "${req.method} ${req.originalUrl}" ${status} ${ms}ms\n`;
    fs.mkdirSync(path.dirname(accessLogPath()), { recursive: true });
    fs.appendFileSync(accessLogPath(), `${new Date().toISOString()} | ${line}`);
  } catch {
    /* ignore */
  }
}
/** 下行心跳探测极高频，写入 stdout/requests.log 会刷屏「启动日志」；状态改由任务详情「容器连接状态」展示 */
function isSaasHeartbeatProbePath(req) {
  const raw = String(req?.originalUrl || req?.url || '');
  const pathOnly = raw.split('?')[0];
  return (
    pathOnly === '/api/saas-heartbeat-probe' ||
    pathOnly.endsWith('/api/saas-heartbeat-probe') ||
    pathOnly === '/saas-heartbeat-probe' ||
    pathOnly.endsWith('/saas-heartbeat-probe')
  );
}

export function registerServerAccessLogMiddleware(app) {
  app.use((req, res, next) => {
    if (isSaasHeartbeatProbePath(req)) {
      return next();
    }
    const s = Date.now();
    let logged = false;
    const runLog = (statusOverride) => {
      if (logged) return;
      logged = true;
      logReq(req, res, s, statusOverride);
    };
    res.on('finish', () => runLog(undefined));
    res.on('close', () => {
      if (!logged) runLog('aborted');
    });
    next();
  });
}
