import fs from 'fs';
import path from 'path';
import { postJson } from './saasTaskCloud.mjs';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import {
  setBootstrapCloneLayerId,
  setBootstrapRegisterCloneJob,
  setLastBootstrapTaskDetail,
  bootstrapCloneLayerId,
  lastBootstrapTaskDetail,
} from './bootstrapState.mjs';
import {
  bootstrapStructuredPayload,
  buildRepoCloneCredentialsBootstrapError,
  clearLastBootstrapFailure,
  isRepoCloneCredentialsIncompleteError,
  noteBootstrapFailure,
  summarizeMissingRepoCredentials,
} from './bootstrapFailure.mjs';
import {
  cloneReposIntoSharedLayer,
  createInitialWorkspaceLayer,
} from './bootstrapCloneLayer.mjs';
import {
  fetchBootstrapRepoInputs,
  staggerBootstrapSaasCall,
} from './bootstrapRepoInputs.mjs';
import {
  scheduleBootstrapCredentialsRecovery,
  stopBootstrapCredentialsRecovery,
} from './bootstrapCredentialsRecovery.mjs';
import { persistFeatureParamsEnv } from './bootstrapFeatureParamsPersist.mjs';
import { runBootstrapTokenExchangeOnly } from './bootstrapTokenExchange.mjs';
import { ensureStartupEmptyLayer } from './bootstrapStartupEmptyLayer.mjs';
import { emitRuntimeEvent } from './runtimeEventLog.mjs';
import { layerPath, layerGitWorkdirRootsForFileListing } from './layerFs.mjs';
import {
  repoMatchKeyFromUrl,
  gitConfigGetSync,
  gitExec,
} from './layerGitRouteHelpers.mjs';

/**
 * 克隆完成后自动将任务配置的各仓库所选 Git 身份写入 git config --local。
 * 读取 lastBootstrapTaskDetail.parameters.repo_clone_git_identity_details，
 * 按 repo_match_key 匹配克隆层内各 Git 工作区。
 */
export async function applyBootstrapCloneGitIdentities() {
  const detail = lastBootstrapTaskDetail;
  if (!detail) return;
  const params = detail?.parameters;
  if (!params || typeof params !== 'object') return;
  const identityDetails = params.repo_clone_git_identity_details;
  if (!identityDetails || typeof identityDetails !== 'object' || !Object.keys(identityDetails).length) {
    return;
  }

  const layerId = bootstrapCloneLayerId;
  if (!layerId) return;

  const root = layerPath(layerId);
  if (!fs.existsSync(root)) return;

  const roots = layerGitWorkdirRootsForFileListing(layerId);
  if (!roots.length) return;

  let applied = 0;
  const byKeyLower = {};
  for (const [k, v] of Object.entries(identityDetails)) {
    byKeyLower[String(k).toLowerCase()] = v;
  }

  for (const { workdir } of roots) {
    const dotGit = path.join(workdir, '.git');
    if (!fs.existsSync(dotGit)) continue;

    let originUrl = '';
    try {
      originUrl = gitConfigGetSync(['config', '--get', 'remote.origin.url'], workdir);
    } catch {
      /* ignore — not a git workdir or no remote */
    }
    if (!originUrl) continue;

    const key = repoMatchKeyFromUrl(originUrl).toLowerCase();
    if (!key) continue;

    const spec = byKeyLower[key];
    if (!spec || !spec.user_name || !spec.user_email) continue;

    try {
      await gitExec(['config', '--local', 'user.name', spec.user_name], workdir);
      await gitExec(['config', '--local', 'user.email', spec.user_email], workdir);
      applied += 1;
      console.log(
        `[onlineServiceJS] BOOTSTRAP git identity auto-applied: key=${key} name=${spec.user_name} email=${spec.user_email}`,
      );
    } catch (e) {
      console.warn(
        `[onlineServiceJS] BOOTSTRAP git identity sync failed: key=${key} err=${String(e?.message || e)}`,
      );
    }
  }

  if (applied > 0) {
    appendOutboundReqLog(`bootstrap: git identities auto-synced count=${applied}`);
  }
}

/**
 * 容器已监听端口后：拉取任务详情 → 克隆关联仓库 → 拉取并写入 feature YAML。
 */
export async function runBootstrapAfterListen(ctx) {
  if (!ctx || ctx.skipped) {
    appendOutboundReqLog('bootstrap post-listen: skip (no task API prefix)');
    return;
  }
  const { prefix, newAccess, timeout } = ctx;
  const fromRecovery = Boolean(ctx._fromCredentialsRecovery);
  const timeoutSec = timeout;

  // 稳定标记供前端启动日志检索；勿改前缀，面板会高亮 BOOTSTRAP_* 行。
  emitRuntimeEvent('BOOTSTRAP_PHASE', {
    phase: 'task_detail_begin',
    message: '容器已启动，开始拉取任务详情…',
    consoleLine: '[onlineServiceJS] BOOTSTRAP_PHASE=task_detail_begin 容器已启动，开始拉取任务详情…',
  });
  appendOutboundReqLog('bootstrap post-listen: task-detail');

  let urls = [];
  let cloneJobs = [];
  let credRoot = {};
  let branchPlans = { sharedWorkBranch: '', byUrl: new Map() };
  try {
    const repoInputs = await fetchBootstrapRepoInputs(prefix, newAccess, timeoutSec);
    urls = repoInputs.urls;
    cloneJobs = repoInputs.cloneJobs || urls.map((u) => ({ url: u, cloneAlias: '', parentRepoUrl: '' }));
    credRoot = repoInputs.credRoot;
    branchPlans = repoInputs.branchPlans || branchPlans;
    setLastBootstrapTaskDetail(repoInputs.detail || null);
  } catch (e) {
    const wrapped =
      String(e?.message || '').includes('/server-container-token/repo-clone-credentials/')
      || String(e?.message || '').includes('REPO_CLONE_CREDENTIALS_INCOMPLETE')
      || isRepoCloneCredentialsIncompleteError(e)
        ? buildRepoCloneCredentialsBootstrapError(e)
        : e instanceof Error
          ? e
          : new Error(String(e || 'task-detail failed'));
    const payload = bootstrapStructuredPayload(wrapped) || bootstrapStructuredPayload(e);
    noteBootstrapFailure({
      phase: 'task_detail_or_credentials',
      code: String(payload?.error_code || '').trim() ||
        (isRepoCloneCredentialsIncompleteError(e) ? 'REPO_CLONE_CREDENTIALS_INCOMPLETE' : ''),
      message: String(wrapped?.message || wrapped).slice(0, 800),
      missing_repo_credentials: summarizeMissingRepoCredentials(payload),
    });
    const failMsg = String(wrapped?.message || wrapped).slice(0, 500);
    emitRuntimeEvent('BOOTSTRAP_FAILED', {
      level: 'error',
      phase: 'task_detail_or_credentials',
      message: failMsg,
      consoleLine: `[onlineServiceJS] BOOTSTRAP_FAILED phase=task_detail_or_credentials ${failMsg}`,
    });
    if (!fromRecovery && isRepoCloneCredentialsIncompleteError(e)) {
      scheduleBootstrapCredentialsRecovery({ prefix, newAccess, timeout, skipped: false });
    }
    throw wrapped;
  }
  if (urls.length) {
    emitRuntimeEvent('BOOTSTRAP_PHASE', {
      phase: 'clone_begin',
      message: '任务详情已就绪，开始项目克隆…',
      consoleLine: '[onlineServiceJS] BOOTSTRAP_PHASE=clone_begin 任务详情已就绪，开始项目克隆…',
    });
    try {
      setBootstrapCloneLayerId(
        await cloneReposIntoSharedLayer(
          cloneJobs,
          credRoot,
          prefix,
          newAccess,
          branchPlans,
        ),
      );
      // 克隆完成后自动将任务配置的各仓库所选 Git 身份写入 git config
      await applyBootstrapCloneGitIdentities();
    } catch (e) {
      noteBootstrapFailure({
        phase: 'clone',
        code: '',
        message: String(e?.message || e).slice(0, 800),
      });
      const failMsg = String(e?.message || e).slice(0, 500);
      emitRuntimeEvent('BOOTSTRAP_FAILED', {
        level: 'error',
        phase: 'clone',
        message: failMsg,
        consoleLine: `[onlineServiceJS] BOOTSTRAP_FAILED phase=clone ${failMsg}`,
      });
      throw e;
    }
    setBootstrapRegisterCloneJob(true);
  } else {
    appendOutboundReqLog('bootstrap: no repo urls in task-detail');
    setBootstrapCloneLayerId(createInitialWorkspaceLayer());
    setBootstrapRegisterCloneJob(false);
  }

  await staggerBootstrapSaasCall();
  appendOutboundReqLog('bootstrap post-listen: feature-params-env');
  emitRuntimeEvent('BOOTSTRAP_PHASE', {
    phase: 'feature_params_begin',
    message: '开始拉取 feature-params-env…',
    consoleLine: '[onlineServiceJS] BOOTSTRAP_PHASE=feature_params_begin 开始拉取 feature-params-env…',
  });
  let y;
  try {
    y = await postJson(
      `${prefix}/server-container-token/feature-params-env/`,
      { access_token: newAccess },
      timeoutSec
    );
  } catch (e) {
    noteBootstrapFailure({
      phase: 'feature_params_env',
      code: '',
      message: String(e?.message || e).slice(0, 800),
    });
    const failMsg = String(e?.message || e).slice(0, 500);
    emitRuntimeEvent('BOOTSTRAP_FAILED', {
      level: 'error',
      phase: 'feature_params_env',
      message: failMsg,
      consoleLine: `[onlineServiceJS] BOOTSTRAP_FAILED phase=feature_params_env ${failMsg}`,
    });
    throw e;
  }
  persistFeatureParamsEnv(y.env);
  clearLastBootstrapFailure();
  if (fromRecovery) {
    stopBootstrapCredentialsRecovery();
  }
  emitRuntimeEvent('BOOTSTRAP_COMPLETE', {
    message: '任务引导完成（详情已拉取、克隆与配置已就绪）。',
    consoleLine:
      '[onlineServiceJS] BOOTSTRAP_COMPLETE 任务引导完成（详情已拉取、克隆与配置已就绪）。',
  });
}

/** 顺序执行换票 + 详情/克隆/配置（单测或无需分离 listen 的场景）。 */
export async function runBootstrap() {
  const ctx = await runBootstrapTokenExchangeOnly();
  if (ctx.skipped) return;
  await runBootstrapAfterListen(ctx);
}

export { ensureStartupEmptyLayer, runBootstrapTokenExchangeOnly };

export {
  bootstrapCloneLayerId,
  bootstrapRegisterCloneJob,
  startupEmptyLayerId,
  lastBootstrapTaskDetail,
} from './bootstrapState.mjs';

export {
  appendCloneLayerLog,
  formatBootstrapCloneFailureFooter,
  resolveBootstrapCloneFailurePolicy,
  getBootstrapCloneLogSegmentsForApi,
  getCloneLayerLogText,
  clearCloneLayerLog,
  finalizeCloneLayerLog,
} from './bootstrapCloneLog.mjs';

export {
  collectRepoCloneJobs,
  collectRepoUrls,
  resolveRepoCloneCredential,
  buildHttpAuthFromRepoCredential,
  prepareOauthHttpsGitClone,
  fetchRepoCloneCredentialsOnly,
} from './bootstrapRepoCredentials.mjs';

export {
  planBootstrapCloneJobs,
  cloneReposIntoSharedLayer,
  createInitialWorkspaceLayer,
} from './bootstrapCloneLayer.mjs';

export {
  buildRepoCloneCredentialsBootstrapError,
  buildTaskDetailBootstrapError,
  isRepoCloneCredentialsIncompleteError,
  repoCloneCredentialsRetryConfigFromEnv,
  getLastBootstrapFailure,
  clearLastBootstrapFailure,
  noteBootstrapFailure,
  bootstrapCloneLogFailurePayload,
} from './bootstrapFailure.mjs';

export { scheduleBootstrapCredentialsRecovery } from './bootstrapCredentialsRecovery.mjs';

export { fetchBootstrapRepoInputs } from './bootstrapRepoInputs.mjs';

export {
  PersistedRefreshTokenStoreError,
  isPersistedRefreshTokenStoreError,
  containerRefreshTokenStorePath,
  readPersistedTokenStore,
  readPersistedRefreshToken,
  writePersistedRefreshToken,
  clearPersistedRefreshToken,
  isExchangeRefreshForbiddenError,
  isExchangeRefreshInvalidAccessError,
  isExchangeRefreshFallbackEligibleError,
  formatTokenExchangeFailureLog,
} from './bootstrapTokenStore.mjs';

export { runRefreshAccessOnly } from './bootstrapTokenExchange.mjs';

export {
  applyFeatureParamsEnvToProcess,
  persistFeatureParamsEnv,
} from './bootstrapFeatureParamsPersist.mjs';
