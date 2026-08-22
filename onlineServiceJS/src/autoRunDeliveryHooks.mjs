/**
 * auto_run 交付与 jobsRuntime / server 启动补跑的衔接。
 */
import { lastBootstrapTaskDetail } from './bootstrapState.mjs';
import { collectRepoBranchPlans } from './bootstrapWorkBranch.mjs';
import { runAutoRunDelivery, shouldSkipAutoRunDelivery } from './autoRunOrchestration.mjs';
import { backfillAutoRunPrToAgentComment } from './autoRunPrBackfill.mjs';
import { ensureEditRunMountedAgentComment } from './editRunAgentComment.mjs';
import {
  rememberLayerLastPushError,
  clearLayerLastPushError,
} from './layerFsGitLastPushError.mjs';
import { readLayerPrHtmlUrl } from './layerFsGitRemote.mjs';

/**
 * credential task-detail 可能把 at_mention_run 放在顶层，也可能只在 context_pack。
 * @param {object|null|undefined} detail
 * @returns {object|null}
 */
export function resolveAtMentionRun(detail) {
  if (detail?.at_mention_run && typeof detail.at_mention_run === 'object') {
    return detail.at_mention_run;
  }
  const pack = detail?.context_pack;
  if (pack?.at_mention_run && typeof pack.at_mention_run === 'object') {
    return pack.at_mention_run;
  }
  return null;
}

/**
 * 与 bootstrap 工作分支解析一致：task.target_branch → branch_strategy.work_branch_name → target_branch_name。
 * @param {object|null|undefined} detail
 * @returns {string}
 */
export function resolveAutoRunDeliveryTargetBranch(detail) {
  const shared = collectRepoBranchPlans(detail).sharedWorkBranch;
  return String(shared || '').trim();
}

/**
 * @param {object} rec job record
 * @param {{
 *   runAutoRunDelivery?: typeof runAutoRunDelivery,
 *   mirrorLayerGraphToTaskCloudSSE?: () => Promise<unknown>,
 *   lastBootstrapTaskDetail?: object|null,
 *   ensureEditRunMountedAgentComment?: typeof ensureEditRunMountedAgentComment,
 *   backfillAutoRunPrToAgentComment?: typeof backfillAutoRunPrToAgentComment,
 *   persistJobMount?: (rec: object, agentId: string) => void,
 * }} [deps]
 */
export async function triggerAutoRunDeliveryForJob(rec, deps = {}) {
  const detail = deps.lastBootstrapTaskDetail !== undefined
    ? deps.lastBootstrapTaskDetail
    : lastBootstrapTaskDetail;
  const deliveryFn = deps.runAutoRunDelivery || runAutoRunDelivery;
  const mirrorFn = deps.mirrorLayerGraphToTaskCloudSSE;
  const isEditRun = Boolean(rec?.edit_run_delivery);
  const commitMessage =
    String(rec?.auto_run_commit_message || '').trim() ||
    String(detail?.task?.title || '').trim() ||
    (isEditRun ? 'edit_run' : 'auto_run');
  const identities = Array.isArray(detail?.repo_git_identities) ? detail.repo_git_identities : [];
  const targetBranch = resolveAutoRunDeliveryTargetBranch(detail);
  const result = await deliveryFn({
    layerId: rec?.layer_id,
    commitMessage,
    identities,
    targetBranch,
    ...(isEditRun
      ? { force: true, editRunJobId: String(rec?.id || '').trim() }
      : {}),
  });
  const rememberErr = deps.rememberLayerLastPushError || rememberLayerLastPushError;
  const clearErr = deps.clearLayerLastPushError || clearLayerLastPushError;
  const layerId = String(rec?.layer_id || '').trim();
  if (layerId) {
    if (result?.ok) {
      clearErr(layerId);
    } else {
      const detail = String(result?.pushResult?.payload?.detail || result?.detail || '').trim();
      rememberErr(layerId, detail || 'push 失败', {
        traceId: result?.traceId || result?.pushResult?.traceId,
      });
    }
  }
  if (typeof mirrorFn === 'function') {
    try {
      await mirrorFn();
    } catch {
      /* 层图同步失败不阻断交付结果 */
    }
  }
  if (result?.ok && isEditRun) {
    const ensureFn = deps.ensureEditRunMountedAgentComment || ensureEditRunMountedAgentComment;
    try {
      await ensureFn(rec, {
        persistMount: (agentId) => {
          if (typeof deps.persistJobMount === 'function') {
            deps.persistJobMount(rec, agentId);
          }
        },
      });
    } catch (e) {
      result.agent_ensure = { ok: false, detail: String(e?.message || e).slice(0, 400) };
    }
  }
  const mention = resolveAtMentionRun(detail);
  const agentCommentId =
    String(rec?.mounted_agent_comment_id || '').trim() ||
    String(mention?.agent_comment_id || '').trim();
  const source = String(mention?.source || '').trim().toLowerCase();
  const shouldBackfill =
    Boolean(agentCommentId) &&
    (source === 'auto_run' || source === 'edit_run' || Boolean(rec?.auto_run_first) || isEditRun);
  if (shouldBackfill) {
    const readPr = deps.readLayerPrHtmlUrl || readLayerPrHtmlUrl;
    const rememberedPrUrl =
      layerId && typeof readPr === 'function' ? String(readPr(layerId) || '').trim() : '';
    const backfillFn = deps.backfillAutoRunPrToAgentComment || backfillAutoRunPrToAgentComment;
    try {
      result.pr_backfill = await backfillFn({
        agentCommentId,
        pushResult: result.pushResult,
        rememberedPrUrl,
        skippedClean: Boolean(result.skipped_clean),
        priorAssistantResponse: String(rec?.output || '').trim(),
        kind: isEditRun ? 'edit_run' : 'auto_run',
        failed: !result?.ok,
        detail: String(result?.pushResult?.payload?.detail || result?.detail || '').trim(),
      });
    } catch (e) {
      result.pr_backfill = { ok: false, detail: String(e?.message || e).slice(0, 400) };
    }
  }
  return result;
}

/**
 * @param {{
 *   listJobs?: () => object[],
 *   shouldSkipAutoRunDelivery?: typeof shouldSkipAutoRunDelivery,
 *   triggerAutoRunDeliveryForJob?: typeof triggerAutoRunDeliveryForJob,
 *   mirrorLayerGraphToTaskCloudSSE?: () => Promise<unknown>,
 * }} [deps]
 */
export async function retryPendingAutoRunDeliveries(deps = {}) {
  const listJobsFn = deps.listJobs;
  const skipFn = deps.shouldSkipAutoRunDelivery || shouldSkipAutoRunDelivery;
  const triggerFn = deps.triggerAutoRunDeliveryForJob || triggerAutoRunDeliveryForJob;
  if (typeof listJobsFn !== 'function') {
    throw new Error('listJobs required');
  }
  const pending = listJobsFn().filter(
    (j) => j && j.auto_run_first && j.status === 'completed' && !skipFn(),
  );
  if (!pending.length) return { attempted: 0, results: [] };
  const results = [];
  for (const rec of pending) {
    try {
      results.push({
        job_id: rec.id,
        ...(await triggerFn(rec, {
          mirrorLayerGraphToTaskCloudSSE: deps.mirrorLayerGraphToTaskCloudSSE,
        })),
      });
    } catch (e) {
      results.push({ job_id: rec.id, ok: false, detail: String(e?.message || e).slice(0, 400) });
    }
  }
  return { attempted: pending.length, results };
}
