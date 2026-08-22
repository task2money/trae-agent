/**
 * 把 credential 换票结果整理成 oauth-access-push 入参。
 * GitLab 必须走 oauth_auth_by_repo（{provider, access_token}），
 * 不能把 match_key 字符串图当成 github owner/repo slug。
 */
import { collectOauthRepoWriteTargets } from './layerGitOauthFetchTokenFiles.mjs';
import { canonicalRepoKey } from './repoMatchKey.mjs';

function tokenFromMap(map, key) {
  if (!map || !key) return '';
  const raw = map[key] ?? map[String(key).toLowerCase()];
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object') {
    return String(raw.access_token || raw.accessToken || '').trim();
  }
  return '';
}

/**
 * @param {object|null|undefined} tokenPayload
 * @param {string} layerId
 * @param {{ collectOauthRepoWriteTargets?: typeof collectOauthRepoWriteTargets }} [deps]
 * @returns {{ accessTokenByRepoSlug: Record<string, string>, oauthAuthByRepo: Record<string, { provider: string, access_token: string }> }}
 */
export function buildOauthAccessPushAuthFromTokenPayload(tokenPayload, layerId, deps = {}) {
  const collect = deps.collectOauthRepoWriteTargets || collectOauthRepoWriteTargets;
  const githubAuth =
    tokenPayload && typeof tokenPayload.github_auth_by_repo === 'object' && tokenPayload.github_auth_by_repo
      ? { ...tokenPayload.github_auth_by_repo }
      : {};
  const matchMap =
    tokenPayload && typeof tokenPayload.git_auth_by_repo_match_key === 'object'
      && tokenPayload.git_auth_by_repo_match_key
      ? tokenPayload.git_auth_by_repo_match_key
      : {};
  const oauthAuthByRepo =
    tokenPayload && typeof tokenPayload.oauth_auth_by_repo === 'object' && tokenPayload.oauth_auth_by_repo
      ? { ...tokenPayload.oauth_auth_by_repo }
      : {};

  const targets = typeof collect === 'function' ? collect(layerId) : [];
  for (const t of targets) {
    const matchKey = String(t?.repoMatchKey || '').trim();
    const origin = String(t?.originUrl || '').trim();
    const slug = String(t?.githubSlug || '').trim();
    const tokenStr =
      tokenFromMap(matchMap, matchKey) ||
      tokenFromMap(githubAuth, slug) ||
      tokenFromMap(githubAuth, slug.toLowerCase());
    if (!tokenStr) continue;
    const provider = slug ? 'github' : 'gitlab';
    const entry = { provider, access_token: tokenStr };
    if (origin) oauthAuthByRepo[canonicalRepoKey(origin)] = entry;
    if (matchKey) oauthAuthByRepo[matchKey.toLowerCase()] = entry;
  }
  return { accessTokenByRepoSlug: githubAuth, oauthAuthByRepo };
}

export function tokenPayloadHasPushAuth(auth) {
  const slugs = auth?.accessTokenByRepoSlug && Object.keys(auth.accessTokenByRepoSlug).length;
  const oauth = auth?.oauthAuthByRepo && Object.keys(auth.oauthAuthByRepo).length;
  return Boolean(slugs || oauth);
}
