/**
 * bootstrap 完成后的智能体首任务：at_mention（合法 ContextPack）优先，否则 auto_run。
 * 供 listen 后主路径与 repo-clone-credentials 恢复成功路径共用，避免只克隆不跑 Agent。
 */
import {
  composeAtMentionCommand,
  detailHasAtMentionRun,
  maybeStartAtMentionJob,
} from './atMentionOrchestration.mjs';
import { normalizeAtMentionContextPack } from './atMentionContext.mjs';
import { maybeStartAutoRunFirstInstruction } from './autoRunOrchestration.mjs';

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

  if (detailHasAtMentionRun(detail)) {
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
