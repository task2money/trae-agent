/**
 * ACCESS_TOKEN 校验与换票失败 fail-closed 门禁。
 *
 * 换票失败且非 strict 时不得继续用无效 ACCESS_TOKEN 对外提供受保护 API
 *（平台 by-scope token 与容器 env 不一致会导致全线 401）。
 */

let tokenBootstrapFailed = false;
let tokenBootstrapFailReason = '';

/** @param {boolean} failed @param {string} [reason] */
export function setTokenBootstrapFailed(failed, reason = '') {
  tokenBootstrapFailed = Boolean(failed);
  tokenBootstrapFailReason = failed ? String(reason || '').trim() : '';
}

export function isTokenBootstrapFailed() {
  return tokenBootstrapFailed;
}

export function getTokenBootstrapFailReason() {
  return tokenBootstrapFailReason;
}

export function tokenBootstrapFailClosedDetail() {
  const base =
    'token bootstrap failed; protected APIs unavailable until valid ACCESS_TOKEN exchange';
  return tokenBootstrapFailReason ? `${base}: ${tokenBootstrapFailReason}` : base;
}

/**
 * @param {import('express').Response} res
 * @returns {import('express').Response}
 */
export function respondTokenBootstrapFailClosed(res) {
  return res.status(503).json({
    detail: tokenBootstrapFailClosedDetail(),
    error_code: 'TOKEN_BOOTSTRAP_FAILED',
  });
}

export function accessTokenExpected() {
  return String(process.env.ACCESS_TOKEN || '').trim();
}

export function authMiddleware(req, res, next) {
  if (tokenBootstrapFailed) {
    respondTokenBootstrapFailClosed(res);
    return;
  }
  const expected = accessTokenExpected();
  if (!expected) {
    res.status(503).json({ detail: 'ACCESS_TOKEN not configured' });
    return;
  }
  const q = req.query?.access_token;
  const h = req.headers['x-access-token'];
  const tok = (typeof q === 'string' ? q : '') || (typeof h === 'string' ? h : '');
  if (tok !== expected) {
    res.status(401).json({ detail: 'Invalid or missing access token' });
    return;
  }
  next();
}
