/**
 * 上报克隆进度到 SaaS `git-clone-progress`；同仓请求串行，避免 100% 被迟到的 9% 覆盖。
 */
import { postJson } from './saasPostJson.mjs';

/**
 * 与 `GET /api/repos/bootstrap-clone-log` 的 `segments[].repo_url` 及 SaaS SSE `segment` 对齐。
 * @param {string|null} repoUrl
 * @param {null|{ kind?: 'repo'|'global', index?: number, total?: number, phase?: string, label?: string, repo_url?: string, recv_progress?: number, unpack_progress?: number }} [segmentExtra]
 */
function buildGitCloneProgressSegment(repoUrl, segmentExtra) {
  const ru = String(repoUrl || '').trim();
  const ex = segmentExtra && typeof segmentExtra === 'object' ? segmentExtra : null;
  const seg = {};
  if (ru) {
    seg.kind = 'repo';
    seg.repo_url = ru.slice(0, 2000);
  } else {
    const fallbackRu = ex && String(ex.repo_url || '').trim();
    if (ex && ex.kind === 'repo' && fallbackRu) {
      seg.kind = 'repo';
      seg.repo_url = fallbackRu.slice(0, 2000);
    } else {
      seg.kind = 'global';
    }
  }
  if (ex) {
    if (typeof ex.index === 'number' && Number.isFinite(ex.index)) {
      seg.index = Math.max(1, Math.floor(ex.index));
    }
    if (typeof ex.total === 'number' && Number.isFinite(ex.total)) {
      seg.total = Math.max(1, Math.floor(ex.total));
    }
    if (typeof ex.phase === 'string' && ex.phase.trim()) {
      seg.phase = ex.phase.trim().slice(0, 48);
    }
    if (typeof ex.label === 'string' && ex.label.trim()) {
      seg.label = ex.label.trim().slice(0, 200);
    }
    for (const k of ['recv_progress', 'unpack_progress']) {
      const n = ex[k];
      if (typeof n === 'number' && Number.isFinite(n)) {
        seg[k] = Math.max(0, Math.min(100, Math.floor(n)));
      }
    }
  }
  return seg;
}

let cloneProgressSendChains = new Map();

function cloneProgressChainKey(repoUrl) {
  const ru = String(repoUrl || '').trim();
  return ru || '__global__';
}

/** 测试用：重置进度上报串行链。 */
export function resetCloneProgressSendChainForTests() {
  cloneProgressSendChains = new Map();
}

/**
 * @param {string|null} repoUrl
 * @param {null|{ kind?: 'repo'|'global', index?: number, total?: number, phase?: string, label?: string }} [segmentExtra]
 */
export async function postCloneProgress(cloudPrefix, accessToken, progress, message, repoUrl = null, segmentExtra = null) {
  if (!cloudPrefix || !accessToken) return;
  const url = `${cloudPrefix.replace(/\/$/, '')}/server-container-token/git-clone-progress/`;
  const body = {
    access_token: accessToken,
    progress: Math.max(0, Math.min(100, progress)),
    message: String(message || '').slice(0, 2000),
  };
  const ru = String(repoUrl || '').trim();
  if (ru) body.repo_url = ru.slice(0, 2000);
  const segment = buildGitCloneProgressSegment(ru, segmentExtra);
  if (segment && Object.keys(segment).length) {
    body.segment = segment;
  }
  const send = () => postJson(url, body, 10);
  const chainKey = cloneProgressChainKey(ru);
  const prev = cloneProgressSendChains.get(chainKey) || Promise.resolve();
  const p = prev.then(send, send);
  cloneProgressSendChains.set(chainKey, p.catch(() => {}));
  try {
    await p;
  } catch {
    /* optional */
  }
}
