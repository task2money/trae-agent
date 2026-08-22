import fs from 'fs';

import { bootstrapCloneLayerId } from './bootstrapState.mjs';
import { assertReposLayoutReadyForJobs } from './bootstrapCloneLayoutSeal.mjs';
import { triggerAutoRunDeliveryForJob } from './autoRunDeliveryHooks.mjs';
import { configFilePath, jobLogsTaeJsonPath } from './paths.mjs';
import {
  createStackedLayer,
  directChildLayerIds,
  deleteLayerTree,
  layerPath,
  layerPrimaryGitWorkdir,
  anyLayerHasGitRepo,
  newLayerId,
} from './layerFs.mjs';
import { broadcast } from './sseHub.mjs';
import {
  getJobsMap,
  getRunningMap,
  getLayerQueues,
  saveState,
  newJobId,
  removeLayerQueue,
} from './jobsRuntimeState.mjs';
import { recordJobEvent } from './saasJobStreamPush.mjs';
import { runJobAsync as runJobAsyncImpl } from './jobsRuntimeRunJob.mjs';
import { preemptForNewInstruction } from './instructionIdle.mjs';
import { postContainerHeartbeatToSaas } from './saasTaskCloud.mjs';
import {
  buildLayersSnapshot,
  mirrorLayerGraphToTaskCloudSSE,
  sortLayersSerialChronological,
} from './jobsRuntimeSnapshot.mjs';

export {
  getJobEvents,
  jobToApiDict,
  listJobs,
  getJob,
  removeLayerQueue,
} from './jobsRuntimeState.mjs';

export {
  layerIdQualifiesForSnapshot,
  sweepDanglingLayerDirs,
  buildLayersSnapshot,
  mirrorLayerGraphToTaskCloudSSE,
} from './jobsRuntimeSnapshot.mjs';

function removeJobsForLayer(layerId) {
  const jobs = getJobsMap();
  for (const [jid, j] of jobs) {
    if (j.layer_id === layerId) jobs.delete(jid);
  }
}

function purgeChildLayers(baseLayerId) {
  for (const lid of directChildLayerIds(baseLayerId)) {
    try {
      removeJobsForLayer(lid);
      deleteLayerTree(lid);
    } catch {
      /* ignore */
    }
  }
}

function obliterateLayer(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid) return;
  const jobs = getJobsMap();
  const layerQueues = getLayerQueues();
  const ids = [...jobs.entries()].filter(([, j]) => j.layer_id === lid).map(([id]) => id);
  for (const jid of ids) {
    try {
      deleteJob(jid);
    } catch {
      /* job 可能已删 */
    }
  }
  delete layerQueues[lid];
  if (fs.existsSync(layerPath(lid))) {
    try {
      deleteLayerTree(lid);
    } catch {
      /* ignore */
    }
  }
  saveState();
}

/**
 * 串行列表中锚点层之后的所有可写层（更新者）删除，与页面点选某层再「创建并执行」一致。
 */
function purgeSerialTailAfterLayer(anchorLayerId) {
  const anchor = String(anchorLayerId || '').trim();
  if (!anchor) return;
  const snap = buildLayersSnapshot(bootstrapCloneLayerId);
  const sorted = sortLayersSerialChronological(snap.layers, snap.bootstrap_layer_id);
  const idx = sorted.findIndex((x) => x.layer_id === anchor);
  if (idx < 0) return;
  const tail = sorted.slice(idx + 1);
  for (let i = tail.length - 1; i >= 0; i--) {
    obliterateLayer(tail[i].layer_id);
  }
}

export async function createJob(body) {
  const jobs = getJobsMap();
  const command = String(body.command || '').trim();
  if (!command) throw new Error('command 不能为空');
  const command_kind = (body.command_kind || 'trae').toLowerCase();
  if (!['trae', 'shell'].includes(command_kind)) throw new Error('invalid command_kind');
  const parent_job_id = body.parent_job_id ? String(body.parent_job_id).trim() : '';
  const repo_layer_id = body.repo_layer_id ? String(body.repo_layer_id).trim() : '';
  if (Boolean(parent_job_id) === Boolean(repo_layer_id)) {
    throw new Error('须且仅能设置 parent_job_id 或 repo_layer_id 之一');
  }
  assertReposLayoutReadyForJobs(anyLayerHasGitRepo(), {
    enforceSeal: Boolean(bootstrapCloneLayerId),
  });

  if (command_kind === 'trae' && !fs.existsSync(configFilePath())) {
    throw new Error(`Config missing: ${configFilePath()}`);
  }

  preemptForNewInstruction({
    jobs,
    interruptFn: interruptJob,
    heartbeatFn: (idle) => postContainerHeartbeatToSaas('', { instruction_idle: idle }),
  });

  let stackParent;
  let prior_context_job_id = '';
  if (parent_job_id) {
    const p = jobs.get(parent_job_id);
    if (!p) throw new Error(`parent_job_id not found: ${parent_job_id}`);
    stackParent = p.layer_id;
    prior_context_job_id = parent_job_id;
  } else {
    if (!fs.existsSync(layerPath(repo_layer_id))) throw new Error(`repo_layer_id not found: ${repo_layer_id}`);
    stackParent = repo_layer_id;
    const pc = body.prior_context_job_id ? String(body.prior_context_job_id).trim() : '';
    prior_context_job_id = pc;
  }

  purgeSerialTailAfterLayer(stackParent);
  purgeChildLayers(stackParent);

  const lid = newLayerId();
  createStackedLayer(lid, stackParent);
  const lp = layerPath(lid);
  const work = layerPrimaryGitWorkdir(lid) || lp;

  const id = newJobId();
  const rec = {
    id,
    layer_id: lid,
    layer_path: lp,
    command,
    parent_job_id: parent_job_id || null,
    repo_layer_id: repo_layer_id || null,
    status: 'pending',
    created_at: new Date().toISOString(),
    exit_code: null,
    output: '',
    git_branch: body.git_branch || null,
    git_head_at_run_start: null,
    command_kind,
    command_env: body.env && typeof body.env === 'object' ? body.env : null,
    prior_context_job_id: prior_context_job_id || null,
    auto_run_first: Boolean(body.auto_run_first),
    edit_run_delivery: Boolean(body.edit_run_delivery),
    edit_run_installed_image_id: body.edit_run_installed_image_id
      ? String(body.edit_run_installed_image_id).trim()
      : null,
    auto_run_commit_message: body.auto_run_commit_message
      ? String(body.auto_run_commit_message).trim()
      : null,
    mounted_agent_comment_id: body.mounted_agent_comment_id
      ? String(body.mounted_agent_comment_id).trim()
      : body.at_mention_agent_comment_id
        ? String(body.at_mention_agent_comment_id).trim()
        : null,
    mounted_parent_comment_id: body.mounted_parent_comment_id
      ? String(body.mounted_parent_comment_id).trim()
      : null,
    at_mention_run: Boolean(body.at_mention_run),
  };
  jobs.set(id, rec);
  saveState();
  broadcast({ type: 'job_created', job_id: id, layer_id: lid });
  await mirrorLayerGraphToTaskCloudSSE();
  recordJobEvent(id, 'start');
  runJobAsync(rec, work);
  return rec;
}

/** 终止并移除绑定到该层的任务记录（删层前调用，避免快照仍含已删层任务）。 */
function stripJobsForLayer(layerId) {
  const jobs = getJobsMap();
  const lid = String(layerId || '').trim();
  if (!lid) return;
  for (const [jid, j] of [...jobs]) {
    if (String(j.layer_id || '').trim() !== lid) continue;
    try {
      if (j.status === 'running' || j.status === 'pending') interruptJob(jid);
    } catch {
      /* 已结束或不存在 */
    }
    jobs.delete(jid);
  }
}

/**
 * 删除可写层（含直接子层）并将层级快照上报至任务云 SSE（``container_layer_graph``）。
 * 供 ``DELETE /api/layers/:layer_id`` 与容器内 Web UI 删除按钮使用。
 */
export async function deleteLayerAndMirrorToSaas(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid) throw new Error('layer_id required');
  for (const cid of directChildLayerIds(lid)) {
    stripJobsForLayer(cid);
    removeLayerQueue(cid);
    deleteLayerTree(cid);
  }
  stripJobsForLayer(lid);
  removeLayerQueue(lid);
  deleteLayerTree(lid);
  saveState();
  await mirrorLayerGraphToTaskCloudSSE();
}

export function enqueueLayerQueueItem(layerId, body) {
  const layerQueues = getLayerQueues();
  const lid = String(layerId || '').trim();
  if (!lid) throw new Error('layer_id 无效');
  if (!fs.existsSync(layerPath(lid))) throw new Error(`layer not found: ${lid}`);
  const command = String(body?.command || '').trim();
  if (!command) throw new Error('command 不能为空');
  const command_kind = String(body?.command_kind || 'trae').toLowerCase();
  if (!['trae', 'shell'].includes(command_kind)) throw new Error('invalid command_kind');
  assertReposLayoutReadyForJobs(anyLayerHasGitRepo(), {
    enforceSeal: Boolean(bootstrapCloneLayerId),
  });
  if (command_kind === 'trae' && !fs.existsSync(configFilePath())) {
    throw new Error(`Config missing: ${configFilePath()}`);
  }
  const env = body?.env && typeof body.env === 'object' ? body.env : null;
  if (!layerQueues[lid]) layerQueues[lid] = [];
  layerQueues[lid].push({ command, command_kind, env });
  const depth = layerQueues[lid].length;
  saveState();
  broadcast({ type: 'layer_queue_enqueued', layer_id: lid, queue_depth: depth });
  void mirrorLayerGraphToTaskCloudSSE().catch(() => {});
  return { ok: true, layer_id: lid, queue_position: depth - 1, queue_depth: depth };
}

async function drainQueuedJobsForLayer(completedLayerId, completedJobId) {
  const layerQueues = getLayerQueues();
  const lid = String(completedLayerId || '').trim();
  if (!lid) return;
  const q = layerQueues[lid];
  if (!q || !q.length) return;
  const next = q[0];
  const rest = q.slice(1);
  delete layerQueues[lid];
  saveState();
  const finishedId = completedJobId ? String(completedJobId).trim() : '';
  try {
    const rec = await createJob({
      repo_layer_id: lid,
      command: next.command,
      command_kind: next.command_kind,
      ...(next.env ? { env: next.env } : {}),
      ...(finishedId ? { prior_context_job_id: finishedId } : {}),
    });
    if (rest.length) {
      layerQueues[rec.layer_id] = rest;
      saveState();
      broadcast({ type: 'layer_queue_moved', from_layer_id: lid, to_layer_id: rec.layer_id, queue_depth: rest.length });
    }
  } catch (e) {
    console.error(`[jobsRuntime] drain queue failed for layer ${lid}:`, e);
    broadcast({
      type: 'layer_queue_drain_failed',
      layer_id: lid,
      detail: String(e.message || e),
    });
  }
}

function runJobAsync(rec, workDir) {
  return runJobAsyncImpl(rec, workDir, {
    drainQueuedJobsForLayer,
    triggerAutoRunDeliveryForJobAndMirror,
  });
}

export async function triggerAutoRunDeliveryForJobAndMirror(rec) {
  return triggerAutoRunDeliveryForJob(rec, {
    mirrorLayerGraphToTaskCloudSSE,
    persistJobMount: (jobRec, agentId) => {
      if (jobRec && agentId) {
        jobRec.mounted_agent_comment_id = String(agentId).trim();
        try {
          saveState();
        } catch {
          /* ignore */
        }
      }
    },
  });
}

export function interruptJob(jobId) {
  const jobs = getJobsMap();
  const running = getRunningMap();
  const rec = jobs.get(jobId);
  if (!rec) throw new Error('job not found');
  const proc = running.get(jobId);
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
  }
  if (rec.status === 'running') rec.status = 'interrupted';
  saveState();
  void mirrorLayerGraphToTaskCloudSSE().catch(() => {});
  return rec;
}

export function deleteJob(jobId) {
  const jobs = getJobsMap();
  const layerQueues = getLayerQueues();
  const rec = jobs.get(jobId);
  if (!rec) throw new Error('job not found');
  interruptJob(jobId);
  try {
    fs.rmSync(jobLogsTaeJsonPath(rec.id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete layerQueues[rec.layer_id];
  deleteLayerTree(rec.layer_id);
  jobs.delete(jobId);
  saveState();
  void mirrorLayerGraphToTaskCloudSSE().catch(() => {});
  return { ok: true };
}

export function registerBootstrapCloneJob(layerId) {
  const jobs = getJobsMap();
  const id = newJobId();
  const rec = {
    id,
    layer_id: layerId,
    layer_path: layerPath(layerId),
    command: '[bootstrap] 容器引导克隆',
    parent_job_id: null,
    repo_layer_id: null,
    status: 'completed',
    created_at: new Date().toISOString(),
    exit_code: 0,
    output: '',
    git_branch: null,
    git_head_at_run_start: null,
    command_kind: 'clone',
    command_env: null,
    prior_context_job_id: null,
  };
  jobs.set(id, rec);
  saveState();
}
