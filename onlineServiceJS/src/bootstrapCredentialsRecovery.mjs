import { appendOutboundReqLog } from './outboundReqLog.mjs';
import {
  bootstrapCloneLayerId,
  bootstrapCredentialsRecoveryRounds,
  bootstrapCredentialsRecoveryRunning,
  bootstrapCredentialsRecoveryTimer,
  bootstrapRegisterCloneJob,
  lastBootstrapFailure,
  lastBootstrapTaskDetail,
  setBootstrapCredentialsRecoveryRounds,
  setBootstrapCredentialsRecoveryRunning,
  setBootstrapCredentialsRecoveryTimer,
} from './bootstrapState.mjs';
import { isRepoCloneCredentialsIncompleteError } from './bootstrapFailure.mjs';

function stopBootstrapCredentialsRecovery() {
  if (bootstrapCredentialsRecoveryTimer) {
    clearTimeout(bootstrapCredentialsRecoveryTimer);
  }
  setBootstrapCredentialsRecoveryTimer(null);
  setBootstrapCredentialsRecoveryRunning(false);
  setBootstrapCredentialsRecoveryRounds(0);
}

function bootstrapCredentialsRecoveryConfigFromEnv() {
  const intervalRaw = parseInt(
    String(process.env.TASK_API_REPO_CLONE_CREDENTIALS_RECOVERY_INTERVAL_MS || '60000'),
    10,
  );
  const roundsRaw = parseInt(
    String(process.env.TASK_API_REPO_CLONE_CREDENTIALS_RECOVERY_ROUNDS || '20'),
    10,
  );
  const intervalMs = Number.isFinite(intervalRaw)
    ? Math.max(1000, Math.min(600000, intervalRaw))
    : 60000;
  const maxRounds = Number.isFinite(roundsRaw) ? Math.max(0, Math.min(120, roundsRaw)) : 20;
  return { intervalMs, maxRounds };
}

/**
 * 启动后凭证仍未齐时，周期性再试「详情→凭证→克隆→feature-params」，避免永久空 /app。
 * @param {{ prefix: string, newAccess: string, timeout?: number }} ctx
 */
export function scheduleBootstrapCredentialsRecovery(ctx) {
  stopBootstrapCredentialsRecovery();
  if (!ctx || ctx.skipped || !ctx.prefix || !ctx.newAccess) return;
  const { intervalMs, maxRounds } = bootstrapCredentialsRecoveryConfigFromEnv();
  if (maxRounds <= 0) return;
  console.log(
    `[onlineServiceJS] 已调度 repo-clone-credentials 恢复轮询（间隔 ${intervalMs}ms，最多 ${maxRounds} 轮）`,
  );
  appendOutboundReqLog(
    `bootstrap: schedule credentials recovery interval_ms=${intervalMs} max_rounds=${maxRounds}`,
  );

  const tick = async () => {
    setBootstrapCredentialsRecoveryTimer(null);
    if (bootstrapCredentialsRecoveryRunning) {
      setBootstrapCredentialsRecoveryTimer(setTimeout(tick, intervalMs));
      return;
    }
    if (bootstrapCloneLayerId && !lastBootstrapFailure) {
      stopBootstrapCredentialsRecovery();
      return;
    }
    if (bootstrapCredentialsRecoveryRounds >= maxRounds) {
      console.warn(
        `[onlineServiceJS] repo-clone-credentials 恢复轮询已达上限 ${maxRounds}，停止自动重试`,
      );
      appendOutboundReqLog(`bootstrap: credentials recovery exhausted rounds=${maxRounds}`);
      stopBootstrapCredentialsRecovery();
      return;
    }
    setBootstrapCredentialsRecoveryRounds(bootstrapCredentialsRecoveryRounds + 1);
    setBootstrapCredentialsRecoveryRunning(true);
    const round = bootstrapCredentialsRecoveryRounds;
    try {
      const { emitRuntimeEvent } = await import('./runtimeEventLog.mjs');
      emitRuntimeEvent('BOOTSTRAP_PHASE', {
        phase: 'credentials_recovery_begin',
        message: `round=${round}/${maxRounds}`,
        fields: { round, max_rounds: maxRounds },
        consoleLine: `[onlineServiceJS] BOOTSTRAP_PHASE=credentials_recovery_begin round=${round}/${maxRounds}`,
      });
      appendOutboundReqLog(`bootstrap: credentials recovery round=${round}/${maxRounds}`);
      const { runBootstrapAfterListen } = await import('./bootstrap.mjs');
      await runBootstrapAfterListen({
        prefix: ctx.prefix,
        newAccess: ctx.newAccess,
        timeout: ctx.timeout,
        skipped: false,
        _fromCredentialsRecovery: true,
      });
      emitRuntimeEvent('BOOTSTRAP_PHASE', {
        phase: 'credentials_recovery_ok',
        message: `round=${round} layer=${bootstrapCloneLayerId || ''}`,
        fields: { round, layer_id: bootstrapCloneLayerId || '' },
        consoleLine: `[onlineServiceJS] BOOTSTRAP_PHASE=credentials_recovery_ok round=${round} layer=${bootstrapCloneLayerId || ''}`,
      });
      if (bootstrapCloneLayerId && bootstrapRegisterCloneJob) {
        try {
          const { registerBootstrapCloneJob } = await import('./jobsRuntime.mjs');
          registerBootstrapCloneJob(bootstrapCloneLayerId);
        } catch (regErr) {
          console.error(
            `[onlineServiceJS] credentials recovery: registerBootstrapCloneJob failed: ${String(regErr?.message || regErr).slice(0, 300)}`,
          );
        }
      }
      // 首听 bootstrap 因凭证 409 失败时跳过了 Agent kickoff；恢复成功后必须补跑
      try {
        const { kickoffAfterCredentialsRecovery } = await import('./postBootstrapAgentKickoff.mjs');
        await kickoffAfterCredentialsRecovery({
          detail: lastBootstrapTaskDetail,
          layerId: bootstrapCloneLayerId,
        });
        console.log(
          `[onlineServiceJS] credentials recovery: post-bootstrap agent kickoff done layer=${bootstrapCloneLayerId || ''}`,
        );
      } catch (kickErr) {
        console.error(
          `[onlineServiceJS] credentials recovery: post-bootstrap agent kickoff failed: ${String(kickErr?.message || kickErr).slice(0, 500)}`,
        );
      }
      stopBootstrapCredentialsRecovery();
    } catch (e) {
      const msg = String(e?.message || e || '').slice(0, 400);
      console.warn(
        `[onlineServiceJS] credentials recovery round=${round} still failing: ${msg}`,
      );
      appendOutboundReqLog(`bootstrap: credentials recovery round=${round} fail ${msg}`);
      if (!isRepoCloneCredentialsIncompleteError(e)) {
        // 非凭证类错误：保留失败摘要，但继续有限次重试（网络抖动等）
      }
      setBootstrapCredentialsRecoveryTimer(setTimeout(tick, intervalMs));
    } finally {
      setBootstrapCredentialsRecoveryRunning(false);
    }
  };

  setBootstrapCredentialsRecoveryTimer(setTimeout(tick, intervalMs));
}

export { stopBootstrapCredentialsRecovery };
