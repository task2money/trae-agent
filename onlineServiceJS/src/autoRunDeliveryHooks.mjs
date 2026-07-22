/**
 * auto_run 交付与 jobsRuntime / server 启动补跑的衔接。
 */
import { lastBootstrapTaskDetail } from './bootstrapState.mjs';
import { collectRepoBranchPlans } from './bootstrapWorkBranch.mjs';
import { runAutoRunDelivery, shouldSkipAutoRunDelivery } from './autoRunOrchestration.mjs';
import { backfillAutoRunPrToAgentComment } from './autoRunPrBackfill.mjs';

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
 * }} [deps]
 */
export async function triggerAutoRunDeliveryForJob(rec, deps = {}) {
  const detail = deps.lastBootstrapTaskDetail !== undefined
    ? deps.lastBootstrapTaskDetail
    : lastBootstrapTaskDetail;
  const deliveryFn = deps.runAutoRunDelivery || runAutoRunDelivery;
  const mirrorFn = deps.mirrorLayerGraphToTaskCloudSSE;
  const commitMessage =
    String(rec?.auto_run_commit_message || '').trim() ||
    String(detail?.task?.title || '').trim() ||
    'auto_run';
  const identities = Array.isArray(detail?.repo_git_identities) ? detail.repo_git_identities : [];
  const targetBranch = resolveAutoRunDeliveryTargetBranch(detail);
  const result = await deliveryFn({
    layerId: rec?.layer_id,
    commitMessage,
    identities,
    targetBranch,
  });
  if (typeof mirrorFn === 'function') {
    try {
      await mirrorFn();
    } catch {
      /* 层图同步失败不阻断交付结果 */
    }
  }
  if (result?.ok) {
    const agentCommentId =
      String(rec?.mounted_agent_comment_id || '').trim() ||
      String(detail?.at_mention_run?.agent_comment_id || '').trim();
    const source = String(detail?.at_mention_run?.source || '').trim().toLowerCase();
    if (agentCommentId && (source === 'auto_run' || rec?.auto_run_first)) {
      const backfillFn = deps.backfillAutoRunPrToAgentComment || backfillAutoRunPrToAgentComment;
      try {
        result.pr_backfill = await backfillFn({
          agentCommentId,
          pushResult: result.pushResult,
          skippedClean: Boolean(result.skipped_clean),
        });
      } catch (e) {
        result.pr_backfill = { ok: false, detail: String(e?.message || e).slice(0, 400) };
      }
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
