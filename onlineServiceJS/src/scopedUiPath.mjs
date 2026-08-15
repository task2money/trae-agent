/**
 * 容器控制台 UI path：与任务云 API scoped 前缀对齐。
 *
 * 规范：
 *   /ui/tenant/{tenantId}/workspace/{workspaceId}/task/{taskId}/{access_token}
 *
 * 无 tenant/workspace/task 时回退：
 *   /ui/{access_token}
 * （本地 dev 未注入 scope 时仍可用）
 */

/**
 * @param {string} pathname
 * @returns {{ tenant: string, workspace: string, task: string, comment?: string } | null}
 */
export function parseTenantWorkspaceTaskFromPath(pathname) {
  const p = String(pathname || '');
  const withComment = p.match(
    /\/api\/tenant\/([^/]+)\/workspace\/([^/]+)\/task\/([^/]+)\/comment\/([^/]+)/,
  );
  if (withComment) {
    return {
      tenant: withComment[1],
      workspace: withComment[2],
      task: withComment[3],
      comment: withComment[4],
    };
  }
  const patterns = [
    /\/api\/tenant\/([^/]+)\/workspace\/([^/]+)\/task\/([^/]+)/,
    /\/api\/tenant\/([^/]+)\/workspace\/([^/]+)\/task-detail\/([^/]+)/,
    /\/tenant\/([^/]+)\/workspace\/([^/]+)\/task-detail\/([^/]+)/,
    /\/ui\/tenant\/([^/]+)\/workspace\/([^/]+)\/task\/([^/]+)/,
  ];
  for (const re of patterns) {
    const m = p.match(re);
    if (m) return { tenant: m[1], workspace: m[2], task: m[3] };
  }
  return null;
}

/**
 * 任务云 inbound 前缀。有 commentId 时带位置段 `/comment/{cid}/`（skill 推荐值）。
 * @param {string} origin
 * @param {string} tenant
 * @param {string} workspace
 * @param {string} task
 * @param {string} [comment]
 * @returns {string}
 */
export function buildTaskCloudPrefix(origin, tenant, workspace, task, comment) {
  const base = `${String(origin || '').replace(/\/$/, '')}/api/tenant/${tenant}/workspace/${workspace}/task/${task}`;
  const cid = String(comment || '').trim();
  if (cid && cid !== '-') {
    return `${base}/comment/${cid}/cloud`;
  }
  return `${base}/cloud`;
}

/**
 * @returns {{ tenantId: string, workspaceId: string, taskId: string } | null}
 */
export function resolveUiScopeFromEnv() {
  let tenant = String(process.env.tenantId || '').trim();
  let workspace = String(process.env.workspaceId || '').trim();
  let task = String(process.env.taskId || '').trim();

  const raw = String(process.env.TaskApiEndPoint || process.env.TASK_API_ENDPOINT || '').trim();
  if (raw && (!tenant || !workspace || !task)) {
    try {
      const base = raw.includes('://') ? raw : `http://${raw}`;
      const u = new URL(base);
      const parsed = parseTenantWorkspaceTaskFromPath(u.pathname);
      if (parsed) {
        if (!tenant) tenant = parsed.tenant;
        if (!workspace) workspace = parsed.workspace;
        if (!task) task = parsed.task;
      }
    } catch {
      /* ignore */
    }
  }

  if (!tenant || !workspace || !task) return null;
  return { tenantId: tenant, workspaceId: workspace, taskId: task };
}

/**
 * @param {string} accessToken
 * @param {{ tenantId: string, workspaceId: string, taskId: string } | null} [scope]
 * @returns {string}
 */
export function buildScopedUiPath(accessToken, scope) {
  const tok = String(accessToken || '').trim();
  if (!tok) return '/ui/';
  const encoded = encodeURIComponent(tok);
  const s = scope === undefined ? resolveUiScopeFromEnv() : scope;
  if (s?.tenantId && s?.workspaceId && s?.taskId) {
    return (
      `/ui/tenant/${encodeURIComponent(s.tenantId)}` +
      `/workspace/${encodeURIComponent(s.workspaceId)}` +
      `/task/${encodeURIComponent(s.taskId)}` +
      `/${encoded}`
    );
  }
  return `/ui/${encoded}`;
}

/**
 * 从 UI pathname 提取 access_token（兼容旧 /ui/{token} 与 scoped path）。
 * @param {string} pathname
 * @returns {string}
 */
export function extractAccessTokenFromUiPathname(pathname) {
  const bits = String(pathname || '')
    .split('/')
    .filter(Boolean);
  if (bits.length < 2 || bits[0] !== 'ui') return '';
  // /ui/tenant/{t}/workspace/{w}/task/{task}/{token}[ /render-hints ]
  if (
    bits.length >= 8 &&
    bits[1] === 'tenant' &&
    bits[3] === 'workspace' &&
    bits[5] === 'task'
  ) {
    try {
      return decodeURIComponent(String(bits[7] || '').trim());
    } catch {
      return String(bits[7] || '').trim();
    }
  }
  // /ui/{token}[ /render-hints ]
  if (bits[1] === 'tenant') return '';
  const tok = bits[1];
  try {
    return decodeURIComponent(String(tok || '').trim());
  } catch {
    return String(tok || '').trim();
  }
}
