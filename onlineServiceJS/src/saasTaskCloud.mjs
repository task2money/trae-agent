/**
 * 任务云 TaskApi 前缀、JSON POST，克隆进度上报（git-clone-progress → SaaS SSE），
 * 层级快照上报（layer-graph-push → SSE container_layer_graph，供任务详情 zTree），
 * 以及容器存活心跳（heartbeat/ → SSE container_heartbeat，供任务详情「容器连接」状态）。
 * 供 bootstrap、POST /api/repos/reclone、jobsRuntime、server 启动后定时循环等共用。
 */
import { spawn } from 'child_process';

import { gitCmd } from './gitCmd.mjs';
import {
  buildTaskCloudPrefix,
  parseTenantWorkspaceTaskFromPath,
} from './scopedUiPath.mjs';
import { saasInboundScopeFields } from './saasInboundScope.mjs';
import {
  postJson,
  formatErrorWithCause,
  postJsonTransientRetryConfigFromEnv,
} from './saasPostJson.mjs';
export {
  postJson,
  postJsonTransientRetryConfigFromEnv,
  isTransientHttpStatus,
} from './saasPostJson.mjs';
export {
  parseGitCloneProgressPhases,
  latestGitProgressPercent,
  normalizeGitProgressChunkForLog,
  shouldEmitGitCloneProgressPercent,
} from './saasTaskCloudGitProgress.mjs';
export {
  postCloneProgress,
  resetCloneProgressSendChainForTests,
} from './saasTaskCloudClonePost.mjs';
/** 容器心跳 POST 的 reqLogs 文件名（与其它出站 outbound.log 分离） */
export const HEARTBEAT_REQ_LOG_FILE = 'heartbeat.log';

/** 将 TaskApi URL 中与 DOCKER_GATEWAY_HOSTNAME 一致的主机名换为 DOCKER_HOST_GATEWAY_IP（均在容器 env 中可选配置）。 */
export function rewriteDockerInternal(url) {
  const u = String(url || '').trim();
  if (!u) return u;
  const gatewayHost = String(process.env.DOCKER_GATEWAY_HOSTNAME || '').trim().toLowerCase();
  if (!gatewayHost) return u;
  try {
    const x = new URL(u);
    if (x.hostname.toLowerCase() !== gatewayHost) return u;
    const ip = String(process.env.DOCKER_HOST_GATEWAY_IP || '').trim();
    if (!ip) return u;
    x.hostname = ip;
    return x.toString();
  } catch {
    return u;
  }
}

/**
 * 任务云回调前缀：`.../api/tenant/.../workspace/.../task/.../comment/{cid}/cloud`。
 * 优先读环境变量 tenantId / workspaceId / taskId / COMMENT_ID；若缺失则从 TaskApiEndPoint 路径解析。
 * 无 commentId 时抛错，禁止回退旧 `…/task/{id}/cloud`。
 */
export function taskApiPrefix() {
  const raw = rewriteDockerInternal(
    String(process.env.TaskApiEndPoint || process.env.TASK_API_ENDPOINT || '').trim(),
  );
  if (!raw) return null;

  let tenant = String(process.env.tenantId || '').trim();
  let workspace = String(process.env.workspaceId || '').trim();
  let task = String(process.env.taskId || '').trim();
  let comment = String(process.env.COMMENT_ID || '').trim();
  if (comment === '-') comment = '';

  try {
    const base = raw.includes('://') ? raw : `http://${raw}`;
    const u = new URL(base);
    const parsed = parseTenantWorkspaceTaskFromPath(u.pathname);
    if (parsed) {
      if (!tenant) tenant = parsed.tenant;
      if (!workspace) workspace = parsed.workspace;
      if (!task) task = parsed.task;
      if (!comment && parsed.comment) comment = String(parsed.comment).trim();
    }
  } catch {
    /* 非 URL 形态时仅依赖环境变量 */
  }

  if (!tenant || !workspace || !task) {
    throw new Error(
      'TaskApiEndPoint/TASK_API_ENDPOINT set but tenantId/workspaceId/taskId missing (请在容器环境注入 tenantId/workspaceId/taskId，或使用可解析路径：/api/tenant/.../task/... 或 /api/.../task-detail/... 或浏览器任务页 /tenant/.../task-detail/...)'
    );
  }
  if (!comment) {
    throw new Error(
      'TaskApiEndPoint/TASK_API_ENDPOINT requires /comment/{cid}/ (inject COMMENT_ID or use path …/task/{taskId}/comment/{cid}/cloud)'
    );
  }

  let origin = raw;
  try {
    const base = raw.includes('://') ? raw : `http://${raw}`;
    const u = new URL(base);
    origin = u.origin;
  } catch {
    throw new Error('Invalid TaskApiEndPoint/TASK_API_ENDPOINT (expected absolute URL or origin)');
  }

  return buildTaskCloudPrefix(origin, tenant, workspace, task, comment);
}

/**
 * POST `server-container-token/heartbeat/`：Django 向任务详情 SSE 转发 `container_heartbeat`（前端「容器连接」状态）。
 * 与 layer-graph-push 独立；此前未调用时 zTree 有数据但心跳始终收不到。
 * @param {string} [message]
 * @returns {Promise<boolean>} 是否上报成功（失败静默，供定时循环使用）
 */
let containerHeartbeatSeq = 0;
let lastSaasHeartbeatSeq = 0;

/** 测试或重启后重置 seq/ack 状态 */
export function resetContainerHeartbeatSeqState() {
  containerHeartbeatSeq = 0;
  lastSaasHeartbeatSeq = 0;
}

export async function postContainerHeartbeatToSaas(message, extra = {}) {
  let cloudPrefix;
  try {
    cloudPrefix = taskApiPrefix();
  } catch {
    return false;
  }
  const accessToken = String(process.env.ACCESS_TOKEN || '').trim();
  if (!cloudPrefix || !accessToken) return false;
  const url = `${cloudPrefix.replace(/\/$/, '')}/server-container-token/heartbeat/`;
  containerHeartbeatSeq += 1;
  const body = { access_token: accessToken, seq: containerHeartbeatSeq, ...saasInboundScopeFields() };
  if (lastSaasHeartbeatSeq > 0) {
    body.ack = lastSaasHeartbeatSeq;
  }
  const msg = typeof message === 'string' ? message.trim() : '';
  if (msg) body.message = msg.slice(0, 500);
  if (extra && Object.prototype.hasOwnProperty.call(extra, 'instruction_idle')) {
    body.instruction_idle = Boolean(extra.instruction_idle);
  }
  try {
    const data = await postJson(url, body, 14, { reqLogFile: HEARTBEAT_REQ_LOG_FILE });
    // SaaS 全局中间件会把 JSON 数字转成字符串；须兼容 number / numeric string
    const saasSeqRaw = data?.seq;
    const saasSeq =
      typeof saasSeqRaw === 'number'
        ? saasSeqRaw
        : typeof saasSeqRaw === 'string' && saasSeqRaw.trim() !== ''
          ? Number(saasSeqRaw)
          : NaN;
    if (Number.isFinite(saasSeq) && saasSeq >= 0) {
      lastSaasHeartbeatSeq = Math.floor(saasSeq);
    }
    return Boolean(data?.bidirectional_ok ?? data?.status === 'ok');
  } catch {
    return false;
  }
}

const DEFAULT_SAAS_HEARTBEAT_INTERVAL_SEC = 20;

/**
 * 启动定时向 SaaS 上报容器存活（与 `TRAE_SKIP_REACHABILITY_REGISTER` 独立；可单独用 `TRAE_SKIP_SAAS_HEARTBEAT` 关闭）。
 * @returns {() => void} 停止定时器
 */
export function startSaasContainerHeartbeatLoop() {
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRAE_SKIP_SAAS_HEARTBEAT || '').toLowerCase())) {
    return () => {};
  }
  const raw = String(process.env.TRAE_SAAS_HEARTBEAT_INTERVAL_SEC || '').trim();
  const sec = Math.max(5, Number.isFinite(parseFloat(raw)) ? parseFloat(raw) : DEFAULT_SAAS_HEARTBEAT_INTERVAL_SEC);
  const initialDelayRaw = String(process.env.TRAE_SAAS_HEARTBEAT_INITIAL_DELAY_SEC || '5').trim();
  const initialDelaySec = Math.max(
    0,
    Number.isFinite(parseFloat(initialDelayRaw)) ? parseFloat(initialDelayRaw) : 5,
  );
  let consecutiveFailures = 0;
  const tick = () => {
    void postContainerHeartbeatToSaas('onlineServiceJS').then((ok) => {
      if (ok) {
        consecutiveFailures = 0;
        return;
      }
      consecutiveFailures += 1;
      // 失败默认只写 heartbeat.log；连续失败时打 stdout，便于 docker logs 诊断「容器连接 idle」
      if (consecutiveFailures === 1 || consecutiveFailures % 3 === 0) {
        console.error(
          `[onlineServiceJS] SaaS 容器心跳上报失败 consecutive=${consecutiveFailures}（详见 reqLogs/heartbeat.log）`,
        );
      }
    });
  };
  let intervalId = null;
  const startInterval = () => {
    tick();
    intervalId = setInterval(tick, Math.round(sec * 1000));
  };
  const initialTimer =
    initialDelaySec > 0
      ? setTimeout(startInterval, Math.round(initialDelaySec * 1000))
      : (startInterval(), null);
  return () => {
    if (initialTimer != null) clearTimeout(initialTimer);
    if (intervalId != null) clearInterval(intervalId);
  };
}

/**
 * 将当前层级快照上报至 SaaS `server-container-token/layer-graph-push/`，由 Django 推送到
 * `server-startup-status-sse`（`status: container_layer_graph`），任务详情评论区 zTree 可即时刷新。
 * 环境与 `taskApiPrefix()`、`ACCESS_TOKEN` 不全或请求失败时静默忽略。
 * @param {null|{ layers?: unknown[], jobs?: unknown[], layers_root?: string, bootstrap_layer_id?: string|null }} snapshot
 * @returns {Promise<boolean>} 是否上报成功（失败静默，供定时循环使用）
 */
/**
 * 容器请求 SaaS 释放所属机器节点（终态收尾后调用）。
 * @param {{ terminal_kind?: string, reason?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function postRequestMachineRelease(opts = {}) {
  let cloudPrefix;
  try {
    cloudPrefix = taskApiPrefix();
  } catch {
    return false;
  }
  const accessToken = String(process.env.ACCESS_TOKEN || '').trim();
  if (!cloudPrefix || !accessToken) return false;
  const url = `${cloudPrefix.replace(/\/$/, '')}/server-container-token/request-machine-release/`;
  const terminalKind = String(opts.terminal_kind || '').trim() || 'cancelled';
  const reason = String(opts.reason || `task_status_${terminalKind}`).trim();
  const body = {
    access_token: accessToken,
    terminal_kind: terminalKind,
    reason,
  };
  try {
    const data = await postJson(url, body, 20);
    return Boolean(data?.ok ?? data?.status === 'ok');
  } catch (e) {
    console.error(`[saasTaskCloud] request-machine-release failed: ${formatErrorWithCause(e)}`);
    return false;
  }
}

export async function publishLayerGraphSnapshotToSaas(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  let cloudPrefix;
  try {
    cloudPrefix = taskApiPrefix();
  } catch {
    return false;
  }
  const accessToken = String(process.env.ACCESS_TOKEN || '').trim();
  if (!cloudPrefix || !accessToken) return false;
  const url = `${cloudPrefix.replace(/\/$/, '')}/server-container-token/layer-graph-push/`;
  const body = {
    access_token: accessToken,
    layers: Array.isArray(snapshot.layers) ? snapshot.layers : [],
    jobs: Array.isArray(snapshot.jobs) ? snapshot.jobs : [],
  };
  const lr = snapshot.layers_root;
  if (typeof lr === 'string' && lr.trim()) body.layers_root = lr.trim();
  const bs = snapshot.bootstrap_layer_id;
  if (bs != null && String(bs).trim()) body.bootstrap_layer_id = String(bs).trim();
  try {
    await postJson(url, body, 15);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_SAAS_LAYER_GRAPH_PUSH_INTERVAL_SEC = 30;

/**
 * 定时将层级快照推送到 SaaS（弥补仅事件触发时前端刷新/SSE 漏收导致的「等待可写层」）。
 * @param {() => null|{ layers?: unknown[], jobs?: unknown[], layers_root?: string, bootstrap_layer_id?: string|null } | Promise<null|{ layers?: unknown[], jobs?: unknown[], layers_root?: string, bootstrap_layer_id?: string|null }>} getSnapshot
 * @returns {() => void} 停止定时器
 */
export function startSaasLayerGraphPushLoop(getSnapshot) {
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRAE_SKIP_SAAS_LAYER_GRAPH_PUSH || '').toLowerCase())) {
    return () => {};
  }
  if (typeof getSnapshot !== 'function') {
    return () => {};
  }
  const raw = String(process.env.TRAE_SAAS_LAYER_GRAPH_PUSH_INTERVAL_SEC || '').trim();
  const sec = Math.max(
    10,
    Number.isFinite(parseFloat(raw)) ? parseFloat(raw) : DEFAULT_SAAS_LAYER_GRAPH_PUSH_INTERVAL_SEC,
  );
  const initialDelayRaw = String(process.env.TRAE_SAAS_LAYER_GRAPH_PUSH_INITIAL_DELAY_SEC || '8').trim();
  const initialDelaySec = Math.max(
    0,
    Number.isFinite(parseFloat(initialDelayRaw)) ? parseFloat(initialDelayRaw) : 8,
  );
  const tick = () => {
    void (async () => {
      try {
        const snap = await getSnapshot();
        await publishLayerGraphSnapshotToSaas(snap);
      } catch {
        /* optional */
      }
    })();
  };
  let intervalId = null;
  const startInterval = () => {
    tick();
    intervalId = setInterval(tick, Math.round(sec * 1000));
  };
  const initialTimer =
    initialDelaySec > 0
      ? setTimeout(startInterval, Math.round(initialDelaySec * 1000))
      : (startInterval(), null);
  return () => {
    if (initialTimer != null) clearTimeout(initialTimer);
    if (intervalId != null) clearInterval(intervalId);
  };
}

const GIT_CLONE_RETRYABLE_PATTERNS = [
  /RPC failed; curl \d+/i,
  /GnuTLS recv error/i,
  /SSL read: errno/i,
  /OpenSSL SSL_read:/i,
  /SSL_ERROR_SYSCALL/i,
  /fatal: early EOF/i,
  /unexpected disconnect while reading sideband packet/i,
  /fetch-pack: invalid index-pack output/i,
  /Connection (?:timed out|reset by peer)/i,
  /Operation timed out/i,
  /The remote end hung up unexpectedly/i,
];

/**
 * git clone 失败时是否属于可恢复网络抖动：仅此类错误才建议重试。
 * @param {unknown} errLike
 * @returns {boolean}
 */
export function isRetryableGitCloneFailure(errLike) {
  const msg = String(errLike instanceof Error ? errLike.message : errLike || '');
  if (!msg) return false;
  return GIT_CLONE_RETRYABLE_PATTERNS.some((re) => re.test(msg));
}

/**
 * 克隆重试配置（用于 bootstrap/reclone）：默认最多 3 次（含首轮）。
 * @returns {{ maxAttempts: number, backoffMs: number }}
 */
export function gitCloneRetryConfigFromEnv() {
  const maxAttemptsRaw = parseInt(String(process.env.TRAE_GIT_CLONE_MAX_ATTEMPTS || '3'), 10);
  const backoffRaw = parseInt(String(process.env.TRAE_GIT_CLONE_RETRY_BACKOFF_MS || '1200'), 10);
  const maxAttempts = Number.isFinite(maxAttemptsRaw) ? Math.max(1, Math.min(6, maxAttemptsRaw)) : 3;
  const backoffMs = Number.isFinite(backoffRaw) ? Math.max(200, Math.min(15000, backoffRaw)) : 1200;
  return { maxAttempts, backoffMs };
}

export function runGitCloneWithProgress(args, env, cwd, onStderrProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(gitCmd(), args, {
      env: {
        ...process.env,
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_HTTP_IPV4: String(env.GIT_HTTP_IPV4 || process.env.GIT_HTTP_IPV4 || '1'),
      },
      cwd: cwd || undefined,
    });
    let err = '';
    proc.stderr?.on('data', (c) => {
      const s = c.toString();
      err += s;
      if (onStderrProgress) onStderrProgress(s, err);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(err);
      else reject(new Error(`git exit ${code}: ${err.slice(-1500)}`));
    });
  });
}
