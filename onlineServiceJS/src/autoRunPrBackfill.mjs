/**
 * auto_run 交付完成后，将 PR 链接回填到挂载的 container_agent 评论回复。
 */
import { readPersistedTokenStore } from './bootstrapTokenStore.mjs';
import { taskApiPrefix } from './saasTaskCloud.mjs';
import { emitRuntimeEvent } from './runtimeEventLog.mjs';
import { traceHeadersForOutbound } from './traceId.mjs';

/**
 * @param {object|null|undefined} pushResult runLayerOauthRefreshPush 返回值
 * @returns {string[]}
 */
export function extractPrUrlsFromPushResult(pushResult) {
  const urls = [];
  const seen = new Set();
  const push = (u) => {
    const s = String(u || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    urls.push(s);
  };
  const payload = pushResult?.payload && typeof pushResult.payload === 'object' ? pushResult.payload : {};
  push(payload?.github_pull_request?.html_url);
  push(payload?.pull_request?.html_url);
  const repos = Array.isArray(payload?.repos) ? payload.repos : [];
  for (const row of repos) {
    if (!row || typeof row !== 'object') continue;
    push(row?.pr?.html_url);
    push(row?.github_pull_request?.html_url);
  }
  return urls;
}

/**
 * @param {{ urls?: string[], skippedClean?: boolean, detail?: string }} opts
 */
export function composeAutoRunPrBackfillReply(opts = {}) {
  const urls = Array.isArray(opts.urls) ? opts.urls.filter(Boolean) : [];
  if (urls.length === 1) {
    return `自动运行已完成，Pull Request：\n${urls[0]}`;
  }
  if (urls.length > 1) {
    return `自动运行已完成，Pull Requests：\n${urls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;
  }
  if (opts.skippedClean) {
    return '自动运行已完成：工作区干净，无需推送或创建 PR。';
  }
  const detail = String(opts.detail || '').trim();
  if (detail) {
    return `自动运行交付已完成（未获取到 PR 链接）：${detail.slice(0, 400)}`;
  }
  return '自动运行交付已完成（未获取到 PR 链接）。';
}

/**
 * 从 taskApiPrefix（…/cloud）推导 container-agent complete URL。
 * @param {string} agentCommentId
 * @param {() => string|null} [prefixFn]
 */
export function buildContainerAgentCompleteUrl(agentCommentId, prefixFn = taskApiPrefix) {
  const id = String(agentCommentId || '').trim();
  if (!id) return null;
  let prefix;
  try {
    prefix = prefixFn();
  } catch {
    return null;
  }
  if (!prefix) return null;
  const base = String(prefix).replace(/\/cloud\/?$/, '');
  return `${base}/container-agent-comments/${encodeURIComponent(id)}/complete`;
}

/**
 * @param {{
 *   agentCommentId: string,
 *   assistantResponse: string,
 *   accessToken?: string,
 *   fetchFn?: typeof fetch,
 *   prefixFn?: () => string|null,
 *   readTokenFn?: () => { accessToken?: string },
 * }} opts
 */
export async function completeMountedAgentComment(opts) {
  const agentCommentId = String(opts?.agentCommentId || '').trim();
  const text = String(opts?.assistantResponse || '').trim();
  if (!agentCommentId || !text) {
    return { ok: false, detail: 'agent_comment_id and assistant_response required' };
  }
  const url = buildContainerAgentCompleteUrl(agentCommentId, opts?.prefixFn || taskApiPrefix);
  if (!url) {
    return { ok: false, detail: 'complete_url_unavailable' };
  }
  const readToken = opts?.readTokenFn || readPersistedTokenStore;
  const accessToken =
    String(opts?.accessToken || '').trim() ||
    String(readToken()?.accessToken || '').trim() ||
    String(process.env.ACCESS_TOKEN || '').trim();
  if (!accessToken) {
    return { ok: false, detail: 'access_token_missing' };
  }
  const fetchFn = opts?.fetchFn || fetch;
  try {
    const headers = {
      ...traceHeadersForOutbound(),
      'Content-Type': 'application/json',
      'X-Access-Token': accessToken,
    };
    const r = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ assistant_response: text }),
    });
    const bodyText = await r.text();
    if (!r.ok) {
      return {
        ok: false,
        detail: `http_${r.status}:${bodyText.slice(0, 300)}`,
        url,
      };
    }
    return { ok: true, url };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 500), url };
  }
}

/**
 * @param {{
 *   agentCommentId?: string,
 *   pushResult?: object,
 *   skippedClean?: boolean,
 *   completeFn?: typeof completeMountedAgentComment,
 * }} opts
 */
export async function backfillAutoRunPrToAgentComment(opts = {}) {
  const agentCommentId = String(opts?.agentCommentId || '').trim();
  if (!agentCommentId) {
    return { ok: false, skipped: true, reason: 'no_agent_comment_id' };
  }
  const urls = extractPrUrlsFromPushResult(opts?.pushResult);
  const text = composeAutoRunPrBackfillReply({
    urls,
    skippedClean: Boolean(opts?.skippedClean),
  });
  const completeFn = opts?.completeFn || completeMountedAgentComment;
  const result = await completeFn({
    agentCommentId,
    assistantResponse: text,
    accessToken: opts?.accessToken,
    fetchFn: opts?.fetchFn,
    prefixFn: opts?.prefixFn,
    readTokenFn: opts?.readTokenFn,
  });
  if (result.ok) {
    emitRuntimeEvent('AUTO_RUN_PR_BACKFILL_OK', {
      fields: {
        agent_comment_id: agentCommentId,
        pr_count: urls.length,
      },
      consoleLine: `[onlineServiceJS] AUTO_RUN_PR_BACKFILL_OK agent_comment_id=${agentCommentId} pr_count=${urls.length}`,
    });
  } else {
    emitRuntimeEvent('AUTO_RUN_PR_BACKFILL_FAILED', {
      level: 'warn',
      message: String(result.detail || 'failed').slice(0, 240),
      fields: { agent_comment_id: agentCommentId },
      consoleLine: `[onlineServiceJS] AUTO_RUN_PR_BACKFILL_FAILED agent_comment_id=${agentCommentId} detail=${String(result.detail || '').slice(0, 240)}`,
    });
  }
  return { ...result, urls, text };
}
