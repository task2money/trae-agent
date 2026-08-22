/**
 * bootstrap 完成后的智能体首任务：at_mention（合法 ContextPack）优先，否则 auto_run。
 * 供 listen 后主路径与 repo-clone-credentials 恢复成功路径共用，避免只克隆不跑 Agent。
 */
import {
  composeAtMentionCommand,
  detailHasAtMentionRun,
  maybeStartAtMentionJob,
  maybeStartCommentIdFallbackJob,
} from './atMentionOrchestration.mjs';
import { normalizeAtMentionContextPack } from './atMentionContext.mjs';
import { maybeStartAutoRunFirstInstruction } from './autoRunOrchestration.mjs';
import { postJson, taskApiPrefix } from './saasTaskCloud.mjs';

/**
 * 默认兜底取指令（OPT-20260822-021）：重拉 task-detail，优先
 * context_pack.comment_thread 最后一条人类，再按 COMMENT_ID 命中 comments 数组。
 * 失败返回空（调用方回退 auto_run，不阻塞）。
 */
export async function defaultFetchCommentContent(commentId, deps = {}) {
  const prefixFn = deps.prefixFn || taskApiPrefix;
  const postFn = deps.postFn || postJson;
  let prefix;
  try {
    prefix = prefixFn();
  } catch {
    return { content: '' };
  }
  const accessToken = String(deps.accessToken || process.env.ACCESS_TOKEN || '').trim();
  if (!prefix || !accessToken) return { content: '' };
  let data;
  try {
    data = await postFn(
      `${prefix.replace(/\/$/, '')}/server-container-token/task-detail/`,
      { access_token: accessToken },
      15,
    );
  } catch {
    return { content: '' };
  }
  const thread = Array.isArray(data?.context_pack?.comment_thread)
    ? data.context_pack.comment_thread
    : [];
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const item = thread[i];
    if (!item || typeof item !== 'object') continue;
    if (String(item.kind || 'human').toLowerCase() !== 'human') continue;
    const content = String(item.content || '').trim();
    if (content) return { content };
  }
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  const cid = String(commentId || '').trim();
  if (cid) {
    const hit = comments.find(
      (c) => String(c?.id || '') === cid || String(c?.comment_id || '') === cid,
    );
    const content = String(hit?.content || hit?.body || '').trim();
    if (content) return { content };
  }
  return { content: '' };
}

/**
 * @param {{
 *   detail: object|null|undefined,
 *   layerId: string,
 *   createJobFn: Function,
 *   fsApi?: object,
 *   log?: Console,
 * }} opts
 * @returns {Promise<{ kind: 'at_mention'|'auto_run'|null, rec: object|null }>}
 */
export async function runPostBootstrapAgentKickoff(opts) {
  const detail = opts?.detail;
  const layerId = String(opts?.layerId || '').trim();
  const createJobFn = opts?.createJobFn;
  const fsApi = opts?.fsApi;
  const log = opts?.log || console;

  if (typeof createJobFn !== 'function') {
    throw new Error('createJobFn required');
  }

  const atSource = String(detail?.at_mention_run?.source || '').trim().toLowerCase();
  // auto_run 合成的 @ 评论：走首指令 + 挂载 agent，不走用户 at_mention job。
  if (detailHasAtMentionRun(detail) && atSource !== 'auto_run') {
    const normalized = normalizeAtMentionContextPack(detail);
    const command = normalized.ok ? composeAtMentionCommand(normalized.pack) : '';
    if (normalized.ok && command) {
      const rec = await maybeStartAtMentionJob({
        detail,
        layerId,
        createJobFn,
        ...(fsApi ? { fsApi } : {}),
      });
      return { kind: 'at_mention', rec: rec || null };
    }
    log.warn?.(
      `[onlineServiceJS] AT_MENTION_JOB_SKIP falling_back_to_auto_run detail=${String(normalized.error || 'empty_command').slice(0, 200)}`,
    );
    console.warn(
      `[onlineServiceJS] AT_MENTION_JOB_SKIP falling_back_to_auto_run detail=${String(normalized.error || 'empty_command').slice(0, 200)}`,
    );
  }

  // at_mention_run 缺失但 COMMENT_ID 非空：评论内容兜底补跑首指令（OPT-20260822-021）。
  if (!detailHasAtMentionRun(detail)) {
    const fallbackRec = await maybeStartCommentIdFallbackJob({
      detail,
      layerId,
      createJobFn,
      ...(fsApi ? { fsApi } : {}),
      commentId: opts?.commentId,
      fetchCommentContent: opts?.fetchCommentContent || defaultFetchCommentContent,
      log,
    });
    if (fallbackRec) {
      return { kind: 'at_mention', rec: fallbackRec };
    }
  }

  const rec = await maybeStartAutoRunFirstInstruction({
    detail,
    layerId,
    createJobFn,
    ...(fsApi ? { fsApi } : {}),
    log,
  });
  return { kind: rec ? 'auto_run' : null, rec: rec || null };
}

/**
 * 凭证恢复 bootstrap 成功后补跑 Agent kickoff（与 listen 后主路径同逻辑）。
 * @param {{ detail: object|null|undefined, layerId: string }} opts
 */
export async function kickoffAfterCredentialsRecovery(opts) {
  const { createJob } = await import('./jobsRuntime.mjs');
  return runPostBootstrapAgentKickoff({
    detail: opts?.detail,
    layerId: opts?.layerId,
    createJobFn: createJob,
  });
}
