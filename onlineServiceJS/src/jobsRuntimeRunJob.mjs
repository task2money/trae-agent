import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';

import { normalizeJobCommandEnv } from './normalizeJobCommandEnv.mjs';
import { completeMountedAgentComment } from './autoRunPrBackfill.mjs';
import {
  createMountedAgentChunkBuffer,
  failMountedAgentComment,
} from './mountedAgentCommentStream.mjs';
import { jobLogsTaeJsonDir, jobLogsTaeJsonPath, layerArtifactsDir } from './paths.mjs';
import { broadcast } from './sseHub.mjs';
import { resetExecStream, appendExecStream, completeExecStream } from './execStream.mjs';
import { startAgentStepPoller } from './jobStepEvents.mjs';
import { getRunningMap, saveState } from './jobsRuntimeState.mjs';
import { recordJobEvent } from './saasJobStreamPush.mjs';
import { buildTraeCmd, loadPriorTrajectoryContextPrefix } from './jobsRuntimeTrae.mjs';
import { mirrorLayerGraphToTaskCloudSSE } from './jobsRuntimeSnapshot.mjs';

/**
 * @param {object} rec
 * @param {string} workDir
 * @param {{
 *   drainQueuedJobsForLayer: (layerId: string, jobId: string) => void | Promise<void>,
 *   triggerAutoRunDeliveryForJobAndMirror: (rec: object) => Promise<unknown>,
 * }} deps
 */
export function runJobAsync(rec, workDir, deps) {
  const drainQueuedJobsForLayer = deps.drainQueuedJobsForLayer;
  const triggerAutoRunDeliveryForJobAndMirror = deps.triggerAutoRunDeliveryForJobAndMirror;
  const running = getRunningMap();
  resetExecStream('job', rec.id);
  const env = { ...process.env, PYTHONUNBUFFERED: '1' };
  let trajectoryFile;
  if (rec.command_kind === 'trae') {
    const trajDir = path.join(layerArtifactsDir(rec.layer_id), '.trajectories');
    fs.mkdirSync(trajDir, { recursive: true });
    trajectoryFile = path.join(trajDir, `trajectory_${rec.id}.json`);
    env.TRAE_AGENT_JSON_OUTPUT_DIR = jobLogsTaeJsonDir(rec.id);
  }
  let normalizedCommandEnv = null;
  if (rec.command_env && typeof rec.command_env === 'object') {
    normalizedCommandEnv = normalizeJobCommandEnv(rec.command_env);
    for (const [k, v] of Object.entries(normalizedCommandEnv)) {
      if (v != null) env[String(k)] = String(v);
    }
  }
  let commandForTrae = rec.command;
  if (rec.command_kind === 'trae') {
    const prefix = loadPriorTrajectoryContextPrefix(rec.prior_context_job_id || rec.parent_job_id);
    if (prefix) commandForTrae = prefix + rec.command;
  }

  let proc;
  if (rec.command_kind === 'shell') {
    proc = spawn('bash', ['-lc', rec.command], { cwd: workDir, env });
  } else {
    const trae = buildTraeCmd(workDir, commandForTrae, {
      trajectoryFile,
      model: normalizedCommandEnv?.TRAE_MODEL,
      provider: normalizedCommandEnv?.TRAE_MODEL_PROVIDER,
    });
    if (trae) {
      proc = spawn(trae.cmd, trae.args, { cwd: workDir, env, shell: trae.shell || false });
    } else {
      proc = spawn(
        'bash',
        [
          '-lc',
          `echo "[onlineServiceJS] 未找到 trae-cli（请确认镜像已安装 /app/.venv，或设置 TRAE_CLI / TRAE_VENV）。占位未执行指令: ${commandForTrae.replace(/'/g, "'\\''")}" >&2; exit 1`,
        ],
        { cwd: workDir, env },
      );
    }
  }
  const mountedAgentId = String(rec.mounted_agent_comment_id || '').trim();
  const agentChunkBuf = mountedAgentId
    ? createMountedAgentChunkBuffer({ flushMs: 250, maxChars: 2048 })
    : null;
  try {
    proc.stdout?.on('data', (c) => {
      const t = c.toString();
      rec.output = (rec.output || '') + t;
      appendExecStream('job', rec.id, t);
      recordJobEvent(rec.id, 'chunk', t);
      if (agentChunkBuf && mountedAgentId) {
        void agentChunkBuf.push(mountedAgentId, t);
      }
    });
    proc.stderr?.on('data', (c) => {
      const t = c.toString();
      rec.output = (rec.output || '') + t;
      appendExecStream('job', rec.id, t);
      recordJobEvent(rec.id, 'chunk', t);
      if (agentChunkBuf && mountedAgentId) {
        void agentChunkBuf.push(mountedAgentId, t);
      }
    });
  } catch {
    /* ignore */
  }
  let stopStepPoller = () => {};
  if (rec.command_kind === 'trae') {
    stopStepPoller = startAgentStepPoller({
      trajPath: trajectoryFile || '',
      taeRoot: jobLogsTaeJsonPath(rec.id),
      intervalMs: 750,
      onNewStep: (step, message) => {
        recordJobEvent(rec.id, 'step', message, {
          step_number: step?.step_number,
          delivery_summary: step?.delivery_summary,
          state: step?.state,
        });
      },
    });
  }
  rec.status = 'running';
  running.set(rec.id, proc);
  saveState();
  broadcast({ type: 'job_started', job_id: rec.id });
  recordJobEvent(rec.id, 'running');
  void mirrorLayerGraphToTaskCloudSSE().catch(() => {});
  proc.on('close', (code) => {
    try {
      stopStepPoller();
    } catch {
      /* ignore */
    }
    running.delete(rec.id);
    rec.exit_code = code;
    const wasInterrupted = rec.status === 'interrupted';
    if (!wasInterrupted) {
      rec.status = code === 0 ? 'completed' : 'failed';
    }
    completeExecStream('job', rec.id);
    saveState();
    broadcast({ type: 'job_finished', job_id: rec.id, status: rec.status, exit_code: code });
    const finalPhase = wasInterrupted ? 'interrupted' : (code === 0 ? 'completed' : 'failed');
    recordJobEvent(rec.id, finalPhase);
    void mirrorLayerGraphToTaskCloudSSE().catch(() => {});
    if (!wasInterrupted) {
      void drainQueuedJobsForLayer(rec.layer_id, rec.id);
    }
    void (async () => {
      if (agentChunkBuf) {
        try {
          await agentChunkBuf.flush();
        } catch {
          /* ignore */
        }
      }
      if (!mountedAgentId || wasInterrupted) return;
      if (rec.status === 'completed') {
        const text = String(rec.output || '').trim();
        if (text) {
          try {
            await completeMountedAgentComment({
              agentCommentId: mountedAgentId,
              assistantResponse: text,
            });
          } catch {
            /* soft-fail */
          }
        }
      } else if (rec.status === 'failed') {
        try {
          await failMountedAgentComment({
            agentCommentId: mountedAgentId,
            detail: `job exit_code=${code}`,
          });
        } catch {
          /* soft-fail */
        }
      }
      if (rec.status === 'completed' && (rec.auto_run_first || rec.edit_run_delivery)) {
        try {
          await triggerAutoRunDeliveryForJobAndMirror(rec);
        } catch (e) {
          console.error(
            `[jobsRuntime] AUTO_RUN_DELIVERY unexpected error: ${String(e?.message || e).slice(0, 400)}`,
          );
        }
      }
    })();
  });
  proc.on('error', (e) => {
    try {
      stopStepPoller();
    } catch {
      /* ignore */
    }
    running.delete(rec.id);
    rec.status = 'failed';
    rec.exit_code = -1;
    rec.output = (rec.output || '') + `\n[error] ${e.message}\n`;
    appendExecStream('job', rec.id, `\n[error] ${e.message}\n`);
    completeExecStream('job', rec.id);
    saveState();
    broadcast({ type: 'job_finished', job_id: rec.id, status: 'failed' });
    void mirrorLayerGraphToTaskCloudSSE().catch(() => {});
    void drainQueuedJobsForLayer(rec.layer_id, rec.id);
    void (async () => {
      if (agentChunkBuf) {
        try {
          await agentChunkBuf.flush();
        } catch {
          /* ignore */
        }
      }
      if (!mountedAgentId) return;
      try {
        await failMountedAgentComment({
          agentCommentId: mountedAgentId,
          detail: String(e?.message || e).slice(0, 500),
        });
      } catch {
        /* soft-fail */
      }
    })();
  });
}
