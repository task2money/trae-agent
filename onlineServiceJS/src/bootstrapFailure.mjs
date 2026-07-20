import { appendOutboundReqLog } from './outboundReqLog.mjs';
import { lastBootstrapFailure, setLastBootstrapFailure } from './bootstrapState.mjs';

function parseStructuredPayloadFromErrorMessage(errLike) {
  const raw = String(errLike?.message || errLike || '').trim();
  if (!raw) return null;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '{') continue;
    const jsonPart = raw.slice(i);
    try {
      const parsed = JSON.parse(jsonPart);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* continue scanning */
    }
  }
  return null;
}

export function bootstrapStructuredPayload(errLike) {
  const direct = errLike && typeof errLike === 'object' ? errLike.structuredPayload : null;
  if (direct && typeof direct === 'object') return direct;
  return parseStructuredPayloadFromErrorMessage(errLike);
}

export function summarizeMissingRepoCredentials(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const rows = Array.isArray(payload.missing_repo_credentials) ? payload.missing_repo_credentials : [];
  const out = [];
  for (const raw of rows) {
    const s = String(raw || '').trim();
    if (s) out.push(s);
  }
  return out;
}

export function buildRepoCloneCredentialsBootstrapError(errLike) {
  const payload = bootstrapStructuredPayload(errLike);
  const code = String(payload?.error_code || '').trim();
  if (code !== 'REPO_CLONE_CREDENTIALS_INCOMPLETE') {
    return errLike instanceof Error
      ? errLike
      : new Error(String(errLike || 'repo-clone-credentials failed'));
  }
  const detail = String(payload?.detail || '').trim();
  const missing = summarizeMissingRepoCredentials(payload);
  const missingBrief = missing.length
    ? ` 缺失仓库(${missing.length}): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' ...' : ''}`
    : '';
  const msg = `repo-clone-credentials 未返回完整 repo_clone_credentials；请在任务详情为全部仓库绑定 Git 授权后重试。${missingBrief}${detail ? ` detail=${detail}` : ''}`;
  const wrapped = new Error(msg);
  if (payload && typeof payload === 'object') {
    wrapped.structuredPayload = payload;
  }
  return wrapped;
}

export function buildTaskDetailBootstrapError(errLike) {
  return buildRepoCloneCredentialsBootstrapError(errLike);
}

/** 是否为「仓库 Git 授权未齐」类 409（可退避重试，常见于容器启动早于用户绑定）。 */
export function isRepoCloneCredentialsIncompleteError(errLike) {
  const payload = bootstrapStructuredPayload(errLike);
  if (String(payload?.error_code || '').trim() === 'REPO_CLONE_CREDENTIALS_INCOMPLETE') {
    return true;
  }
  const msg = String(errLike?.message || errLike || '');
  return /HTTP\s+409\b/i.test(msg) && /REPO_CLONE_CREDENTIALS_INCOMPLETE/i.test(msg);
}

/**
 * repo-clone-credentials 409 重试配置。
 * - TASK_API_REPO_CLONE_CREDENTIALS_RETRIES：含首轮，默认 8，上限 30
 * - TASK_API_REPO_CLONE_CREDENTIALS_BACKOFF_MS：基数毫秒，默认 5000；实际等待 = min(120s, backoff*attempt)
 */
export function repoCloneCredentialsRetryConfigFromEnv() {
  const retriesRaw = parseInt(String(process.env.TASK_API_REPO_CLONE_CREDENTIALS_RETRIES || '8'), 10);
  const backoffRaw = parseInt(
    String(process.env.TASK_API_REPO_CLONE_CREDENTIALS_BACKOFF_MS || '5000'),
    10,
  );
  const maxAttempts = Number.isFinite(retriesRaw) ? Math.max(1, Math.min(30, retriesRaw)) : 8;
  const backoffMs = Number.isFinite(backoffRaw) ? Math.max(0, Math.min(120000, backoffRaw)) : 5000;
  return { maxAttempts, backoffMs };
}

export function getLastBootstrapFailure() {
  return lastBootstrapFailure;
}

export function clearLastBootstrapFailure() {
  setLastBootstrapFailure(null);
}

/**
 * @param {{ phase: string, code?: string, message: string, missing_repo_credentials?: string[] }} failure
 */
export function noteBootstrapFailure(failure) {
  const phase = String(failure?.phase || 'unknown').trim() || 'unknown';
  const message = String(failure?.message || '').trim() || 'bootstrap failed';
  const code = String(failure?.code || '').trim();
  const missing = Array.isArray(failure?.missing_repo_credentials)
    ? failure.missing_repo_credentials.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  setLastBootstrapFailure({
    phase,
    code,
    message,
    at: new Date().toISOString(),
    ...(missing.length ? { missing_repo_credentials: missing } : {}),
  });
  appendOutboundReqLog(
    `bootstrap failure recorded phase=${phase} code=${code || '-'} msg=${message.slice(0, 240)}`,
  );
}

/** 供 GET /api/repos/bootstrap-clone-log：无 layer 日志时仍返回失败摘要。 */
export function bootstrapCloneLogFailurePayload() {
  const f = lastBootstrapFailure;
  if (!f) return null;
  const lines = [
    `【项目克隆】引导失败（phase=${f.phase}${f.code ? ` code=${f.code}` : ''}）。`,
    f.message,
  ];
  if (Array.isArray(f.missing_repo_credentials) && f.missing_repo_credentials.length) {
    lines.push(`缺失凭证仓库（${f.missing_repo_credentials.length}）：`);
    for (const u of f.missing_repo_credentials.slice(0, 20)) {
      lines.push(`- ${u}`);
    }
  }
  if (f.at) lines.push(`记录时间：${f.at}`);
  return {
    text: `${lines.join('\n')}\n`,
    error_code: f.code || undefined,
    phase: f.phase,
    at: f.at,
    missing_repo_credentials: f.missing_repo_credentials,
  };
}
