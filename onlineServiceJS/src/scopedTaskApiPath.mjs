/**
 * Rewrite gateway-scoped API paths to bare /api/... for existing routers,
 * while keeping originalUrl for access logs (tenant/workspace/task visible).
 *
 * Gateway upstream example:
 *   /api/tenant/{t}/workspace/{w}/task/{task}/layers/...
 * becomes:
 *   /api/layers/...
 */
export function rewriteScopedTaskApiPath(pathname) {
  const raw = String(pathname || '');
  const m = raw.match(
    /^(\/api)\/tenant\/[^/]+\/workspace\/[^/]+\/task\/[^/]+(\/.*)?$/,
  );
  if (!m) return raw;
  const rest = m[2] && m[2] !== '/' ? m[2] : '';
  return `${m[1]}${rest}` || '/api';
}

/**
 * Express middleware: rewrite req.url for routing; leave originalUrl intact.
 */
export function createScopedTaskApiRewriteMiddleware() {
  return function scopedTaskApiRewrite(req, _res, next) {
    try {
      const original = String(req.originalUrl || req.url || '');
      const qIdx = original.indexOf('?');
      const pathOnly = qIdx >= 0 ? original.slice(0, qIdx) : original;
      const query = qIdx >= 0 ? original.slice(qIdx) : '';
      const rewritten = rewriteScopedTaskApiPath(pathOnly);
      if (rewritten !== pathOnly) {
        req.url = rewritten + query;
      }
    } catch {
      /* ignore rewrite errors; fall through to normal routing */
    }
    next();
  };
}
