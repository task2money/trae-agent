import express from 'express';
import multer from 'multer';

import { authMiddleware, setTokenBootstrapFailed } from './auth.mjs';
import { rememberStaleAccessToken } from './uiAccessToken.mjs';
import { createScopedTaskApiRewriteMiddleware } from './scopedTaskApiPath.mjs';
import { ssePingLoop, broadcast } from './sseHub.mjs';
import {
  runBootstrapTokenExchangeOnly,
  runBootstrapAfterListen,
  bootstrapCloneLayerId,
  bootstrapRegisterCloneJob,
  ensureStartupEmptyLayer,
  lastBootstrapTaskDetail,
} from './bootstrap.mjs';
import { detailHasAtMentionRun } from './atMentionOrchestration.mjs';
import { runPostBootstrapAgentKickoff } from './postBootstrapAgentKickoff.mjs';
import { registerReachabilityAfterBootstrap } from './reachability.mjs';
import {
  startSaasContainerHeartbeatLoop,
  startSaasLayerGraphPushLoop,
} from './saasTaskCloud.mjs';
import { startProactiveAccessRefreshLoop } from './proactiveAccessRefresh.mjs';
import {
  createJob,
  registerBootstrapCloneJob,
  buildLayersSnapshot,
  mirrorLayerGraphToTaskCloudSSE,
  sweepDanglingLayerDirs,
} from './jobsRuntime.mjs';
import { appendInitLogBestEffort } from './initLog.mjs';
import { logJson } from './jsonLog.mjs';
import { initOtel } from './otel.mjs';

import { traceMiddleware } from './httpTraceMiddleware.mjs';
import {
  createDebugAgentInboundLoggerMiddleware as createDebugAgentInboundLoggerMiddlewareImpl,
} from './createDebugAgentInboundLogger.mjs';
import { registerServerAccessLogMiddleware } from './serverAccessLog.mjs';
import { registerUiRoutes, registerSessionUiRedirectRoute } from './uiHtmlRoutes.mjs';
import { registerConfigJobsRoutes } from './routesConfigJobs.mjs';
import { registerReposCloneRoutes } from './routesReposClone.mjs';
import { registerLayersFsRoutes } from './routesLayersFs.mjs';
import { registerLayerGitRoutes } from './routesLayerGit.mjs';
import { registerDiffLogMiscRoutes } from './routesDiffLogMisc.mjs';

export function createDebugAgentInboundLoggerMiddleware(deps) {
  return createDebugAgentInboundLoggerMiddlewareImpl(deps);
}

function errorLogFields(e) {
  const detail = String(e?.message || e);
  const fields = { detail: detail.slice(0, 2000) };
  if (e?.stack) fields.stack = String(e.stack).slice(0, 4000);
  if (e?.structuredPayload && typeof e.structuredPayload === 'object') {
    fields.structured = e.structuredPayload;
  }
  return fields;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
app.use(traceMiddleware);
app.use(createScopedTaskApiRewriteMiddleware());
app.use(express.json({ limit: '20mb' }));
app.use(createDebugAgentInboundLoggerMiddleware());
registerServerAccessLogMiddleware(app);
registerUiRoutes(app);

const api = express.Router();
api.use(authMiddleware);
registerSessionUiRedirectRoute(app);

registerConfigJobsRoutes(api, { upload });
registerReposCloneRoutes(api);
registerLayersFsRoutes(api);
registerLayerGitRoutes(api);
registerDiffLogMiscRoutes(api);

app.use('/api', api);

/** 测试/本地：预置换票前旧 token，便于 Playwright 验证 /ui 302 与 session/ui-redirect。 */
for (const t of String(process.env.TRAE_UI_STALE_ACCESS_TOKENS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)) {
  rememberStaleAccessToken(t);
}

const port = parseInt(process.env.PORT || '8765', 10);
const host = '0.0.0.0';

/**
 * Bind PORT immediately so host-network startups cannot lose the port during
 * the await window of token exchange (otherwise another process / orphan race
 * yields listen EADDRINUSE after exchange-refresh succeeds).
 */
/**
 * OPT-024: 端口桥接行为说明：
 * - host 网络（`--network host`）：容器内全部端口（含后续 runAll 启动的子服务）直接暴露在宿主机上，
 *   但安全组/防火墙仍可能阻止外部访问。127.0.0.1 可达不代表宿主机/公网可达。
 * - bridge 网络 + `-p`：仅声明 `-p hostPort:containerPort` 的端口映射到宿主机。
 *   onlineServiceJS 默认 8765 由 Dockerfile / run.sh 映射；子服务（9999 runAll 等）默认不映射。
 * - 从物理机访问容器内 8003/8004/9999 等端口若失败，应先检查：
 *   1. 容器进程是否监听（`docker exec <容器> ss -tlnp`）
 *   2. Docker 网络模式与端口映射（`docker inspect <容器> | jq '.[].HostConfig'`）
 *   3. 宿主机安全组/iptables
 * - 任务前端 UI 的「诊断端口可达性」按钮通过容器内 127.0.0.1 探测端口，仅反映容器内可达性。
 */
function listenHttpServer() {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`[onlineServiceJS] server listening on http://${host}:${port}`);
      resolve(server);
    });
    server.on('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        console.error(`[onlineServiceJS] port ${port} already in use (${err.message})`);
      }
      reject(err);
    });
  });
}

export async function main({
  appendInitLog = appendInitLogBestEffort,
  runBootstrapTokenExchangeOnlyFn = runBootstrapTokenExchangeOnly,
  startSsePingLoop = ssePingLoop,
  stopAfterBootstrapTokenExchangeOnly = false,
} = {}) {
  const shutdownOtel = initOtel('onlineServiceJS');
  process.on('beforeExit', () => {
    void shutdownOtel();
  });
  startSsePingLoop();
  try {
    const initLogResult = appendInitLog({
      pid: process.pid,
      port: String(port),
      envMapping: process.env,
      rawPolicy: process.env.INIT_LOG_ENV_KEYS,
    });
    if (initLogResult && initLogResult.ok === false) {
      console.error('[onlineServiceJS] init.log append error:', initLogResult.error);
    }
  } catch (e) {
    console.error('[onlineServiceJS] init.log append error:', e);
  }
  const strict = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.TASK_API_BOOTSTRAP_STRICT_STARTUP || '').toLowerCase(),
  );

  // Token-only test hook: do not bind PORT.
  if (stopAfterBootstrapTokenExchangeOnly) {
    try {
      await runBootstrapTokenExchangeOnlyFn();
    } catch (e) {
      console.error('[onlineServiceJS] bootstrap (token) error:', e);
      if (strict) process.exit(1);
      const reason = String(e?.message || e || 'token exchange failed').slice(0, 500);
      setTokenBootstrapFailed(true, reason);
      console.error(
        `[onlineServiceJS] TOKEN_BOOTSTRAP_FAILED fail-closed: protected routes return 503 (${reason.slice(0, 200)})`,
      );
    }
    return;
  }

  // Claim host PORT before any long await (token exchange).
  const server = await listenHttpServer();
  const shutdownForWatch = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once('SIGTERM', shutdownForWatch);
  process.once('SIGINT', shutdownForWatch);

  let bootstrapCtx;
  try {
    bootstrapCtx = await runBootstrapTokenExchangeOnlyFn();
  } catch (e) {
    console.error('[onlineServiceJS] bootstrap (token) error:', e);
    if (strict) process.exit(1);
    // 非 strict：不得带着无效 ACCESS_TOKEN 继续对外提供受保护 API（fail-closed）。
    // intentional skip（无 TaskApi 前缀）走正常返回 { skipped: true }，不进本分支。
    const reason = String(e?.message || e || 'token exchange failed').slice(0, 500);
    setTokenBootstrapFailed(true, reason);
    console.error(
      `[onlineServiceJS] TOKEN_BOOTSTRAP_FAILED fail-closed: protected routes return 503 (${reason.slice(0, 200)})`,
    );
    bootstrapCtx = { skipped: true, tokenExchangeFailed: true };
  }
  ensureStartupEmptyLayer();
  try {
    sweepDanglingLayerDirs();
  } catch (e) {
    console.error('[onlineServiceJS] layer dir sweep error:', e);
  }

  broadcast({ type: 'service_ready', port });
  // register-reachability（server_url）与 SaaS 心跳须在 HTTP 已监听后立即执行，不得被引导克隆/写 YAML 阻塞。
  // tokenExchangeFailed 时 ctx.skipped=true，本函数会 no-op，不会用无效 token 注册。
  try {
    await registerReachabilityAfterBootstrap(bootstrapCtx);
  } catch (e) {
    logJson('error', 'reachability_failed', {
      use_startup_trace: true,
      ...errorLogFields(e),
    });
    process.exit(1);
  }
  if (!bootstrapCtx.skipped && bootstrapCtx.prefix) {
    startSaasContainerHeartbeatLoop();
    const hbDelay = String(process.env.TRAE_SAAS_HEARTBEAT_INITIAL_DELAY_SEC || '5').trim();
    console.log(
      `[onlineServiceJS] 已调度 SaaS 容器心跳（首跳延迟 ${hbDelay}s，间隔见 TRAE_SAAS_HEARTBEAT_INTERVAL_SEC）`,
    );
    startProactiveAccessRefreshLoop();
    console.log(
      '[onlineServiceJS] 已调度 access 主动续签（skew 见 TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC，默认 5m）',
    );
    startSaasLayerGraphPushLoop(() => buildLayersSnapshot(bootstrapCloneLayerId));
    const lgDelay = String(process.env.TRAE_SAAS_LAYER_GRAPH_PUSH_INITIAL_DELAY_SEC || '8').trim();
    console.log(
      `[onlineServiceJS] 已调度 SaaS 层图推送（首跳延迟 ${lgDelay}s，间隔见 TRAE_SAAS_LAYER_GRAPH_PUSH_INTERVAL_SEC）`,
    );
  }
  if (bootstrapCtx.tokenExchangeFailed) {
    console.error(
      '[onlineServiceJS] skip post-listen bootstrap (token exchange failed, fail-closed)',
    );
    return;
  }
  try {
    await runBootstrapAfterListen(bootstrapCtx);
    try {
      if (bootstrapCloneLayerId && bootstrapRegisterCloneJob) {
        registerBootstrapCloneJob(bootstrapCloneLayerId);
      }
    } catch (e) {
      console.error('[onlineServiceJS] bootstrap clone job 注册错误:', e);
      if (strict) process.exit(1);
    }
    try {
      // at_mention（合法 ContextPack）优先，否则 auto_run；与凭证恢复成功路径共用
      await runPostBootstrapAgentKickoff({
        detail: lastBootstrapTaskDetail,
        layerId: bootstrapCloneLayerId,
        createJobFn: createJob,
      });
    } catch (e) {
      const label = detailHasAtMentionRun(lastBootstrapTaskDetail)
        ? 'AT_MENTION_JOB_FAILED'
        : 'AUTO_RUN_FIRST_INSTRUCTION_FAILED';
      console.error(
        `[onlineServiceJS] ${label} ${String(e?.message || e).slice(0, 500)}`,
      );
      // 不阻断主服务；失败可在详情页手动重试
    }
    try {
      await mirrorLayerGraphToTaskCloudSSE();
    } catch {
      /* 推层图至任务云为辅助通道，失败不阻断服务 */
    }
  } catch (e) {
    const msg = String(e?.message || e || 'bootstrap failed').slice(0, 800);
    if (!msg.includes('BOOTSTRAP_FAILED')) {
      console.error(`[onlineServiceJS] BOOTSTRAP_FAILED phase=post_listen ${msg}`);
    }
    console.error('[onlineServiceJS] bootstrap (post-listen) error:', e);
    if (strict) process.exit(1);
  }
}

if (process.env.ONLINE_SERVICE_JS_SKIP_MAIN !== '1') {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
