/**
 * 将 HTTPS Git 远端转换为 SSH 形式（git@host:owner/repo.git）。
 * 解析失败时返回原始输入，避免误改。
 */
export function gitSshFromHttps(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host === 'www.github.com') host = 'github.com';
    let pth = u.pathname.replace(/^\//, '').replace(/\.git$/i, '');
    if (!host || !pth || pth.includes('..')) return url;
    return `git@${host}:${pth}.git`;
  } catch {
    return url;
  }
}

/**
 * 解析 SCP 风格 `git@host:path`（或 ssh://）得到 { host, path }；非 SSH 返回 null。
 * @param {string} repoUrl
 * @returns {{ host: string, path: string } | null}
 */
export function parseGitSshRepoUrl(repoUrl) {
  const raw = String(repoUrl || '').trim();
  if (!raw) return null;
  if (/^git@/i.test(raw)) {
    const m = raw.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/i);
    if (!m) return null;
    const host = String(m[1] || '')
      .trim()
      .toLowerCase();
    const path = String(m[2] || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
    if (!host || !path || path.includes('..')) return null;
    return { host, path };
  }
  if (/^ssh:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const host = String(u.hostname || '')
        .trim()
        .toLowerCase();
      const path = String(u.pathname || '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '');
      if (!host || !path || path.includes('..')) return null;
      return { host, path };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 将 SSH/SCP 仓库 URL 规范为 OAuth HTTPS（或 HTTP）克隆地址。
 * 对齐 Python `_normalize_repo_url_for_branch_lookup` 与 CRED `https_clone_url`。
 *
 * @param {string} repoUrl
 * @param {{ httpsCloneUrl?: string, httpsOrigin?: string } | null} [opts]
 * @returns {string} 已是 http(s) 时原样返回；无法转换时返回原 URL
 */
export function normalizeRepoUrlForHttpsClone(repoUrl, opts = null) {
  const raw = String(repoUrl || '').trim();
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');

  const fromCred = String(opts?.httpsCloneUrl || '').trim();
  if (fromCred && /^https?:\/\//i.test(fromCred)) {
    return fromCred.replace(/\/+$/, '');
  }

  const parsed = parseGitSshRepoUrl(raw);
  if (!parsed) return raw;

  const { host, path } = parsed;
  if (host === 'github.com') return `https://github.com/${path}`;
  if (host === 'gitlab.com') return `https://gitlab.com/${path}`;
  if (host === 'bitbucket.org') return `https://bitbucket.org/${path}`;

  const origin = String(opts?.httpsOrigin || process.env.TRAE_GIT_HTTPS_CLONE_ORIGIN || '')
    .trim()
    .replace(/\/+$/, '');
  if (origin && /^https?:\/\//i.test(origin)) {
    return `${origin}/${path}`;
  }

  // 无 provider website 时保留原 SSH URL，避免误用 https://host/path（缺端口）导致静默连错。
  return raw;
}

/**
 * 计算 push 的 remote 参数。
 * - 非 GitHub 远端返回 `origin`，保持现有行为。
 * - GitHub HTTPS 仅在明确要求时转为 SSH（例如已注入临时私钥），
 *   避免容器“仅有 HTTPS 凭据”时被强行切到 SSH 后失败。
 */
export function gitPushRemoteArgFromOrigin(originUrl, opts = {}) {
  const preferGithubSsh = opts && opts.preferGithubSsh === true;
  const raw = String(originUrl || '').trim();
  if (!raw) return 'origin';
  if (/^git@github\.com:/i.test(raw)) return raw;
  try {
    if (/^ssh:\/\//i.test(raw)) {
      const u = new URL(raw);
      const host = String(u.hostname || '').toLowerCase();
      let pth = String(u.pathname || '').replace(/^\/+/, '').replace(/\.git$/i, '');
      if ((host === 'github.com' || host === 'www.github.com') && pth && !pth.includes('..')) {
        return `git@github.com:${pth}.git`;
      }
      return 'origin';
    }
  } catch {
    return 'origin';
  }
  if (/^https?:\/\//i.test(raw)) {
    if (!preferGithubSsh) return 'origin';
    const ssh = gitSshFromHttps(raw);
    return /^git@github\.com:/i.test(ssh) ? ssh : 'origin';
  }
  return 'origin';
}
