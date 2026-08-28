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
import { emitRuntimeEvent } from './runtimeEventLog.mjs';

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
  const layerId = String(opts?.layerId || '').trim();
  const createJobFn = opts?.createJobFn;
  const fsApi = opts?.fsApi;
  const log = opts?.log || console;

  if (typeof createJobFn !== 'function') {
    throw new Error('createJobFn required');
  }

  let detail = opts?.detail;
  if (!detailHasAtMentionRun(detail)) {
    const commentId = String(opts?.commentId || process.env.COMMENT_ID || '').trim();
    const imageId = String(detail?.task?.installed_image_id || '').trim();
    if (commentId && commentId !== '-' && imageId) {
      const autoRun = Boolean(detail?.task?.auto_run);
      let command = '';
      if (autoRun) {
        const title = String(detail?.task?.title || '').trim();
        const description = String(detail?.task?.description || '').trim();
        command = [title, description].filter(Boolean).join('\n\n');
      } else {
        try {
          const fetched = await (opts?.fetchCommentContent || defaultFetchCommentContent)(commentId);
          command = String(fetched?.content || '').trim();
        } catch {
          command = '';
        }
      }
      if (command || autoRun) {
        detail = {
          ...detail,
          at_mention_run: {
            parent_comment_id: commentId,
            installed_image: { id: imageId },
            source: autoRun ? 'auto_run' : 'at_mention',
            ...(command ? { trigger_comment: { id: commentId, content: command } } : {}),
          },
        };
      }
    }
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
        ...(opts?.createAgentCommentFn ? { createAgentCommentFn: opts.createAgentCommentFn } : {}),
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
      ...(opts?.createAgentCommentFn ? { createAgentCommentFn: opts.createAgentCommentFn } : {}),
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
    ...(opts?.createAgentCommentFn ? { createAgentCommentFn: opts.createAgentCommentFn } : {}),
    log,
  });
  return { kind: rec ? 'auto_run' : null, rec: rec || null };
}

/**
 * 引导已尝试克隆但层内尚无 git 时，推迟 Agent 首指令，等手动 reclone / 凭证恢复。
 * @param {{ cloneAttempted?: boolean, hasGit?: boolean }} opts
 */
export function shouldDeferAgentKickoff(opts = {}) {
  return Boolean(opts.cloneAttempted) && !opts.hasGit;
}

/**
 * listen 后主路径：克隆全失败时推迟 kickoff，否则与现网一致立即建任务。
 * @returns {Promise<{ kind: 'at_mention'|'auto_run'|null, rec: object|null, deferred: boolean }>}
 */
export async function maybeRunPostBootstrapAgentKickoff(opts) {
  const layerId = String(opts?.layerId || '').trim();
  if (shouldDeferAgentKickoff({ cloneAttempted: opts?.cloneAttempted, hasGit: opts?.hasGit })) {
    emitRuntimeEvent('AGENT_KICKOFF_DEFERRED', {
      level: 'warn',
      message: 'clone_failed',
      fields: { reason: 'clone_failed', layer_id: layerId },
      consoleLine:
        '[onlineServiceJS] AGENT_KICKOFF_DEFERRED reason=clone_failed waiting_for_reclone',
    });
    return { kind: null, rec: null, deferred: true };
  }
  const out = await runPostBootstrapAgentKickoff(opts);
  return { ...out, deferred: false };
}

async function resolveCreateJobFn(opts) {
  if (typeof opts?.createJobFn === 'function') return opts.createJobFn;
  const { createJob } = await import('./jobsRuntime.mjs');
  return createJob;
}

/**
 * 克隆能力恢复后补跑 Agent kickoff（凭证恢复与手动 reclone 成功共用）。
 * @param {{ detail: object|null|undefined, layerId: string, reason?: string, repoUrl?: string, createJobFn?: Function }} opts
 */
export async function resumeAgentKickoffAfterCloneReady(opts) {
  const reason = String(opts?.reason || 'clone_ready').trim() || 'clone_ready';
  const layerId = String(opts?.layerId || '').trim();
  const repoUrl = String(opts?.repoUrl || '').trim();
  emitRuntimeEvent('AGENT_KICKOFF_RESUME', {
    message: reason,
    fields: {
      reason,
      layer_id: layerId,
      ...(repoUrl ? { repo_url: repoUrl.slice(0, 200) } : {}),
    },
    consoleLine: `[onlineServiceJS] AGENT_KICKOFF_RESUME reason=${reason} layer=${layerId}`,
  });
  const createJobFn = await resolveCreateJobFn(opts);
  return runPostBootstrapAgentKickoff({
    detail: opts?.detail,
    layerId,
    createJobFn,
    ...(opts?.fsApi ? { fsApi: opts.fsApi } : {}),
    ...(opts?.log ? { log: opts.log } : {}),
  });
}

/**
 * reclone 成功后的副作用：Git 身份同步（best-effort）+ 恢复被中断的自动任务。
 */
export async function runRecloneSuccessSideEffects(opts) {
  const applyIdentities = opts?.applyIdentities;
  const kickoff = opts?.kickoff || resumeAgentKickoffAfterCloneReady;
  const log = opts?.log || console;
  if (typeof applyIdentities === 'function') {
    try {
      await applyIdentities();
    } catch {
      /* identity sync is best-effort */
    }
  }
  try {
    await kickoff({
      detail: opts?.detail,
      layerId: opts?.layerId,
      reason: 'reclone',
      repoUrl: opts?.repoUrl,
      createJobFn: opts?.createJobFn,
    });
  } catch (kickErr) {
    const msg = String(kickErr?.message || kickErr).slice(0, 500);
    if (typeof log.error === 'function') {
      log.error(`[onlineServiceJS] reclone: agent kickoff failed: ${msg}`);
    } else {
      console.error(`[onlineServiceJS] reclone: agent kickoff failed: ${msg}`);
    }
  }
}

/**
 * 凭证恢复 bootstrap 成功后补跑 Agent kickoff（与 listen 后主路径同逻辑）。
 * @param {{ detail: object|null|undefined, layerId: string }} opts
 */
export async function kickoffAfterCredentialsRecovery(opts) {
  return resumeAgentKickoffAfterCloneReady({
    ...opts,
    reason: 'credentials_recovery',
  });
}
