/**
 * auto_run 交付完成后，将 PR 链接回填到挂载的 container_agent 评论回复。
 */
import { readPersistedTokenStore } from './bootstrapTokenStore.mjs';
import { taskApiPrefix } from './saasTaskCloud.mjs';
import { emitRuntimeEvent } from './runtimeEventLog.mjs';
import { withSaasInboundScope } from './saasInboundScope.mjs';
import { traceHeadersForOutbound } from './traceId.mjs';
import { recordAutoRunGitPrReplyComments } from './autoRunGitPrReplyComment.mjs';

function collectRepoPrUrls(repos, push) {
  const list = Array.isArray(repos) ? repos : [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    push(row?.pr?.html_url);
    push(row?.pr?.web_url);
    push(row?.github_pull_request?.html_url);
  }
}

/**
 * @param {object|null|undefined} pushResult runLayerOauthRefreshPush 返回值
 * @param {{ rememberedPrUrl?: string }} [extra] 层目录 git_pr_html_url 兜底（payload 不含 repos[] 时）
 * @returns {string[]}
 */
export function extractPrUrlsFromPushResult(pushResult, extra = {}) {
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
  push(payload?.git_remote?.pr_html_url);
  collectRepoPrUrls(payload?.repos, push);
  const multi = payload?.github_oauth_multirepo;
  if (multi && typeof multi === 'object') {
    collectRepoPrUrls(multi.repos, push);
  }
  push(extra?.rememberedPrUrl);
  return urls;
}

/**
 * @param {{ urls?: string[], skippedClean?: boolean, detail?: string, kind?: 'auto_run'|'edit_run' }} opts
 */
export function composeAutoRunPrBackfillReply(opts = {}) {
  const kind = String(opts.kind || 'auto_run').trim() === 'edit_run' ? 'edit_run' : 'auto_run';
  const head = kind === 'edit_run' ? '修改指令后执行已完成' : '自动运行已完成';
  const headDelivery = kind === 'edit_run' ? '修改指令后执行交付已完成' : '自动运行交付已完成';
  const urls = Array.isArray(opts.urls) ? opts.urls.filter(Boolean) : [];
  if (urls.length === 1) {
    return `${head}，Pull Request：\n${urls[0]}`;
  }
  if (urls.length > 1) {
    return `${head}，Pull Requests：\n${urls.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;
  }
  if (opts.failed) {
    const failDetail = String(opts.detail || '').trim();
    return failDetail
      ? `${headDelivery}失败：${failDetail.slice(0, 400)}`
      : `${headDelivery}失败。`;
  }
  if (opts.skippedClean) {
    return `${head}：工作区干净，无需推送或创建 PR。`;
  }
  const detail = String(opts.detail || '').trim();
  if (detail) {
    return `${headDelivery}（未获取到 PR 链接）：${detail.slice(0, 400)}`;
  }
  return `${headDelivery}（未获取到 PR 链接）。`;
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
      body: JSON.stringify(withSaasInboundScope({ assistant_response: text })),
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
 *   rememberedPrUrl?: string,
 *   skippedClean?: boolean,
 *   kind?: 'auto_run'|'edit_run',
 *   completeFn?: typeof completeMountedAgentComment,
 *   recordGitPrReplyFn?: typeof recordAutoRunGitPrReplyComments,
 *   parentCommentId?: string,
 * }} opts
 */
export async function backfillAutoRunPrToAgentComment(opts = {}) {
  const agentCommentId = String(opts?.agentCommentId || '').trim();
  if (!agentCommentId) {
    return { ok: false, skipped: true, reason: 'no_agent_comment_id' };
  }
  const urls = extractPrUrlsFromPushResult(opts?.pushResult, {
    rememberedPrUrl: opts?.rememberedPrUrl,
  });
  const prText = composeAutoRunPrBackfillReply({
    urls,
    skippedClean: Boolean(opts?.skippedClean),
    kind: opts?.kind,
    failed: Boolean(opts?.failed),
    detail: opts?.detail,
  });
  const prior = String(opts?.priorAssistantResponse || '').trim();
  const text = prior ? `${prior}\n\n${prText}` : prText;
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
  let gitPrReplies = null;
  if (result.ok && urls.length) {
    const recordFn = opts?.recordGitPrReplyFn || recordAutoRunGitPrReplyComments;
    try {
      gitPrReplies = await recordFn({
        urls,
        parentCommentId: opts?.parentCommentId,
        accessToken: opts?.accessToken,
        prefixFn: opts?.prefixFn,
        readTokenFn: opts?.readTokenFn,
      });
    } catch (e) {
      gitPrReplies = { ok: false, detail: String(e?.message || e).slice(0, 400) };
    }
  }
  return { ...result, urls, text, git_pr_replies: gitPrReplies };
}
