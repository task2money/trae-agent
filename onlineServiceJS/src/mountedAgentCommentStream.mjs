/**
 * 将挂载了 mounted_agent_comment_id 的 job 输出推送到 taskAIComment /stream|/fail。
 * 与 autoRunPrBackfill 的 /complete 共用 URL/鉴权约定。
 */
import { readPersistedTokenStore } from './bootstrapTokenStore.mjs';
import { taskApiPrefix } from './saasTaskCloud.mjs';
import { traceHeadersForOutbound } from './traceId.mjs';

/**
 * @param {string} agentCommentId
 * @param {'stream'|'complete'|'fail'} action
 * @param {() => string|null} [prefixFn]
 */
export function buildContainerAgentActionUrl(agentCommentId, action, prefixFn = taskApiPrefix) {
  const id = String(agentCommentId || '').trim();
  const act = String(action || '').trim();
  if (!id || !act) return null;
  let prefix;
  try {
    prefix = prefixFn();
  } catch {
    return null;
  }
  if (!prefix) return null;
  const base = String(prefix).replace(/\/cloud\/?$/, '');
  return `${base}/container-agent-comments/${encodeURIComponent(id)}/${act}`;
}

export function buildContainerAgentStreamUrl(agentCommentId, prefixFn = taskApiPrefix) {
  return buildContainerAgentActionUrl(agentCommentId, 'stream', prefixFn);
}

/**
 * @param {{
 *   agentCommentId: string,
 *   chunk: string,
 *   accessToken?: string,
 *   fetchFn?: typeof fetch,
 *   prefixFn?: () => string|null,
 *   readTokenFn?: () => { accessToken?: string },
 * }} opts
 */
export async function postMountedAgentChunk(opts) {
  const agentCommentId = String(opts?.agentCommentId || '').trim();
  const chunk = String(opts?.chunk ?? '');
  if (!agentCommentId || !chunk) {
    return { ok: false, detail: 'agent_comment_id and chunk required' };
  }
  const url = buildContainerAgentStreamUrl(agentCommentId, opts?.prefixFn || taskApiPrefix);
  if (!url) return { ok: false, detail: 'stream_url_unavailable' };
  const readToken = opts?.readTokenFn || readPersistedTokenStore;
  const accessToken =
    String(opts?.accessToken || '').trim() ||
    String(readToken()?.accessToken || '').trim() ||
    String(process.env.ACCESS_TOKEN || '').trim();
  if (!accessToken) return { ok: false, detail: 'access_token_missing' };
  const fetchFn = opts?.fetchFn || fetch;
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: {
        ...traceHeadersForOutbound(),
        'Content-Type': 'application/json',
        'X-Access-Token': accessToken,
      },
      body: JSON.stringify({ chunk }),
    });
    const bodyText = await r.text();
    if (!r.ok) {
      return { ok: false, detail: `http_${r.status}:${bodyText.slice(0, 300)}`, url };
    }
    return { ok: true, url };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 500), url };
  }
}

/**
 * @param {{
 *   agentCommentId: string,
 *   detail?: string,
 *   accessToken?: string,
 *   fetchFn?: typeof fetch,
 *   prefixFn?: () => string|null,
 *   readTokenFn?: () => { accessToken?: string },
 * }} opts
 */
export async function failMountedAgentComment(opts) {
  const agentCommentId = String(opts?.agentCommentId || '').trim();
  if (!agentCommentId) return { ok: false, detail: 'agent_comment_id required' };
  const url = buildContainerAgentActionUrl(agentCommentId, 'fail', opts?.prefixFn || taskApiPrefix);
  if (!url) return { ok: false, detail: 'fail_url_unavailable' };
  const readToken = opts?.readTokenFn || readPersistedTokenStore;
  const accessToken =
    String(opts?.accessToken || '').trim() ||
    String(readToken()?.accessToken || '').trim() ||
    String(process.env.ACCESS_TOKEN || '').trim();
  if (!accessToken) return { ok: false, detail: 'access_token_missing' };
  const fetchFn = opts?.fetchFn || fetch;
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: {
        ...traceHeadersForOutbound(),
        'Content-Type': 'application/json',
        'X-Access-Token': accessToken,
      },
      body: JSON.stringify({ detail: String(opts?.detail || 'job failed').slice(0, 2000) }),
    });
    const bodyText = await r.text();
    if (!r.ok) {
      return { ok: false, detail: `http_${r.status}:${bodyText.slice(0, 300)}`, url };
    }
    return { ok: true, url };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 500), url };
  }
}

/**
 * 简单节流：合并短时间内的 chunk，降低 /stream 请求风暴。
 */
export function createMountedAgentChunkBuffer(opts = {}) {
  const flushMs = Number.isFinite(opts.flushMs) ? Number(opts.flushMs) : 200;
  const maxChars = Number.isFinite(opts.maxChars) ? Number(opts.maxChars) : 2048;
  const postFn = opts.postFn || postMountedAgentChunk;
  let buf = '';
  let timer = null;
  let agentCommentId = '';
  let chain = Promise.resolve();

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const chunk = buf;
    buf = '';
    const id = agentCommentId;
    if (!id || !chunk) return Promise.resolve({ ok: true, skipped: true });
    chain = chain
      .then(() => postFn({ agentCommentId: id, chunk, ...opts.postOpts }))
      .catch((e) => ({ ok: false, detail: String(e?.message || e).slice(0, 300) }));
    return chain;
  };

  return {
    /**
     * @param {string} id
     * @param {string} chunk
     */
    push(id, chunk) {
      const nextId = String(id || '').trim();
      const t = String(chunk ?? '');
      if (!nextId || !t) return Promise.resolve({ ok: true, skipped: true });
      if (agentCommentId && agentCommentId !== nextId) {
        void flush();
      }
      agentCommentId = nextId;
      buf += t;
      if (buf.length >= maxChars) return flush();
      if (!timer) {
        timer = setTimeout(() => {
          void flush();
        }, flushMs);
      }
      return Promise.resolve({ ok: true, buffered: true });
    },
    flush,
  };
}
