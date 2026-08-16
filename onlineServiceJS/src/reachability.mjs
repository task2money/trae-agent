/**
 * 解析宿主机可达 IP 与映射端口，向 SaaS 注册 CloudServerConfig（register-reachability）。
 * 公网 IP **仅**来自启动注入的环境变量（UserData / go_relay / docker -e），镜像内禁止写死或外网探测。
 */
import {
  appendOutboundReqLog,
} from './outboundReqLog.mjs';
import { postJson, rewriteDockerInternal, taskApiPrefix } from './saasTaskCloud.mjs';
import { isTransientHttpStatus } from './saasPostJson.mjs';
import { saasInboundScopeFields } from './saasInboundScope.mjs';

/** IPv6 等非 IPv4 文本在 URL authority 中需方括号 */
function authorityHost(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) return s;
  if (!s.includes(':')) return s;
  return `[${s}]`;
}

function buildHttpUrl(ip, port, pathname = '') {
  const h = authorityHost(ip);
  const p = Number(port);
  if (!h || !Number.isFinite(p) || p <= 0) return '';
  let suffix = pathname || '';
  if (suffix && !suffix.startsWith('/')) suffix = `/${suffix}`;
  return `http://${h}:${p}${suffix}`;
}

function normalizeUrlNoTrailingSlash(raw) {
  const u = new URL(raw);
  return u.href.replace(/\/$/, '');
}

function envBusinessApiEndpointRaw() {
  return String(process.env.BusinessApiEndPoint || process.env.BUSINESS_API_ENDPOINT || '').trim();
}

/**
 * 与 `bootstrap.mjs` 中换票用 `normalizeBusinessApiEndpointUrl` 对齐：编排常见
 * `http://<ip>/api` 无显式端口时，WHATWG URL 的 origin 会落在默认 80/443，与容器实际
 * `PORT` / `TRAE_HOST_HTTP_PORT`（默认 8765）不一致，导致 register-reachability 写入 DB 缺端口。
 */
function applyHostMappedPortIfIpLikeHost(u) {
  const host = String(u.hostname || '').trim();
  const looksLikeIp =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost';
  if (!u.port && looksLikeIp) {
    u.port = String(hostMappedHttpPort());
  }
}

/**
 * Docker ``-p <host>:8765`` 时 env 常仍写 ``:8765``，而 ``TRAE_HOST_HTTP_PORT`` 为宿主机映射口；
 * 与 IP 无端口补全同理，避免 register-reachability 写入错误 server_url（SaaS 拉层图 502）。
 * 不改动 ngrok/HTTPS 等非 8765 的显式端口。
 */
function applyHostMappedPortWhenBusinessEndpointUsesContainerDefault(u) {
  if (!String(process.env.TRAE_HOST_HTTP_PORT || '').trim()) return;
  const mapped = hostMappedHttpPort();
  const containerDefault = parseInt(process.env.PORT || '8765', 10) || 8765;
  const endpointPort = u.port
    ? parseInt(u.port, 10)
    : u.protocol === 'https:'
      ? 443
      : 80;
  if (!Number.isFinite(endpointPort) || endpointPort !== containerDefault || mapped === endpointPort) {
    return;
  }
  u.port = String(mapped);
}

/**
 * 优先沿用换票阶段使用的 BUSINESS_API_ENDPOINT，避免注册可达地址与换票地址源不一致。
 * @returns {{ businessApiEndpoint: string, serverUrl: string, publicIp: string|null } | null}
 */
export function reachabilityFromBusinessEndpointEnv() {
  const raw = envBusinessApiEndpointRaw();
  if (!raw) return null;

  let u;
  try {
    u = new URL(rewriteDockerInternal(raw));
  } catch {
    appendOutboundReqLog('reachability: ignore invalid BUSINESS_API_ENDPOINT/BusinessApiEndPoint');
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    appendOutboundReqLog(`reachability: ignore non-http business endpoint protocol=${u.protocol}`);
    return null;
  }
  applyHostMappedPortIfIpLikeHost(u);
  applyHostMappedPortWhenBusinessEndpointUsesContainerDefault(u);
  const hostName = String(u.hostname || '').trim().toLowerCase();
  // Loopback is not browser/SaaS reachable; fall through to resolveReachableIp().
  if (hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '::1' || hostName === '0.0.0.0') {
    appendOutboundReqLog(
      `reachability: ignore loopback BUSINESS_API_ENDPOINT host=${hostName}; will resolve reachable IP`,
    );
    return null;
  }
  const businessApiEndpoint = normalizeUrlNoTrailingSlash(u.href);
  const ipLikeHost =
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostName) || hostName.includes(':');
  const publicIp = ipLikeHost ? hostName : null;

  // business_api_endpoint 约定为 .../api；server_url 对应其上一级根（保留可能存在的前缀路径）。
  let pathNoTrailing = String(u.pathname || '/').replace(/\/+$/, '');
  if (!pathNoTrailing) pathNoTrailing = '/';
  if (pathNoTrailing.toLowerCase().endsWith('/api')) {
    pathNoTrailing = pathNoTrailing.slice(0, -4) || '/';
  }
  const serverUrl = normalizeUrlNoTrailingSlash(`${u.origin}${pathNoTrailing}`);

  return { businessApiEndpoint, serverUrl, publicIp };
}

/**
 * 公网/可达 IP 仅认启动注入的环境变量（UserData / relay / docker -e）。
 * 禁止镜像内写死 IP，也禁止 ipw.cn / 网卡自动探测（易拿到错误 EIP）。
 * 不使用 127.0.0.1 作为隐式回退；无法解析时抛错，由调用方退出进程。
 * @returns {Promise<string>}
 */
export async function resolveReachableIp() {
  const fromEnv = String(process.env.TRAE_PUBLIC_IP || process.env.PUBLIC_IP || '').trim();
  if (fromEnv) return fromEnv;

  throw new Error(
    '无法解析可达 IP（已禁用回退 127.0.0.1 与外网/网卡探测）：请由 UserData 或编排注入环境变量 TRAE_PUBLIC_IP / PUBLIC_IP，' +
      '或设置非 loopback 的 BUSINESS_API_ENDPOINT / BusinessApiEndPoint（host 为 IP 时可提取 public_ip）',
  );
}

/** 宿主机可达 HTTP 端口：publish 映射优先 TRAE_HOST_HTTP_PORT，否则容器 PORT，默认与 server.listen 一致 8765 */
export function hostMappedHttpPort() {
  const explicit = String(process.env.TRAE_HOST_HTTP_PORT || '').trim();
  if (explicit) {
    const n = parseInt(explicit, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return parseInt(process.env.PORT || '8765', 10) || 8765;
}

function envTruthy(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function isLoopbackHostname(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
}

/**
 * SaaS（taskCloudService / gateway）与容器同机时，register-reachability 的 server_url
 * 必须用 loopback，供心跳与 container-target 转发；公网 IP 仅写入 public_ip / vscode URL。
 * 触发：TRAE_SAAS_COLOCATED / TRAE_REGISTER_LOOPBACK，或 TASK_API_ENDPOINT_ORIGIN 指向 loopback。
 */
export function isSaasColocatedWithContainer() {
  if (envTruthy('TRAE_SAAS_COLOCATED') || envTruthy('TRAE_REGISTER_LOOPBACK')) {
    return true;
  }
  const raw = String(
    process.env.TASK_API_ENDPOINT_ORIGIN ||
      process.env.TASK_API_ENDPOINT ||
      process.env.TaskApiEndPoint ||
      '',
  ).trim();
  if (!raw) return false;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
    return isLoopbackHostname(new URL(withScheme).hostname);
  } catch {
    return false;
  }
}

function hostMappedVscodePort() {
  const explicit = String(process.env.TRAE_HOST_VSCODE_PORT || '').trim();
  if (explicit) {
    const n = parseInt(explicit, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // onlineService-entrypoint.sh：CODE_SERVER_ENABLED 时 code-server 默认监听容器内 8888；宿主机常见 8888:8888 映射
  const cs = String(process.env.CODE_SERVER_ENABLED || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(cs)) {
    const inner = parseInt(String(process.env.CODE_SERVER_BIND_PORT || '8888').trim(), 10);
    return Number.isFinite(inner) && inner > 0 ? inner : 8888;
  }
  return null;
}

/**
 * 向 SaaS 注册 `server_url` / `business_api_endpoint`（register-reachability）。
 * 由 `server.mjs` 在 HTTP listen 成功后尽快调用，早于 `runBootstrapAfterListen`（克隆与 YAML），
 * 以便任务详情页拉层图与心跳不被长时间 git clone 阻塞。
 *
 * @param {{ skipped?: boolean, prefix?: string, newAccess?: string, timeout?: number }} ctx
 */
export async function registerReachabilityAfterBootstrap(ctx) {
  if (!ctx || ctx.skipped || !ctx.prefix) return;
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRAE_SKIP_REACHABILITY_REGISTER || '').toLowerCase())) {
    appendOutboundReqLog('reachability: skip TRAE_SKIP_REACHABILITY_REGISTER');
    return;
  }

  const token = String(process.env.ACCESS_TOKEN || ctx.newAccess || '').trim();
  if (!token) {
    appendOutboundReqLog('reachability: skip (no ACCESS_TOKEN)');
    return;
  }

  let prefix = ctx.prefix;
  try {
    prefix = taskApiPrefix();
  } catch {
    /* use ctx.prefix */
  }

  const timeoutSec = Math.max(1, ctx.timeout || parseFloat(process.env.TASK_API_BOOTSTRAP_TIMEOUT_SEC || '5') || 5);

  const fromBusiness = reachabilityFromBusinessEndpointEnv();
  const colocated = isSaasColocatedWithContainer();
  // 浏览器/元数据用公网 IP；同机 SaaS 探测另用 loopback（见下方 serverUrl 覆盖）。
  let pip = fromBusiness ? fromBusiness.publicIp : null;
  if (!pip) {
    try {
      pip = await resolveReachableIp();
    } catch (e) {
      if (!colocated) throw e;
      appendOutboundReqLog(
        `reachability: resolveReachableIp failed under colocated SaaS (${String(e?.message || e).slice(0, 200)}); public_ip omitted`,
      );
      pip = null;
    }
  }
  const httpPort = hostMappedHttpPort();
  const vscodePort = hostMappedVscodePort();

  let serverUrl = fromBusiness?.serverUrl || buildHttpUrl(pip, httpPort);
  let biz = fromBusiness?.businessApiEndpoint || buildHttpUrl(pip, httpPort, '/api');
  if (colocated) {
    serverUrl = buildHttpUrl('127.0.0.1', httpPort);
    biz = buildHttpUrl('127.0.0.1', httpPort, '/api');
    appendOutboundReqLog(
      `reachability: SaaS colocated → register server_url=${serverUrl} (public_ip=${pip || '(none)'} for browser metadata)`,
    );
  }
  const vscodeUrl = vscodePort != null && pip ? buildHttpUrl(pip, vscodePort, '/') : '';

  const body = {
    access_token: token,
    server_url: serverUrl,
    business_api_endpoint: biz,
    ...saasInboundScopeFields(),
  };
  if (pip) body.public_ip = pip;
  if (vscodeUrl) body.container_vscode_url = vscodeUrl;

  const registerUrl = `${prefix.replace(/\/$/, '')}/server-container-token/register-reachability/`;
  // 覆盖完整 runAll/SaaS 进程重启窗口（~30s）；首跳立即，后续退避累计约 31.7s（OPT-20260816-051）。
  const retryDelaysMs = [0, 200, 500, 1000, 2000, 4000, 8000, 16000];
  let lastErr;
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    if (retryDelaysMs[attempt] > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, retryDelaysMs[attempt]);
      });
    }
    try {
      await postJson(registerUrl, body, timeoutSec);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const status = Number(e?.retryableHttpStatus || e?.structuredPayload?.status || e?.status || 0);
      const code = String(e?.structuredPayload?.error_code || e?.structuredPayload?.detail || '');
      const msg = String(e?.message || '');
      const retryable =
        isTransientHttpStatus(status) ||
        code.includes('RELAY_DOWNSTREAM_BUSY') ||
        /HTTP\s+(404|408|425|429|502|503|504)\b/.test(msg);
      if (!retryable || attempt === retryDelaysMs.length - 1) {
        throw e;
      }
      appendOutboundReqLog(
        `reachability: register-reachability retry ${attempt + 1} after ${retryDelaysMs[attempt + 1] ?? 0}ms (${String(e?.message || e).slice(0, 200)})`,
      );
    }
  }
  if (lastErr) {
    throw lastErr;
  }
  const pipText = pip || '(none)';
  console.log(
    `[onlineServiceJS] 已向 SaaS 注册可达地址 public_ip=${pipText} server_url=${serverUrl} business_api_endpoint=${biz}` +
      (vscodeUrl ? ` vscode=${vscodeUrl}` : '')
  );
  appendOutboundReqLog(
    `reachability: registered public_ip=${pipText} server_url=${serverUrl} business_api_endpoint=${biz}`
  );
}
