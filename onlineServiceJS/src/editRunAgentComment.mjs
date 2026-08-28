/**
 * 改后执行交付：在父评论下创建 pending container_agent，供 PR 回填。
 */
import { readPersistedTokenStore } from './bootstrapTokenStore.mjs';
import { taskApiPrefix } from './saasTaskCloud.mjs';
import { emitRuntimeEvent } from './runtimeEventLog.mjs';
import { withSaasInboundScope } from './saasInboundScope.mjs';
import { traceHeadersForOutbound } from './traceId.mjs';

/**
 * @param {() => string|null} [prefixFn]
 * @returns {string|null}
 */
export function buildContainerAgentCreateUrl(prefixFn = taskApiPrefix) {
  let prefix;
  try {
    prefix = prefixFn();
  } catch {
    return null;
  }
  if (!prefix) return null;
  const base = String(prefix).replace(/\/cloud\/?$/, '');
  return `${base}/container-agent-comments`;
}

/**
 * @param {{
 *   parentCommentId: string,
 *   installedImageId: string,
 *   content?: string,
 *   accessToken?: string,
 *   fetchFn?: typeof fetch,
 *   prefixFn?: () => string|null,
 *   readTokenFn?: () => { accessToken?: string },
 * }} opts
 */
export async function createEditRunAgentComment(opts = {}) {
  const parentCommentId = String(opts?.parentCommentId || '').trim();
  const installedImageId = String(opts?.installedImageId || '').trim();
  if (!parentCommentId || !installedImageId) {
    return { ok: false, detail: 'parent_comment_id and installed_image_id required' };
  }
  const url = buildContainerAgentCreateUrl(opts?.prefixFn || taskApiPrefix);
  if (!url) {
    return { ok: false, detail: 'create_url_unavailable' };
  }
  const readToken = opts?.readTokenFn || readPersistedTokenStore;
  const accessToken =
    String(opts?.accessToken || '').trim() ||
    String(readToken()?.accessToken || '').trim() ||
    String(process.env.ACCESS_TOKEN || '').trim();
  if (!accessToken) {
    return { ok: false, detail: 'access_token_missing' };
  }
  const fetchFn = opts?.fetchFn || fetch;
  const content =
    String(opts?.content || '').trim() || '修改指令后执行：交付中…';
  const source = String(opts?.source || 'edit_run').trim() || 'edit_run';
  const atMentionRun = {
    source,
    parent_comment_id: parentCommentId,
    installed_image: { id: installedImageId },
  };
  if (Array.isArray(opts?.agentModels) && opts.agentModels.length > 0) {
    atMentionRun.agent_models = opts.agentModels;
  }
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: {
        ...traceHeadersForOutbound(),
        'Content-Type': 'application/json',
        'X-Access-Token': accessToken,
      },
      body: JSON.stringify(withSaasInboundScope({
        parent_comment_id: parentCommentId,
        installed_image_id: installedImageId,
        content,
        context_pack: {
          at_mention_run: atMentionRun,
        },
      })),
    });
    const bodyText = await r.text();
    let parsed = null;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsed = null;
    }
    if (!r.ok) {
      return {
        ok: false,
        detail: `http_${r.status}:${bodyText.slice(0, 300)}`,
        url,
        status: r.status,
      };
    }
    const id = String(parsed?.id || '').trim();
    if (!id) {
      return { ok: false, detail: 'create_missing_id', url };
    }
    const eventName = source === 'edit_run' ? 'EDIT_RUN_AGENT_COMMENT_CREATED' : 'CONTAINER_AGENT_COMMENT_CREATED';
    emitRuntimeEvent(eventName, {
      fields: { agent_comment_id: id, parent_comment_id: parentCommentId, source },
      consoleLine: `[onlineServiceJS] ${eventName} agent_comment_id=${id} parent_comment_id=${parentCommentId} source=${source}`,
    });
    return { ok: true, id, url };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 500), url };
  }
}

/**
 * @param {object} rec job record
 * @param {{
 *   createFn?: typeof createEditRunAgentComment,
 *   persistMount?: (agentId: string) => void,
 * }} [deps]
 */
export async function ensureEditRunMountedAgentComment(rec, deps = {}) {
  const existing = String(rec?.mounted_agent_comment_id || '').trim();
  if (existing) {
    return { ok: true, id: existing, reused: true };
  }
  if (!rec?.edit_run_delivery) {
    return { ok: false, skipped: true, reason: 'not_edit_run_delivery' };
  }
  const parentCommentId = String(rec?.mounted_parent_comment_id || '').trim();
  const installedImageId = String(rec?.edit_run_installed_image_id || '').trim();
  if (!parentCommentId || !installedImageId) {
    return { ok: false, skipped: true, reason: 'missing_parent_or_image' };
  }
  const createFn = deps.createFn || createEditRunAgentComment;
  const created = await createFn({
    parentCommentId,
    installedImageId,
    content: String(rec?.command || '').trim().slice(0, 200) || '修改指令后执行',
  });
  if (!created.ok) {
    emitRuntimeEvent('EDIT_RUN_AGENT_COMMENT_CREATE_FAILED', {
      level: 'warn',
      message: String(created.detail || 'failed').slice(0, 240),
      fields: { parent_comment_id: parentCommentId },
      consoleLine: `[onlineServiceJS] EDIT_RUN_AGENT_COMMENT_CREATE_FAILED parent_comment_id=${parentCommentId} detail=${String(created.detail || '').slice(0, 240)}`,
    });
    return created;
  }
  rec.mounted_agent_comment_id = created.id;
  if (typeof deps.persistMount === 'function') {
    try {
      deps.persistMount(created.id);
    } catch {
      /* ignore */
    }
  }
  return { ok: true, id: created.id, reused: false };
}
