/**
 * ContextPack at_mention_run → 自动创建 trae job（容器内闭环）。
 * 与 auto_run 首指令互斥：detail 含合法 at_mention_run 时优先本路径。
 */
import fs from 'fs';
import path from 'path';
import { runtimeDir } from './paths.mjs';
import { normalizeAtMentionContextPack } from './atMentionContext.mjs';

export function atMentionJobMarkerPath() {
  return path.join(runtimeDir(), 'at_mention_job.json');
}

export function hasAtMentionJobMarker(fsApi = fs) {
  try {
    return fsApi.existsSync(atMentionJobMarkerPath());
  } catch {
    return false;
  }
}

export function writeAtMentionJobMarker(jobId, extra = {}, fsApi = fs) {
  const p = atMentionJobMarkerPath();
  fsApi.mkdirSync(path.dirname(p), { recursive: true });
  fsApi.writeFileSync(
    p,
    JSON.stringify(
      {
        job_id: String(jobId || ''),
        at: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * 从 ContextPack 取触发指令：优先 trigger_comment.content，否则线程中最后一条 human。
 */
export function composeAtMentionCommand(pack) {
  const run = pack?.at_mention_run;
  const fromTrigger = String(run?.trigger_comment?.content || '').trim();
  if (fromTrigger) return fromTrigger;
  const thread = Array.isArray(pack?.comment_thread) ? pack.comment_thread : [];
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const item = thread[i];
    if (!item || typeof item !== 'object') continue;
    const kind = String(item.kind || 'human').toLowerCase();
    if (kind !== 'human') continue;
    const content = String(item.content || '').trim();
    if (content) return content;
  }
  return '';
}

/**
 * detail 是否带有可识别的 at_mention_run（无需 pack 全量校验通过）。
 * 用于与 auto_run 互斥：有 at_mention_run 即跳过 auto_run。
 */
export function detailHasAtMentionRun(detail) {
  const run = detail?.at_mention_run;
  return Boolean(run && typeof run === 'object');
}

export function shouldTriggerAtMentionJob({ packOk, layerId, command, markerExists }) {
  return (
    Boolean(packOk) &&
    Boolean(String(layerId || '').trim()) &&
    Boolean(String(command || '').trim()) &&
    !markerExists
  );
}

/**
 * bootstrap 完成后：若 detail 含合法 ContextPack，则创建一条 at-mention job（幂等）。
 * @returns {Promise<object|null>} createJob 返回的 rec，或 null（未触发）
 */
export async function maybeStartAtMentionJob(opts) {
  const detail = opts?.detail;
  const layerId = String(opts?.layerId || '').trim();
  const createJobFn = opts?.createJobFn;
  const fsApi = opts?.fsApi || fs;

  if (typeof createJobFn !== 'function') {
    throw new Error('createJobFn required');
  }

  if (!detailHasAtMentionRun(detail)) {
    return null;
  }

  const normalized = normalizeAtMentionContextPack(detail);
  const command = normalized.ok ? composeAtMentionCommand(normalized.pack) : '';
  const markerExists = hasAtMentionJobMarker(fsApi);

  if (
    !shouldTriggerAtMentionJob({
      packOk: normalized.ok,
      layerId,
      command,
      markerExists,
    })
  ) {
    if (!normalized.ok) {
      console.warn(
        `[onlineServiceJS] AT_MENTION_JOB_SKIP reason=pack_invalid detail=${String(normalized.error || '').slice(0, 200)}`,
      );
    } else if (!command) {
      console.warn('[onlineServiceJS] AT_MENTION_JOB_SKIP reason=empty_command');
    } else if (markerExists) {
      console.log('[onlineServiceJS] AT_MENTION_JOB_SKIP reason=marker_exists');
    } else if (!layerId) {
      console.warn('[onlineServiceJS] AT_MENTION_JOB_SKIP reason=no_layer_id');
    }
    return null;
  }

  const run = normalized.pack.at_mention_run;
  console.log(
    `[onlineServiceJS] event=at_mention_job_start run_id=${String(run.run_id || '')} agent_comment_id=${String(run.agent_comment_id || '')} layer_id=${layerId} command_len=${command.length}`,
  );
  const rec = await createJobFn({
    command,
    command_kind: 'trae',
    repo_layer_id: layerId,
    at_mention_run: true,
    at_mention_run_id: String(run.run_id || ''),
    at_mention_agent_comment_id: String(run.agent_comment_id || ''),
  });
  writeAtMentionJobMarker(rec?.id, {
    run_id: String(run.run_id || ''),
    agent_comment_id: String(run.agent_comment_id || ''),
  }, fsApi);
  console.log(
    `[onlineServiceJS] event=at_mention_job_started job_id=${String(rec?.id || '')} run_id=${String(run.run_id || '')} layer_id=${String(rec?.layer_id || '')}`,
  );
  return rec;
}
