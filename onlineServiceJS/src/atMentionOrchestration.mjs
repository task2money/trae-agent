/**
 * ContextPack at_mention_run → 自动创建 trae job（容器内闭环）。
 * 与 auto_run 首指令互斥：合法 ContextPack（可建 job）时优先本路径；
 * 仅有残缺 at_mention_run 时由 postBootstrapAgentKickoff 回退 auto_run。
 */
import fs from 'fs';
import path from 'path';
import { runtimeDir } from './paths.mjs';
import { normalizeAtMentionContextPack } from './atMentionContext.mjs';
import { createEditRunAgentComment } from './editRunAgentComment.mjs';

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
 * 用于检测 detail 是否带 at_mention_run 对象（完整校验见 normalizeAtMentionContextPack）。
 */
export function detailHasAtMentionRun(detail) {
  const run = detail?.at_mention_run;
  return Boolean(run && typeof run === 'object');
}

/**
 * at_mention_run 缺失（notify 失败/空 URL，案例 116）时，从 detail 内
 * context_pack.comment_thread 取最后一条人类评论作为兜底指令（OPT-20260822-021）。
 * 线程结构与 normalizeAtMentionContextPack 的 comment_thread 一致。
 */
export function composeFallbackCommandFromDetail(detail) {
  const pack = detail?.context_pack;
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

  const run = { ...normalized.pack.at_mention_run };
  let agentCommentId = String(run.agent_comment_id || '').trim();
  if (!agentCommentId) {
    const imageId = String(run.installed_image?.id || normalized.pack.installed_image?.id || '').trim();
    const createFn = opts?.createAgentCommentFn || createEditRunAgentComment;
    const created = await createFn({
      parentCommentId: String(run.parent_comment_id || '').trim(),
      installedImageId: imageId,
      content: command,
      source: String(run.source || 'at_mention').trim() || 'at_mention',
      agentModels: run.agent_models,
    });
    if (!created?.ok || !String(created.id || '').trim()) {
      console.warn(
        `[onlineServiceJS] AT_MENTION_JOB_SKIP reason=create_agent_comment_failed detail=${String(created?.detail || '').slice(0, 200)}`,
      );
      return null;
    }
    agentCommentId = String(created.id).trim();
    run.agent_comment_id = agentCommentId;
    run.run_id = String(run.run_id || agentCommentId).trim();
    console.log(
      `[onlineServiceJS] event=at_mention_agent_comment_created agent_comment_id=${agentCommentId} parent_comment_id=${String(run.parent_comment_id || '')}`,
    );
  }
  console.log(
    `[onlineServiceJS] event=at_mention_job_start run_id=${String(run.run_id || '')} agent_comment_id=${agentCommentId} layer_id=${layerId} command_len=${command.length}`,
  );
  const rec = await createJobFn({
    command,
    command_kind: 'trae',
    repo_layer_id: layerId,
    at_mention_run: true,
    at_mention_run_id: String(run.run_id || ''),
    at_mention_agent_comment_id: agentCommentId,
    mounted_agent_comment_id: agentCommentId,
  });
  writeAtMentionJobMarker(rec?.id, {
    run_id: String(run.run_id || ''),
    agent_comment_id: agentCommentId,
  }, fsApi);
  console.log(
    `[onlineServiceJS] event=at_mention_job_started job_id=${String(rec?.id || '')} run_id=${String(run.run_id || '')} layer_id=${String(rec?.layer_id || '')}`,
  );
  return rec;
}

/**
 * at_mention_run 缺失但容器以 COMMENT_ID 启动（案例 116：AICommentServiceURL 空导致
 * notify 失败、无 pending Agent 评论）时，用评论内容兜底补跑首条 trae job。
 * 仅在 auto_run=false（auto_run 路径会建 job 时不重复）触发；幂等复用 at_mention 标记。
 * @returns {Promise<object|null>} createJob 返回的 rec，或 null（未触发）
 */
export async function maybeStartCommentIdFallbackJob(opts) {
  const detail = opts?.detail;
  const layerId = String(opts?.layerId || '').trim();
  const createJobFn = opts?.createJobFn;
  const fsApi = opts?.fsApi || fs;
  const log = opts?.log || console;

  if (typeof createJobFn !== 'function') {
    throw new Error('createJobFn required');
  }
  const commentId = String(opts?.commentId || '').trim();
  if (!commentId) return null;
  if (detailHasAtMentionRun(detail)) return null; // 正常 at_mention 路径优先
  if (Boolean(detail?.task?.auto_run)) return null; // auto_run 会建 job，避免双建
  if (!layerId) return null;
  if (hasAtMentionJobMarker(fsApi)) return null; // 幂等

  let command = composeFallbackCommandFromDetail(detail);
  if (!command && typeof opts.fetchCommentContent === 'function') {
    try {
      const fetched = await opts.fetchCommentContent(commentId);
      command = String(fetched?.content || '').trim();
    } catch (e) {
      log.warn?.(
        `[onlineServiceJS] COMMENT_ID_FALLBACK_FETCH_FAILED comment_id=${commentId} err=${String(e?.message || e).slice(0, 200)}`,
      );
    }
  }
  if (!command) {
    log.warn?.(
      `[onlineServiceJS] COMMENT_ID_FALLBACK_SKIP comment_id=${commentId} reason=empty_command`,
    );
    return null;
  }

  const imageId = String(
    detail?.task?.installed_image_id ||
      detail?.at_mention_run?.installed_image?.id ||
      '',
  ).trim();
  let agentCommentId = '';
  if (imageId) {
    const createFn = opts?.createAgentCommentFn || createEditRunAgentComment;
    const created = await createFn({
      parentCommentId: commentId,
      installedImageId: imageId,
      content: command,
      source: 'at_mention',
    });
    if (created?.ok && String(created.id || '').trim()) {
      agentCommentId = String(created.id).trim();
    } else {
      log.warn?.(
        `[onlineServiceJS] COMMENT_ID_FALLBACK_AGENT_CREATE_FAILED comment_id=${commentId} detail=${String(created?.detail || '').slice(0, 200)}`,
      );
    }
  }

  log.log?.(
    `[onlineServiceJS] COMMENT_ID_FALLBACK_START comment_id=${commentId} command_len=${command.length}`,
  );
  const rec = await createJobFn({
    command,
    command_kind: 'trae',
    repo_layer_id: layerId,
    at_mention_run: true,
    at_mention_run_id: agentCommentId,
    at_mention_agent_comment_id: agentCommentId,
    mounted_agent_comment_id: agentCommentId,
    comment_id_fallback: true,
  });
  writeAtMentionJobMarker(rec?.id, { comment_id_fallback: true, comment_id: commentId }, fsApi);
  return rec;
}
