/**
 * 换票后仍记住已作废的 bootstrap/旧 access_token，供控制台书签与打开中的页做安全重定向。
 * 仅「曾经是本进程 ACCESS_TOKEN」的值可换到当前 token，避免任意猜测撞库。
 */

const staleAccessTokens = new Set();
const MAX_STALE = 8;

/**
 * @param {string} token
 */
export function rememberStaleAccessToken(token) {
  const t = String(token || '').trim();
  if (!t) return;
  staleAccessTokens.add(t);
  while (staleAccessTokens.size > MAX_STALE) {
    const first = staleAccessTokens.values().next().value;
    staleAccessTokens.delete(first);
  }
}

/**
 * @param {string} token
 * @returns {boolean}
 */
export function isRememberedStaleAccessToken(token) {
  const t = String(token || '').trim();
  return Boolean(t) && staleAccessTokens.has(t);
}

/**
 * @param {string} pathToken URL 路径中的 access_token
 * @param {string} currentToken process.env.ACCESS_TOKEN
 * @returns {{ ok: true, serveToken: string } | { ok: false, redirectTo: string } | { ok: false, unauthorized: true }}
 */
export function resolveUiPathAccessToken(pathToken, currentToken) {
  const pathTok = String(pathToken || '').trim();
  const current = String(currentToken || '').trim();
  if (!current) {
    return { ok: false, unauthorized: true };
  }
  if (pathTok && pathTok === current) {
    return { ok: true, serveToken: current };
  }
  if (pathTok && isRememberedStaleAccessToken(pathTok)) {
    return { ok: false, redirectTo: `/ui/${encodeURIComponent(current)}` };
  }
  return { ok: false, unauthorized: true };
}

/** @returns {string[]} */
export function listRememberedStaleAccessTokensForTest() {
  return [...staleAccessTokens];
}

export function clearRememberedStaleAccessTokensForTest() {
  staleAccessTokens.clear();
}
