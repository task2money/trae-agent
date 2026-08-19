import fs from 'fs';
import path from 'path';

import { bootstrapCloneLayerId } from './bootstrapState.mjs';
import { getCloneOpStatus } from './cloneQueue.mjs';
import {
  deleteLayerTree,
  layerPath,
  layerRootOrChildHasGit,
  listLayerRows,
  readLayerMeta,
  resolvedParentLayerId,
  gitWorktreeDirty,
  layerGitRemoteSnapshot,
} from './layerFs.mjs';
import { layersRoot } from './paths.mjs';
import { publishLayerGraphSnapshotToSaas } from './saasTaskCloud.mjs';
import { getLayerQueues, jobToApiDict, listJobs } from './jobsRuntimeState.mjs';

function createdAtMsForSort(iso) {
  const m = Date.parse(iso || '');
  return Number.isFinite(m) ? m : 0;
}

/**
 * 与 static/index.html sortLayersSerialChronological 一致：created_at 旧→新，同秒 bootstrap 层优先。
 */
export function sortLayersSerialChronological(layerList, bootstrapLayerId) {
  const bs = String(bootstrapLayerId || '').trim();
  const bsUse = bs && layerList.some((r) => r.layer_id === bs) ? bs : '';
  return [...layerList].sort((a, b) => {
    const da = createdAtMsForSort(a.created_at);
    const db = createdAtMsForSort(b.created_at);
    if (da !== db) return da - db;
    const sa = bsUse && a.layer_id === bsUse ? 1 : 0;
    const sb = bsUse && b.layer_id === bsUse ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return String(a.layer_id || '').localeCompare(String(b.layer_id || ''));
  });
}

/**
 * 只把「有合法 meta、克隆进行中、或已有仓库内容」的目录计为可写层。
 * 避免残留空目录名符合 layer id 时混入 GET /api/layers，在图上多出一个与 clone 同级的伪节点。
 */
export function layerIdQualifiesForSnapshot(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid) return false;
  const p = layerPath(lid);
  let stDir;
  try {
    stDir = fs.existsSync(p) ? fs.statSync(p) : null;
  } catch {
    return false;
  }
  if (!stDir || !stDir.isDirectory()) return false;
  const m = readLayerMeta(lid);
  if (m && m.kind) return true;
  const op = getCloneOpStatus(lid);
  if (op && (op.status === 'queued' || op.status === 'running')) return true;
  try {
    if (fs.existsSync(path.join(p, 'base'))) return true;
  } catch {
    /* ignore */
  }
  if (layerRootOrChildHasGit(p)) return true;
  return false;
}

/**
 * 启动时移除非「可写层」的残留 layer 子目录，避免与真实克隆层在 UI 上重复出现。
 */
export function sweepDanglingLayerDirs() {
  const all = listLayerRows();
  for (const row of all) {
    const lid = row.layer_id;
    if (layerIdQualifiesForSnapshot(lid)) continue;
    const op = getCloneOpStatus(lid);
    if (op && (op.status === 'queued' || op.status === 'running')) continue;
    try {
      deleteLayerTree(lid);
    } catch {
      /* ignore */
    }
  }
}

export function buildLayersSnapshot(bootstrapLayerId) {
  const layerQueues = getLayerQueues();
  const rows = listLayerRows().filter((r) => layerIdQualifiesForSnapshot(r.layer_id));
  const known = new Set(rows.map((r) => r.layer_id));
  const jobsList = listJobs();
  const cmdByLayer = {};
  const cloneCmdByLayer = {};
  for (let i = jobsList.length - 1; i >= 0; i--) {
    const j = jobsList[i];
    const lid = String(j.layer_id || '').trim();
    if (!lid) continue;
    if (j.command_kind === 'clone') {
      if (cloneCmdByLayer[lid] === undefined && j.command) cloneCmdByLayer[lid] = j.command;
      continue;
    }
    if (cmdByLayer[lid] === undefined) cmdByLayer[lid] = j.command;
  }
  const jobByLayer = {};
  for (let i = jobsList.length - 1; i >= 0; i--) {
    const j = jobsList[i];
    const lid = String(j.layer_id || '').trim();
    if (!lid || j.command_kind === 'clone') continue;
    if (!jobByLayer[lid]) jobByLayer[lid] = j;
  }
  const layers = [];
  for (const row of rows) {
    const lid = row.layer_id;
    const meta = readLayerMeta(lid);
    if (meta?.kind === 'empty') {
      // 引导空层锚点：心跳早于克隆时若过滤掉，层图会变成 0 节点。
      // 输出为「正在准备可写层」的 pending 节点，前端据此展示引导中文案而非空白。
      layers.push({
        layer_id: lid,
        created_at: row.created_at,
        command: null,
        parent_layer_id: resolvedParentLayerId(lid, known, jobsList),
        job_id: null,
        job_status: null,
        queue_depth: 0,
        queue_items: [],
        mind_state: 'pending',
        git_worktree_dirty: false,
        git_remote: null,
        meta_kind: 'empty',
        bootstrap_pending: true,
      });
      continue;
    }
    let displayCmd = cmdByLayer[lid] || null;
    if (!displayCmd && meta?.kind === 'clone' && meta.clone_url) {
      displayCmd = `git clone ${meta.clone_url}`;
    }
    if (!displayCmd && cloneCmdByLayer[lid]) {
      displayCmd = cloneCmdByLayer[lid];
    }
    const qArr = Array.isArray(layerQueues[lid]) ? layerQueues[lid] : [];
    const queue_items = qArr.map((entry, position) => {
      const cmd = String(entry.command || '');
      const command_preview = cmd.length > 72 ? cmd.slice(0, 72) + '…' : cmd;
      return {
        position,
        command_kind: entry.command_kind || 'trae',
        command_preview,
      };
    });
    const item = {
      layer_id: lid,
      created_at: row.created_at,
      command: displayCmd,
      parent_layer_id: resolvedParentLayerId(lid, known, jobsList),
      job_id: jobByLayer[lid]?.id || null,
      job_status: jobByLayer[lid]?.status || null,
      queue_depth: qArr.length,
      queue_items,
      mind_state: jobByLayer[lid]?.status === 'running' || jobByLayer[lid]?.status === 'pending' ? 'running' : 'idle_done',
      git_worktree_dirty: gitWorktreeDirty(lid),
      git_remote: layerGitRemoteSnapshot(lid),
      meta_kind: meta?.kind || null,
    };
    layers.push(item);
  }
  const bs = String(bootstrapLayerId || '').trim();
  if (bs) {
    const idx = layers.findIndex((x) => x.layer_id === bs);
    if (idx > 0) {
      const [sp] = layers.splice(idx, 1);
      layers.unshift(sp);
    }
  }
  return {
    layers,
    jobs: jobsList.map(jobToApiDict),
    layers_root: layersRoot(),
    bootstrap_layer_id: bs || null,
  };
}

/** 将当前层级图镜像到任务云 SSE（container_layer_graph），供 Vue 任务详情与容器内 GET /api/events/stream 解耦。 */
export async function mirrorLayerGraphToTaskCloudSSE() {
  await publishLayerGraphSnapshotToSaas(buildLayersSnapshot(bootstrapCloneLayerId));
}
