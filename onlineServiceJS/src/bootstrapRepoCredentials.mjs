import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizeRepoUrlForHttpsClone } from './gitRemote.mjs';
import { postJson } from './saasTaskCloud.mjs';
import { appendOutboundReqLog } from './outboundReqLog.mjs';

/**
 * 从 task-detail 收集待克隆仓库（URL + 可选 clone_alias / parent_repo_url）。
 * 优先 `git_repo_entries`；否则回退 `git_repos` 字符串列表。
 * 项目 `auto_clone_nested_repos=false` 时跳过带 parent_repo_url 的子仓（镜像侧门控）。
 * @returns {{ url: string, cloneAlias: string, parentRepoUrl: string }[]}
 */
export function collectRepoCloneJobs(taskDetail) {
  const out = [];
  const seen = new Set();
  let skippedNested = 0;
  function add(rawUrl, rawAlias, rawParent) {
    const u = String(rawUrl || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({
      url: u,
      cloneAlias: String(rawAlias || '').trim(),
      parentRepoUrl: String(rawParent || '').trim(),
    });
  }
  function walkEntries(entries, allowNested) {
    if (!Array.isArray(entries)) return false;
    let any = false;
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const url = e.url || e.repo_url || e.git_repo;
      if (!url) continue;
      const parent = String(e.parent_repo_url || e.parentRepoUrl || '').trim();
      if (!allowNested && parent) {
        skippedNested += 1;
        continue;
      }
      add(url, e.clone_alias || e.alias || '', parent);
      any = true;
    }
    return any;
  }
  function walk(value) {
    if (typeof value === 'string') {
      add(value, '', '');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      const allowNested = projectAllowsNestedClone(value);
      if (walkEntries(value.git_repo_entries, allowNested)) {
        return;
      }
      add(
        value.git_repo || value.url || value.repo_url,
        value.clone_alias || value.alias || '',
        value.parent_repo_url || value.parentRepoUrl || '',
      );
      if (value.git_repos != null) walk(value.git_repos);
    }
  }
  const allowNested = nestedAllowedFromDetail(taskDetail);
  if (taskDetail?.project_repos) walk(taskDetail.project_repos);
  if (taskDetail?.git_repo_entries) walkEntries(taskDetail.git_repo_entries, allowNested);
  if (taskDetail?.git_repos) walk(taskDetail.git_repos);
  const taskObj = taskDetail?.task;
  if (taskObj && typeof taskObj === 'object') {
    if (taskObj.git_repo_entries) walkEntries(taskObj.git_repo_entries, allowNested);
    if (taskObj.git_repos) walk(taskObj.git_repos);
    const params = taskObj.parameters;
    if (params && typeof params === 'object') {
      for (const k of ['git_repo_entries', 'git_repos', 'project_urls', 'project_repos', 'repos', 'repositories']) {
        if (params[k]) walk(params[k]);
      }
    }
  }
  if (skippedNested > 0) {
    appendOutboundReqLog(
      `bootstrap-clone skip nested repos count=${skippedNested} reason=auto_clone_nested_repos=false`,
    );
  }
  return out;
}

/** 任一 project_repos 快照关闭子仓克隆时，顶层 git_repo_entries 也跳过 nested。 */
export function nestedAllowedFromDetail(taskDetail) {
  const repos = taskDetail?.project_repos;
  if (Array.isArray(repos) && repos.length) {
    return repos.every(projectAllowsNestedClone);
  }
  return projectAllowsNestedClone(taskDetail?.project || taskDetail);
}

/** 缺省 true，与 project_entries.auto_clone_nested_repos DEFAULT 1 一致。 */
export function projectAllowsNestedClone(project) {
  if (!project || typeof project !== 'object') return true;
  const v = project.auto_clone_nested_repos;
  if (v === undefined || v === null) return true;
  if (v === false || v === 0 || v === '0') return false;
  if (typeof v === 'string' && v.trim().toLowerCase() === 'false') return false;
  return true;
}

function collectRepoUrls(taskDetail) {
  return collectRepoCloneJobs(taskDetail).map((j) => j.url);
}

/** @deprecated use collectRepoCloneJobs; kept for internal URL-only callers */
export { collectRepoUrls };

export function canonicalRepoUrlKey(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return v.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

function repoPathKey(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    return String(u.pathname || '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  } catch {
    const scp = v.match(/^[^@]+@[^:]+:(.+)$/);
    if (!scp || !scp[1]) return '';
    return String(scp[1])
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  }
}

export function resolveRepoCloneCredential(credRoot, repoUrl) {
  if (!credRoot || typeof credRoot !== 'object') return null;
  const direct = credRoot[String(repoUrl || '').trim()];
  if (direct && typeof direct === 'object') return direct;
  const target = canonicalRepoUrlKey(repoUrl);
  if (!target) return null;
  for (const [k, v] of Object.entries(credRoot)) {
    if (canonicalRepoUrlKey(k) !== target) continue;
    if (v && typeof v === 'object') return v;
  }
  // 兼容同一仓库因 allowedHost/隧道映射导致 host 不同（如 gitlab.aidevpm.com ↔ localhost:8012）。
  // 仅在“路径唯一”时回退，避免多仓同路径误配凭证。
  const targetPath = repoPathKey(repoUrl);
  if (!targetPath) return null;
  const byPath = [];
  for (const [k, v] of Object.entries(credRoot)) {
    if (!v || typeof v !== 'object') continue;
    if (repoPathKey(k) !== targetPath) continue;
    byPath.push(v);
    if (byPath.length > 1) return null;
  }
  if (byPath.length === 1) return byPath[0];
  return null;
}

function usernameFromRepoUrl(repoUrl) {
  const raw = String(repoUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const segs = String(u.pathname || '')
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean);
    if (!segs.length) return '';
    return segs[0] || '';
  } catch {
    return '';
  }
}

function defaultGitHttpUsernameForProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'gitlab') return 'oauth2';
  if (p === 'github') return 'x-access-token';
  return '';
}

export function buildHttpAuthFromRepoCredential(rawCredential, repoUrl = '') {
  if (!rawCredential || typeof rawCredential !== 'object') return null;
  const password = String(rawCredential.ephemeral_oauth_access_token || '').trim();
  if (!password) return null;
  let username = String(rawCredential.git_http_username || '').trim();
  if (!username) {
    username = defaultGitHttpUsernameForProvider(rawCredential.provider);
  }
  if (!username) {
    username = usernameFromRepoUrl(repoUrl);
  }
  if (!username) return null;
  return { username, password };
}

function createBootstrapGitAskPassScript(httpAuth) {
  if (!httpAuth) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-askpass-'));
  const shPath = path.join(dir, 'askpass.sh');
  fs.writeFileSync(
    shPath,
    [
      '#!/usr/bin/env sh',
      'prompt="$1"',
      'case "$prompt" in',
      '  *sername*) printf %s "$GIT_HTTP_USERNAME" ;;',
      '  *assword*) printf %s "$GIT_HTTP_PASSWORD" ;;',
      '  *) printf "" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 }
  );
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  return {
    envPatch: {
      GIT_ASKPASS: shPath,
      GIT_ASKPASS_ALWAYS: '1',
      GIT_HTTP_USERNAME: httpAuth.username,
      GIT_HTTP_PASSWORD: httpAuth.password,
    },
    cleanup,
  };
}

/**
 * 将仓库 URL（含 SSH）规范为 OAuth HTTPS 克隆地址，并生成 GIT_ASKPASS 环境补丁。
 * bootstrap 与 POST /repos/reclone 共用。
 *
 * @param {string} repoUrl
 * @param {Record<string, unknown> | null | undefined} credRoot
 * @returns {{
 *   cloneRemote: string,
 *   credential: object | null,
 *   httpAuth: { username: string, password: string } | null,
 *   envPatch: Record<string, string>,
 *   cleanup: () => void,
 *   normalizedFromSsh: boolean,
 * }}
 */
export function prepareOauthHttpsGitClone(repoUrl, credRoot) {
  const raw = String(repoUrl || '').trim();
  const credential = resolveRepoCloneCredential(credRoot, raw);
  const httpAuth = buildHttpAuthFromRepoCredential(credential, raw);
  let cloneRemote = raw;
  let normalizedFromSsh = false;
  if (httpAuth) {
    const httpsCloneUrl =
      credential && typeof credential === 'object'
        ? String(credential.https_clone_url || '').trim()
        : '';
    const normalized = normalizeRepoUrlForHttpsClone(raw, { httpsCloneUrl });
    if (normalized && normalized !== raw) {
      cloneRemote = normalized;
      normalizedFromSsh = true;
    }
  }
  if (httpAuth && /^git@/i.test(cloneRemote)) {
    throw new Error(
      `SSH URL 无法转为 HTTPS（缺少 https_clone_url / TRAE_GIT_HTTPS_CLONE_ORIGIN）: ${raw}`,
    );
  }
  const askpass = createBootstrapGitAskPassScript(httpAuth);
  return {
    cloneRemote,
    credential: credential && typeof credential === 'object' ? credential : null,
    httpAuth,
    envPatch: askpass?.envPatch || {},
    cleanup: () => askpass?.cleanup?.(),
    normalizedFromSsh,
  };
}

/**
 * 仅拉取 repo-clone-credentials（供 reclone 等单仓路径，避免重复拉 task-detail）。
 */
export async function fetchRepoCloneCredentialsOnly(prefix, accessToken, timeoutSec) {
  const credResp = await postJson(
    `${prefix}/server-container-token/repo-clone-credentials/`,
    { access_token: accessToken },
    timeoutSec
  );
  return credResp && typeof credResp.repo_clone_credentials === 'object'
    ? credResp.repo_clone_credentials
    : {};
}
