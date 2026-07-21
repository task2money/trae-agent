/**
 * OAuth 推送后创建 GitHub PR / GitLab MR。
 */
import {
  appendOutboundReqLog,
  sanitizeUrlForOutboundLog,
  isDebugAgentEnabled,
  debugAgentStringify,
} from './outboundReqLog.mjs';

export async function createGithubPullRequest({ owner, repo, head, base, accessToken, title, bodyText }) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;
  const safeUrl = sanitizeUrlForOutboundLog(apiUrl);
  const t0 = Date.now();
  let r;
  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
    const requestBody = {
      title: title || 'Pull request',
      head,
      base,
      body: bodyText || '',
    };
    if (isDebugAgentEnabled()) {
      appendOutboundReqLog(
        `DEBUG_AGENT outbound request method=POST url=${apiUrl} headers=${debugAgentStringify(headers)} body=${debugAgentStringify(requestBody)}`,
      );
    }
    r = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    appendOutboundReqLog(
      `github-api POST ${safeUrl} -> error ${String(e?.message || e).slice(0, 400)} ${Date.now() - t0}ms`,
    );
    throw e;
  }
  const text = await r.text();
  if (isDebugAgentEnabled()) {
    appendOutboundReqLog(
      `DEBUG_AGENT outbound response method=POST url=${apiUrl} status=${r.status} headers=${debugAgentStringify(Object.fromEntries(r.headers.entries()))} body=${text}`,
    );
  }
  appendOutboundReqLog(`github-api POST ${safeUrl} -> HTTP ${r.status} ${Date.now() - t0}ms`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return {
    ok: r.status === 201,
    status: r.status,
    json,
    text: text.slice(0, 2000),
  };
}

/**
 * GitLab Merge Request（审查页 URL 字段为 web_url，映射为前端统一的 html_url）。
 * @param {{ originUrl: string, owner: string, repo: string, head: string, base: string, accessToken: string, title?: string, bodyText?: string }} opts
 */
export async function createGitlabMergeRequest(opts) {
  const originUrl = String(opts?.originUrl || '').trim();
  const owner = String(opts?.owner || '').trim();
  const repo = String(opts?.repo || '').trim();
  const head = String(opts?.head || '').trim();
  const base = String(opts?.base || '').trim();
  const accessToken = String(opts?.accessToken || '').trim();
  const title = String(opts?.title || '').trim() || 'Merge request';
  const bodyText = String(opts?.bodyText || '').trim();
  if (!originUrl || !owner || !repo || !head || !base || !accessToken) {
    return { ok: false, status: 0, json: null, text: 'missing_gitlab_mr_params' };
  }
  let apiOrigin = '';
  try {
    const u = new URL(originUrl.includes('://') ? originUrl : `https://${originUrl}`);
    apiOrigin = `${u.protocol}//${u.host}`;
  } catch {
    return { ok: false, status: 0, json: null, text: 'invalid_origin_url' };
  }
  const projectPath = encodeURIComponent(`${owner}/${repo}`);
  const apiUrl = `${apiOrigin}/api/v4/projects/${projectPath}/merge_requests`;
  const safeUrl = sanitizeUrlForOutboundLog(apiUrl);
  const t0 = Date.now();
  const requestBody = {
    source_branch: head,
    target_branch: base,
    title,
    description: bodyText || '',
  };
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  let r;
  try {
    if (isDebugAgentEnabled()) {
      appendOutboundReqLog(
        `DEBUG_AGENT outbound request method=POST url=${apiUrl} headers=${debugAgentStringify(headers)} body=${debugAgentStringify(requestBody)}`,
      );
    }
    r = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    appendOutboundReqLog(
      `gitlab-api POST ${safeUrl} -> error ${String(e?.message || e).slice(0, 400)} ${Date.now() - t0}ms`,
    );
    throw e;
  }
  let text = await r.text();
  // 已存在同名 MR 时尝试查找已有记录
  if (r.status === 409 || r.status === 400) {
    const listUrl = `${apiOrigin}/api/v4/projects/${projectPath}/merge_requests?state=opened&source_branch=${encodeURIComponent(head)}&target_branch=${encodeURIComponent(base)}`;
    try {
      const lr = await fetch(listUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      });
      const lt = await lr.text();
      let lj = null;
      try {
        lj = JSON.parse(lt);
      } catch {
        /* ignore */
      }
      if (lr.ok && Array.isArray(lj) && lj.length > 0 && lj[0]?.web_url) {
        appendOutboundReqLog(
          `gitlab-api POST ${safeUrl} -> HTTP ${r.status} (reuse existing MR) ${Date.now() - t0}ms`,
        );
        return { ok: true, status: 200, json: lj[0], text: lt.slice(0, 2000), reused: true };
      }
    } catch {
      /* fall through */
    }
  }
  if (isDebugAgentEnabled()) {
    appendOutboundReqLog(
      `DEBUG_AGENT outbound response method=POST url=${apiUrl} status=${r.status} body=${text}`,
    );
  }
  appendOutboundReqLog(`gitlab-api POST ${safeUrl} -> HTTP ${r.status} ${Date.now() - t0}ms`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return {
    ok: r.status === 201,
    status: r.status,
    json,
    text: text.slice(0, 2000),
  };
}
