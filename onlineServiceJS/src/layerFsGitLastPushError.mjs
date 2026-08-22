/**
 * 层目录持久化最近一次 git push 失败，供层快照 git_remote.last_push_error 回放给 zTree。
 */
import fs from 'fs';
import path from 'path';
import { LAYER_ID_RE, layerPath } from './layerFs.mjs';

const DETAIL_MAX = 800;

function gitLastPushErrorPath(layerId) {
  return path.join(layerPath(layerId), 'git_last_push_error.json');
}

function sanitizeDetail(raw) {
  return String(raw || '').trim().slice(0, DETAIL_MAX);
}

function sanitizeTraceId(raw) {
  return String(raw || '').trim().slice(0, 128);
}

/**
 * @param {string} layerId
 * @param {string} detail
 * @param {{ traceId?: string }} [opts]
 * @returns {boolean}
 */
export function rememberLayerLastPushError(layerId, detail, opts = {}) {
  const lid = String(layerId || '').trim();
  const text = sanitizeDetail(detail);
  if (!lid || !LAYER_ID_RE.test(lid) || !text) return false;
  const root = layerPath(lid);
  if (!fs.existsSync(root)) return false;
  const payload = {
    detail: text,
    at: new Date().toISOString(),
    trace_id: sanitizeTraceId(opts.traceId),
  };
  fs.writeFileSync(gitLastPushErrorPath(lid), `${JSON.stringify(payload)}\n`, 'utf8');
  return true;
}

/**
 * @param {string} layerId
 * @returns {boolean}
 */
export function clearLayerLastPushError(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid || !LAYER_ID_RE.test(lid)) return false;
  const p = gitLastPushErrorPath(lid);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} layerId
 * @returns {{ detail: string, trace_id: string, at: string }}
 */
export function readLayerLastPushError(layerId) {
  const empty = { detail: '', trace_id: '', at: '' };
  const lid = String(layerId || '').trim();
  if (!lid || !LAYER_ID_RE.test(lid)) return empty;
  const p = gitLastPushErrorPath(lid);
  if (!fs.existsSync(p)) return empty;
  try {
    const raw = String(fs.readFileSync(p, 'utf8') || '').trim();
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      detail: sanitizeDetail(parsed.detail),
      trace_id: sanitizeTraceId(parsed.trace_id),
      at: String(parsed.at || '').trim(),
    };
  } catch {
    return empty;
  }
}

/**
 * @param {object} snap
 * @param {string} layerId
 */
export function withRememberedLastPushError(snap, layerId) {
  if (!snap || typeof snap !== 'object') return snap;
  const err = readLayerLastPushError(layerId);
  if (!err.detail) return snap;
  const out = { ...snap, last_push_error: err.detail };
  if (err.trace_id) out.last_push_error_trace_id = err.trace_id;
  return out;
}
