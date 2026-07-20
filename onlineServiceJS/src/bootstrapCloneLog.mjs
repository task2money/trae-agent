import path from 'path';
import {
  appendExecStream,
  resetExecStream,
  getExecStreamFullText,
  completeExecStream,
} from './execStream.mjs';
import { bootstrapRepoLogState } from './bootstrapState.mjs';

/** 克隆日志走通用 exec-stream（分片 + SSE）；与 GET /api/exec-streams/clone/:id/* 同源 */
export function appendCloneLayerLog(layerId, text) {
  appendExecStream('clone', layerId, text);
}

function rebuildBootstrapParallelLogText() {
  if (!bootstrapRepoLogState) return '';
  const { preamble, jobs, bufs } = bootstrapRepoLogState;
  const parts = [preamble];
  for (const job of jobs) {
    const e = bufs.get(job.raw);
    if (!e) continue;
    parts.push(e.header + e.body + (e.failNote || ''));
  }
  return parts.join('\n\n');
}

/**
 * 引导克隆存在失败时的日志页脚：点名失败仓（目录名 + URL），避免仅写「存在失败」。
 * @param {{ raw: string, repoDir: string, errMsg?: string }[]} failedJobs
 * @returns {string}
 */
export function formatBootstrapCloneFailureFooter(failedJobs) {
  const list = Array.isArray(failedJobs) ? failedJobs : [];
  const lines = ['', '【项目克隆】已结束（存在失败，引导继续）。'];
  if (list.length) {
    lines.push(`失败仓库（${list.length}）：`);
    for (const j of list) {
      const name = path.basename(String(j?.repoDir || '')) || '(unknown)';
      const url = String(j?.raw || '').trim() || '(no-url)';
      const errOneLine = String(j?.errMsg || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      lines.push(errOneLine ? `- ${name} — ${url}（${errOneLine}）` : `- ${name} — ${url}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 单仓/多仓克隆失败不阻断引导后续（feature-params / BOOTSTRAP_COMPLETE / 业务端点就绪）。
 * 失败仓可在任务详情「重新克隆」；其余已成功仓照常可用。
 * @param {{ failedCount: number, totalCount: number, failedNames?: string }} opts
 * @returns {{ abort: boolean, progressMessage: string, level: 'ok' | 'partial' }}
 */
export function resolveBootstrapCloneFailurePolicy(opts) {
  const failedCount = Math.max(0, Number(opts?.failedCount) || 0);
  const totalCount = Math.max(0, Number(opts?.totalCount) || 0);
  if (failedCount <= 0) {
    return {
      abort: false,
      progressMessage: '【项目克隆】仓库克隆已完成',
      level: 'ok',
    };
  }
  const names = String(opts?.failedNames || '').trim() || `${failedCount} 个`;
  return {
    abort: false,
    progressMessage:
      `【项目克隆】部分失败：失败 ${failedCount}/${totalCount || failedCount} 个仓库：${names}（其余已就绪，引导继续）`.slice(
        0,
        2000,
      ),
    level: 'partial',
  };
}

/**
 * 引导多仓并行克隆进行中时供 GET /api/repos/bootstrap-clone-log 返回 `segments`（按任务详情仓库顺序）。
 * @param {string} layerId
 * @returns {{ repo_url: string, text: string }[] | null}
 */
export function getBootstrapCloneLogSegmentsForApi(layerId) {
  if (!bootstrapRepoLogState || bootstrapRepoLogState.layerId !== layerId) {
    return null;
  }
  const { jobs, bufs } = bootstrapRepoLogState;
  return jobs.map((job) => {
    const e = bufs.get(job.raw);
    const text = e ? e.header + e.body + (e.failNote || '') : '';
    return { repo_url: job.raw, text };
  });
}

export function getCloneLayerLogText(layerId) {
  if (bootstrapRepoLogState && bootstrapRepoLogState.layerId === layerId) {
    return rebuildBootstrapParallelLogText();
  }
  return getExecStreamFullText('clone', layerId);
}

export function clearCloneLayerLog(layerId) {
  resetExecStream('clone', layerId);
}

/** 引导克隆结束：封包并推送 exec_stream_complete（与 UI 克隆队列一致） */
export function finalizeCloneLayerLog(layerId) {
  completeExecStream('clone', layerId);
}

export { rebuildBootstrapParallelLogText };
