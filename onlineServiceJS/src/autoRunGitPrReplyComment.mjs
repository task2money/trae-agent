/**
 * auto_run 交付成功后，经容器 inbound 调 task 评论 API 落一条人类 git_pr 子评论
 * （与 FE recordGitPrReplyComment 同契约：parent path + git_pr.html_url）。
 */
import { readPersistedTokenStore } from './bootstrapTokenStore.mjs';
import { taskApiPrefix } from './saasTaskCloud.mjs';
import { postJson } from './saasPostJson.mjs';
import { emitRuntimeEvent } from './runtimeEventLog.mjs';

export function gitPrProviderOf(htmlUrl, fallback = '') {
  const hinted = String(fallback || '').trim().toLowerCase();
  if (hinted === 'gitlab' || hinted === 'github') return hinted;
  const u = String(htmlUrl || '');
  if (/\/-\/merge_requests\//i.test(u) || /gitlab/i.test(u)) return 'gitlab';
  return 'github';
}

export function uniquePrHtmlUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(urls) ? urls : []) {
    const s = String(raw || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * @param {() => string|null} [prefixFn]
 * @returns {string|null}
 */
export function buildGitPrReplyInboundUrl(prefixFn = taskApiPrefix) {
  let prefix;
  try {
    prefix = prefixFn();
  } catch {
    return null;
  }
  if (!prefix) return null;
  return `${String(prefix).replace(/\/$/, '')}/server-container-token/git-pr-reply/`;
}

/**
 * @param {{
 *   urls?: string[],
 *   parentCommentId?: string,
 *   accessToken?: string,
 *   prefixFn?: () => string|null,
 *   readTokenFn?: () => { accessToken?: string },
 *   postJsonFn?: typeof postJson,
 * }} opts
 */
export async function recordAutoRunGitPrReplyComments(opts = {}) {
  const urls = uniquePrHtmlUrls(opts?.urls);
  const parentCommentId =
    opts?.parentCommentId !== undefined
      ? String(opts.parentCommentId || '').trim()
      : String(process.env.COMMENT_ID || '').trim();
  if (!urls.length) {
    return { ok: true, skipped: true, reason: 'no_pr_urls', replies: [] };
  }
  if (!parentCommentId || parentCommentId === '-') {
    return { ok: false, skipped: true, reason: 'no_parent_comment_id', replies: [] };
  }
  const inboundUrl = buildGitPrReplyInboundUrl(opts?.prefixFn || taskApiPrefix);
  if (!inboundUrl) {
    return { ok: false, skipped: true, reason: 'inbound_url_unavailable', replies: [] };
  }
  const readToken = opts?.readTokenFn || readPersistedTokenStore;
  const accessToken =
    String(opts?.accessToken || '').trim() ||
    String(readToken()?.accessToken || '').trim() ||
    String(process.env.ACCESS_TOKEN || '').trim();
  if (!accessToken) {
    return { ok: false, skipped: true, reason: 'access_token_missing', replies: [] };
  }
  const postFn = opts?.postJsonFn || postJson;
  const replies = [];
  for (const htmlUrl of urls) {
    try {
      const data = await postFn(
        inboundUrl,
        {
          access_token: accessToken,
          html_url: htmlUrl,
          parent_comment_id: parentCommentId,
          git_pr: { html_url: htmlUrl, provider: gitPrProviderOf(htmlUrl) },
        },
        20,
      );
      const skipped = Boolean(data?.skipped);
      replies.push({
        ok: true,
        html_url: htmlUrl,
        id: String(data?.id || '').trim(),
        skipped,
      });
      emitRuntimeEvent('AUTO_RUN_GIT_PR_REPLY_OK', {
        fields: {
          parent_comment_id: parentCommentId,
          skipped,
        },
        consoleLine: `[onlineServiceJS] AUTO_RUN_GIT_PR_REPLY_OK parent_comment_id=${parentCommentId} skipped=${skipped}`,
      });
    } catch (e) {
      const detail = String(e?.message || e).slice(0, 400);
      replies.push({ ok: false, html_url: htmlUrl, detail });
      emitRuntimeEvent('AUTO_RUN_GIT_PR_REPLY_FAILED', {
        level: 'warn',
        message: detail.slice(0, 240),
        fields: { parent_comment_id: parentCommentId },
        consoleLine: `[onlineServiceJS] AUTO_RUN_GIT_PR_REPLY_FAILED parent_comment_id=${parentCommentId} detail=${detail.slice(0, 240)}`,
      });
    }
  }
  const ok = replies.every((row) => row.ok);
  return { ok, replies, parentCommentId };
}
