import { postJson } from './saasTaskCloud.mjs';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import {
  setBootstrapCloneLayerId,
  setBootstrapRegisterCloneJob,
  setLastBootstrapTaskDetail,
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
