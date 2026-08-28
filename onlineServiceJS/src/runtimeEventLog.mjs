/**
 * BOOTSTRAP_* / AUTO_RUN_* 关键事件：stdout JSON（本地 Promtail）+ soft POST 至 Cloud runtime-event（进 Loki）。
 */
import { logJson } from './jsonLog.mjs';
import { postJson, taskApiPrefix } from './saasTaskCloud.mjs';

const ALLOWED = new Set([
  'BOOTSTRAP_PHASE',
  'BOOTSTRAP_COMPLETE',
  'BOOTSTRAP_FAILED',
  'AGENT_KICKOFF_DEFERRED',
  'AGENT_KICKOFF_RESUME',
  'AUTO_RUN_FIRST_INSTRUCTION_START',
  'AUTO_RUN_FIRST_INSTRUCTION_STARTED',
  'AUTO_RUN_FIRST_SKIP',
  'AUTO_RUN_FIRST_INSTRUCTION_FAILED',
  'AT_MENTION_JOB_START',
  'AT_MENTION_JOB_SKIP',
  'AT_MENTION_JOB_FAILED',
  'AUTO_RUN_DELIVERY_BEGIN',
  'AUTO_RUN_DELIVERY_COMPLETE',
  'AUTO_RUN_DELIVERY_FAILED',
  'AUTO_RUN_DELIVERY_SKIP',
  'AUTO_RUN_PR_BACKFILL_OK',
  'AUTO_RUN_PR_BACKFILL_FAILED',
  'AUTO_RUN_GIT_PR_REPLY_OK',
  'AUTO_RUN_GIT_PR_REPLY_FAILED',
  'EDIT_RUN_AGENT_COMMENT_CREATED',
  'EDIT_RUN_AGENT_COMMENT_CREATE_FAILED',
  'CONTAINER_AGENT_COMMENT_CREATED',
]);

/**
 * @param {string} event
 * @param {{
 *   level?: string,
 *   phase?: string,
 *   message?: string,
 *   trace_id?: string,
 *   fields?: Record<string, unknown>,
 *   consoleLine?: string,
 *   postFn?: typeof postRuntimeEventToSaas,
 * }} [opts]
 */
export function emitRuntimeEvent(event, opts = {}) {
  const name = String(event || '').trim();
  if (!name || !ALLOWED.has(name)) {
    console.warn(`[onlineServiceJS] runtime_event_skip unsupported=${name}`);
    return;
  }
  const level = String(opts.level || 'info').toLowerCase();
  const phase = String(opts.phase || '').trim();
  const message = String(opts.message || '').trim();
  const traceId = String(opts.trace_id || '').trim();
  const fields = opts.fields && typeof opts.fields === 'object' ? opts.fields : {};

  logJson(level, name, {
    use_startup_trace: true,
    event: name,
    ...(phase ? { phase } : {}),
    ...(message ? { detail: message.slice(0, 800) } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
    ...fields,
  });

  if (opts.consoleLine) {
    const line = String(opts.consoleLine);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  const postFn = opts.postFn || postRuntimeEventToSaas;
  void Promise.resolve(
    postFn({
      event: name,
      level,
      phase,
      message,
      trace_id: traceId,
      fields,
    }),
  ).catch(() => {});
}

/**
 * Soft-fail POST …/server-container-token/runtime-event/
 * @param {{ event: string, level?: string, phase?: string, message?: string, trace_id?: string, fields?: object }} payload
 */
export async function postRuntimeEventToSaas(payload) {
  let cloudPrefix;
  try {
    cloudPrefix = taskApiPrefix();
  } catch {
    return false;
  }
  const accessToken = String(process.env.ACCESS_TOKEN || '').trim();
  if (!cloudPrefix || !accessToken) return false;
  const event = String(payload?.event || '').trim();
  if (!event || !ALLOWED.has(event)) return false;
  const url = `${cloudPrefix.replace(/\/$/, '')}/server-container-token/runtime-event/`;
  const body = {
    access_token: accessToken,
    event,
    level: String(payload?.level || 'info').toLowerCase(),
  };
  const phase = String(payload?.phase || '').trim();
  if (phase) body.phase = phase;
  const message = String(payload?.message || '').trim();
  if (message) body.message = message.slice(0, 800);
  const traceId = String(payload?.trace_id || '').trim();
  if (traceId) body.trace_id = traceId;
  if (payload?.fields && typeof payload.fields === 'object') {
    body.fields = payload.fields;
  }
  try {
    await postJson(url, body, 8);
    return true;
  } catch {
    return false;
  }
}

export { ALLOWED as RUNTIME_EVENT_NAMES };
