import { postJson } from './saasTaskCloud.mjs';
import { collectRepoBranchPlans } from './bootstrapWorkBranch.mjs';
import { collectRepoCloneJobs } from './bootstrapRepoCredentials.mjs';
import {
  bootstrapStructuredPayload,
  buildRepoCloneCredentialsBootstrapError,
  isRepoCloneCredentialsIncompleteError,
  noteBootstrapFailure,
  repoCloneCredentialsRetryConfigFromEnv,
  summarizeMissingRepoCredentials,
} from './bootstrapFailure.mjs';
import { appendOutboundReqLog } from './outboundReqLog.mjs';

export async function sleepMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function bootstrapSaasStaggerMs() {
  const raw = String(process.env.TASK_API_BOOTSTRAP_SAAS_STAGGER_MS || '200').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

/** 启动风暴缓解：连续 SaaS inbound 请求之间插入短间隔，降低 SQLite 写重叠概率。 */
export async function staggerBootstrapSaasCall() {
  const ms = bootstrapSaasStaggerMs();
  if (ms > 0) await sleepMs(ms);
}

export function isAbortError(e) {
  const name = String(e?.name || '').trim();
  const msg = String(e?.message || e || '');
  return name === 'AbortError' || /aborted/i.test(msg);
}

export async function postJsonWithAbortRetry(url, body, timeoutSec, tag, logRetry) {
  const maxAttempts = Math.max(1, parseInt(String(process.env.TASK_API_TOKEN_EXCHANGE_RETRIES || '2'), 10) || 2);
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1 && typeof logRetry === 'function') {
        logRetry(`${tag}: retry attempt=${attempt}/${maxAttempts} timeout_sec=${timeoutSec}`);
      }
      return await postJson(url, body, timeoutSec);
    } catch (e) {
      lastErr = e;
      if (!isAbortError(e) || attempt >= maxAttempts) {
        throw e;
      }
      await sleepMs(600 * attempt);
    }
  }
  throw lastErr || new Error(`${tag}: request failed`);
}

export async function postRepoCloneCredentialsWithRetry(prefix, accessToken, timeoutSec) {
  const { maxAttempts, backoffMs } = repoCloneCredentialsRetryConfigFromEnv();
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(
          `[onlineServiceJS] 重试拉取仓库克隆凭证（${attempt}/${maxAttempts}）…`,
        );
        appendOutboundReqLog(
          `bootstrap: repo-clone-credentials retry attempt=${attempt}/${maxAttempts}`,
        );
      } else {
        appendOutboundReqLog('bootstrap post-listen: repo-clone-credentials');
        console.log('[onlineServiceJS] 开始拉取仓库克隆凭证…');
      }
      await staggerBootstrapSaasCall();
      return await postJson(
        `${prefix}/server-container-token/repo-clone-credentials/`,
        { access_token: accessToken },
        timeoutSec,
      );
    } catch (e) {
      lastErr = e;
      if (!isRepoCloneCredentialsIncompleteError(e) || attempt >= maxAttempts) {
        throw e;
      }
      const payload = bootstrapStructuredPayload(e);
      const missing = summarizeMissingRepoCredentials(payload);
      const waitMs = Math.min(120000, backoffMs * attempt);
      console.warn(
        `[onlineServiceJS] REPO_CLONE_CREDENTIALS_INCOMPLETE attempt=${attempt}/${maxAttempts} wait_ms=${waitMs}` +
          (missing.length ? ` missing=${missing.slice(0, 5).join(',')}` : ''),
      );
      appendOutboundReqLog(
        `bootstrap: repo-clone-credentials incomplete attempt=${attempt}/${maxAttempts} wait_ms=${waitMs}` +
          (missing.length ? ` missing=${missing.slice(0, 5).join(',')}` : ''),
      );
      noteBootstrapFailure({
        phase: 'task_detail_or_credentials',
        code: 'REPO_CLONE_CREDENTIALS_INCOMPLETE',
        message: String(
          buildRepoCloneCredentialsBootstrapError(e)?.message || e?.message || e,
        ).slice(0, 800),
        missing_repo_credentials: missing,
      });
      if (waitMs > 0) await sleepMs(waitMs);
    }
  }
  throw lastErr || new Error('repo-clone-credentials failed');
}

export async function fetchBootstrapRepoInputs(prefix, accessToken, timeoutSec) {
  const detail = await postJson(
    `${prefix}/server-container-token/task-detail/`,
    { access_token: accessToken },
    timeoutSec
  );
  const cloneJobs = collectRepoCloneJobs(detail);
  const urls = cloneJobs.map((j) => j.url);
  const branchPlans = collectRepoBranchPlans(detail);
  console.log(
    `[onlineServiceJS] 任务详情已拉取（关联仓库 ${urls.length} 个，工作分支=${branchPlans.sharedWorkBranch || '(未配置)'}），继续引导…`,
  );
  if (!urls.length) {
    return { urls, cloneJobs, credRoot: {}, detail, branchPlans };
  }
  const credResp = await postRepoCloneCredentialsWithRetry(prefix, accessToken, timeoutSec);
  const credRoot =
    credResp && typeof credResp.repo_clone_credentials === 'object'
      ? credResp.repo_clone_credentials
      : {};
  return { urls, cloneJobs, credRoot, detail, branchPlans };
}
