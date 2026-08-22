/**
 * job 进程 close 后的副作用：挂载 Agent 评论收尾 + auto_run/edit_run 交付。
 * 交付不得依赖 mounted_agent_comment_id（普通 auto_run 常无挂载评论）。
 * 交付失败禁止进入指令闲置倒计时（idleEligible=false）。
 */

/**
 * @param {{
 *   wasInterrupted: boolean,
 *   mountedAgentId: string,
 *   rec: object,
 *   exitCode: number | null | undefined,
 *   completeMountedAgentComment?: (opts: { agentCommentId: string, assistantResponse: string }) => Promise<unknown>,
 *   failMountedAgentComment?: (opts: { agentCommentId: string, detail: string }) => Promise<unknown>,
 *   triggerAutoRunDeliveryForJobAndMirror?: (rec: object) => Promise<unknown>,
 * }} opts
 * @returns {Promise<{ deliveryTriggered: boolean, idleEligible: boolean, reason?: string }>}
 */
export async function finalizeJobCloseSideEffects(opts) {
  const wasInterrupted = Boolean(opts?.wasInterrupted);
  const mountedAgentId = String(opts?.mountedAgentId || '').trim();
  const rec = opts?.rec || {};
  const exitCode = opts?.exitCode;
  const completeFn = opts?.completeMountedAgentComment;
  const failFn = opts?.failMountedAgentComment;
  const deliveryFn = opts?.triggerAutoRunDeliveryForJobAndMirror;
  const hasDeliveryDuty = Boolean(mountedAgentId || rec.auto_run_first || rec.edit_run_delivery);

  if (wasInterrupted) {
    return { deliveryTriggered: false, idleEligible: false, reason: 'interrupted' };
  }

  if (mountedAgentId) {
    if (rec.status === 'completed') {
      const text = String(rec.output || '').trim();
      if (text && typeof completeFn === 'function') {
        try {
          await completeFn({
            agentCommentId: mountedAgentId,
            assistantResponse: text,
          });
        } catch (e) {
          console.error(
            `[jobsRuntime] mounted complete failed: ${String(e?.message || e).slice(0, 400)}`,
          );
          return { deliveryTriggered: false, idleEligible: false, reason: 'mounted_complete_failed' };
        }
      } else if (typeof completeFn === 'function' && !text) {
        return { deliveryTriggered: false, idleEligible: false, reason: 'mounted_complete_empty' };
      }
    } else if (rec.status === 'failed' && typeof failFn === 'function') {
      try {
        await failFn({
          agentCommentId: mountedAgentId,
          detail: `job exit_code=${exitCode}`,
        });
      } catch (e) {
        console.error(
          `[jobsRuntime] mounted fail failed: ${String(e?.message || e).slice(0, 400)}`,
        );
        return { deliveryTriggered: false, idleEligible: false, reason: 'mounted_fail_failed' };
      }
    }
  }

  const shouldDeliver =
    rec.status === 'completed' && Boolean(rec.auto_run_first || rec.edit_run_delivery);
  if (hasDeliveryDuty && rec.status !== 'completed') {
    return { deliveryTriggered: false, idleEligible: false, reason: 'delivery_not_completed' };
  }
  if (shouldDeliver) {
    if (typeof deliveryFn !== 'function') {
      return { deliveryTriggered: false, idleEligible: false, reason: 'no_delivery_fn' };
    }
    try {
      await deliveryFn(rec);
      return { deliveryTriggered: true, idleEligible: true };
    } catch (e) {
      console.error(
        `[jobsRuntime] AUTO_RUN_DELIVERY unexpected error: ${String(e?.message || e).slice(0, 400)}`,
      );
      return { deliveryTriggered: false, idleEligible: false, reason: 'delivery_threw' };
    }
  }
  if (hasDeliveryDuty && rec.status === 'completed') {
    return { deliveryTriggered: false, idleEligible: true, reason: 'mounted_only' };
  }
  return { deliveryTriggered: false, idleEligible: true, reason: 'no_delivery_duty' };
}
