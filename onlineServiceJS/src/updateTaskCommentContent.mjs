/**
 * Container inbound: update task title/description or human comment content.
 */
import { readPersistedTokenStore } from './bootstrapTokenStore.mjs';
import { taskApiPrefix } from './saasTaskCloud.mjs';
import { postJson } from './saasPostJson.mjs';
import { randomUUID } from 'crypto';

/**
 * @param {string} action update-task-content | update-comment-content
 * @param {() => string|null} [prefixFn]
 */
export function buildUpdateContentInboundUrl(action, prefixFn = taskApiPrefix) {
  let prefix;
  try {
    prefix = prefixFn();
  } catch {
    return null;
  }
  if (!prefix) return null;
  const act = String(action || '').trim().replace(/^\/+|\/+$/g, '');
  if (!act) return null;
  return `${String(prefix).replace(/\/$/, '')}/server-container-token/${act}/`;
}

function resolveAccessToken(opts = {}) {
  const readToken = opts.readTokenFn || readPersistedTokenStore;
  return (
    String(opts.accessToken || '').trim() ||
    String(readToken()?.accessToken || '').trim() ||
    String(process.env.ACCESS_TOKEN || '').trim()
  );
}

/**
 * @param {{
 *   title?: string,
 *   description?: string,
 *   accessToken?: string,
 *   idempotencyKey?: string,
 *   prefixFn?: () => string|null,
 *   readTokenFn?: () => { accessToken?: string },
 *   postJsonFn?: typeof postJson,
 * }} opts
 */
export async function updateTaskContent(opts = {}) {
  const url = buildUpdateContentInboundUrl('update-task-content', opts.prefixFn || taskApiPrefix);
  if (!url) return { ok: false, skipped: true, reason: 'inbound_url_unavailable' };
  const accessToken = resolveAccessToken(opts);
  if (!accessToken) return { ok: false, skipped: true, reason: 'access_token_missing' };
  const hasTitle = opts.title !== undefined;
  const hasDesc = opts.description !== undefined;
  if (!hasTitle && !hasDesc) {
    return { ok: false, skipped: true, reason: 'title_or_description_required' };
  }
  const idem =
    String(opts.idempotencyKey || '').trim() ||
    `update-task-content:${randomUUID()}`;
  const body = {
    access_token: accessToken,
    idempotency_key: idem,
  };
  if (hasTitle) body.title = opts.title;
  if (hasDesc) body.description = opts.description;
  const postFn = opts.postJsonFn || postJson;
  const result = await postFn(url, body, opts.timeoutSec || 30);
  return { ok: true, idempotency_key: idem, result };
}

/**
 * @param {{
 *   targetCommentId: string,
 *   content: string,
 *   allowEmpty?: boolean,
 *   accessToken?: string,
 *   idempotencyKey?: string,
 *   prefixFn?: () => string|null,
 *   readTokenFn?: () => { accessToken?: string },
 *   postJsonFn?: typeof postJson,
 * }} opts
 */
export async function updateCommentContent(opts = {}) {
  const url = buildUpdateContentInboundUrl('update-comment-content', opts.prefixFn || taskApiPrefix);
  if (!url) return { ok: false, skipped: true, reason: 'inbound_url_unavailable' };
  const accessToken = resolveAccessToken(opts);
  if (!accessToken) return { ok: false, skipped: true, reason: 'access_token_missing' };
  const target = String(opts.targetCommentId || '').trim();
  if (!target) return { ok: false, skipped: true, reason: 'target_comment_id_required' };
  const idem =
    String(opts.idempotencyKey || '').trim() ||
    `update-comment-content:${target}:${randomUUID()}`;
  const body = {
    access_token: accessToken,
    target_comment_id: target,
    content: opts.content == null ? '' : String(opts.content),
    allow_empty: Boolean(opts.allowEmpty),
    idempotency_key: idem,
  };
  const postFn = opts.postJsonFn || postJson;
  const result = await postFn(url, body, opts.timeoutSec || 30);
  return { ok: true, idempotency_key: idem, result };
}
