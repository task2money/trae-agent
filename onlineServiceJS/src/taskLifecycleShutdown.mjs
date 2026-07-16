/**
 * 任务终态优雅关停：中断 jobs → 上报 layer-graph → 请求 SaaS 释放机器 → 结束进程。
 */
import {
  listJobs as defaultListJobs,
  interruptJob as defaultInterruptJob,
  mirrorLayerGraphToTaskCloudSSE as defaultMirrorLayerGraph,
} from './jobsRuntime.mjs';
import { postRequestMachineRelease as defaultPostRelease } from './saasTaskCloud.mjs';

let shutdownInFlight = false;

/** @returns {boolean} */
export function isTerminalShutdownInFlight() {
  return shutdownInFlight;
}

/** 测试用重置 */
export function resetTerminalShutdownStateForTests() {
  shutdownInFlight = false;
}

/**
 * @param {{ terminal_kind?: string, reason?: string, task_id?: string }} body
 * @param {{
 *   exitProcess?: boolean,
 *   exitDelayMs?: number,
 *   exitFn?: (code: number) => void,
 *   listJobs?: () => Array<{id: string, status?: string}>,
 *   interruptJob?: (id: string) => void,
 *   mirrorLayerGraph?: () => Promise<unknown>,
 *   postRelease?: (opts: object) => Promise<boolean>,
 * }} [opts]
 */
export async function runTerminalShutdown(body = {}, opts = {}) {
  if (shutdownInFlight) {
    return { ok: true, skipped: true, reason: 'already_in_flight' };
  }
  shutdownInFlight = true;
  const listJobs = opts.listJobs || defaultListJobs;
  const interruptJob = opts.interruptJob || defaultInterruptJob;
  const mirrorLayerGraph = opts.mirrorLayerGraph || defaultMirrorLayerGraph;
  const postRelease = opts.postRelease || defaultPostRelease;

  const terminalKind = String(body?.terminal_kind || '').trim().toLowerCase() || 'cancelled';
  const reason = String(body?.reason || `task_status_${terminalKind}`).trim();
  const interrupted = [];
  for (const j of listJobs()) {
    const st = String(j?.status || '');
    if (st === 'running' || st === 'pending') {
      try {
        interruptJob(j.id);
        interrupted.push(String(j.id));
      } catch (e) {
        console.error(`[taskLifecycle] interruptJob failed id=${j?.id}: ${e?.message || e}`);
      }
    }
  }
  try {
    await mirrorLayerGraph();
  } catch (e) {
    console.error(`[taskLifecycle] layer-graph-push failed: ${e?.message || e}`);
  }
  let releaseOk = false;
  try {
    releaseOk = await postRelease({
      terminal_kind: terminalKind,
      reason,
    });
  } catch (e) {
    console.error(`[taskLifecycle] request-machine-release failed: ${e?.message || e}`);
  }
  const exitProcess = opts.exitProcess !== false;
  const exitDelayMs = Number.isFinite(opts.exitDelayMs) ? Math.max(0, opts.exitDelayMs) : 800;
  const exitFn = typeof opts.exitFn === 'function' ? opts.exitFn : (code) => process.exit(code);
  if (exitProcess) {
    setTimeout(() => {
      try {
        exitFn(0);
      } catch {
        /* ignore */
      }
    }, exitDelayMs);
  }
  console.log(
    `[taskLifecycle] shutdown done terminal_kind=${terminalKind} interrupted=${interrupted.length} release_ok=${releaseOk}`,
  );
  return {
    ok: true,
    terminal_kind: terminalKind,
    interrupted_job_ids: interrupted,
    release_ok: releaseOk,
  };
}
