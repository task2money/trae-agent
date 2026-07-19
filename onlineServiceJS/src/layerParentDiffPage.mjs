/**
 * 父层 diff：分页切片与短时缓存（续拉不重扫）。
 */
import fs from 'fs';

/** 变动列表分页：未传 limit 时返回全量（兼容管理页）；传入时按页切片 */
const MAX_DIFF_PAGE_LIMIT = 500;
/** 层 diff 结果缓存 TTL（毫秒）；分页请求直接切片，不重跑全量扫描 */
const DIFF_CACHE_TTL_MS = 30_000;

/**
 * @param {object} payload
 * @param {{ offset?: number|string|null, limit?: number|string|null }} [opts]
 */
export function applyLayerParentDiffPagination(payload, opts = {}) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const all = Array.isArray(base.changes) ? base.changes : [];
  const total = all.length;
  let offset = Math.floor(Number(opts.offset));
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const limRaw = opts.limit;
  const limitProvided = limRaw != null && String(limRaw).trim() !== '';
  let limit = null;
  if (limitProvided) {
    limit = Math.floor(Number(limRaw));
    if (!Number.isFinite(limit) || limit < 1) limit = 1;
    if (limit > MAX_DIFF_PAGE_LIMIT) limit = MAX_DIFF_PAGE_LIMIT;
  }
  const page = limit == null ? all : all.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = limit == null ? false : nextOffset < total;
  return {
    ...base,
    changes: page,
    change_count: total,
    offset,
    next_offset: nextOffset,
    has_more: hasMore,
    truncated: Boolean(base.truncated),
  };
}

/** @type {Map<string, { changes: any[], truncated: boolean, at: number, _fingerprint: string }>} */
const _diffCache = new Map();

function _diffCacheKey(layerId, parentId) {
  return `${layerId}::${parentId}`;
}

function _computeFingerprint(roots) {
  const parts = [];
  for (const r of roots) {
    if (!r.workdir) continue;
    try {
      const st = fs.statSync(r.workdir);
      parts.push(`${r.workdir}:${st.mtimeMs}`);
    } catch {
      /* ignore */
    }
  }
  return parts.join('|');
}

export function diffCacheGet(layerId, parentId, rootsC, rootsP) {
  const key = _diffCacheKey(layerId, parentId);
  const entry = _diffCache.get(key);
  if (!entry) return null;
  const fp = _computeFingerprint([...rootsC, ...rootsP]);
  if (entry._fingerprint !== fp) {
    _diffCache.delete(key);
    return null;
  }
  if (Date.now() - entry.at > DIFF_CACHE_TTL_MS) {
    _diffCache.delete(key);
    return null;
  }
  return entry;
}

export function diffCacheSet(layerId, parentId, changes, truncated, rootsC, rootsP) {
  const key = _diffCacheKey(layerId, parentId);
  _diffCache.set(key, {
    changes,
    truncated,
    at: Date.now(),
    _fingerprint: _computeFingerprint([...rootsC, ...rootsP]),
  });
}
