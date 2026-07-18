import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import YAML from 'yaml';
import { resolveAgentConfigFromEnv } from './featureParamsEnvToYaml.mjs';
import { appendFeatureParamsEnvLogBestEffort } from './featureParamsEnvLog.mjs';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import {
  newLayerId,
  createRootLayer,
  createEmptyLayer,
  layerPath,
  readLayerMeta,
  writeLayerMeta,
  LAYER_ID_RE,
  resolveRepoCloneDirName,
  resolveRepoCloneRelPath,
  sanitizeCloneRelPath,
  relocateClonedRepo,
} from './layerFs.mjs';
import { configFilePath, layersRoot, logsDir, runtimeDir } from './paths.mjs';
import {
  appendExecStream,
  resetExecStream,
  getExecStreamFullText,
  completeExecStream,
} from './execStream.mjs';
import { gitCmd, gitCloneConfigArgs } from './gitCmd.mjs';
import { normalizeRepoUrlForHttpsClone } from './gitRemote.mjs';
import {
  postJson,
  rewriteDockerInternal,
  taskApiPrefix,
  postCloneProgress,
  latestGitProgressPercent,
  parseGitCloneProgressPhases,
  normalizeGitProgressChunkForLog,
  gitCloneRetryConfigFromEnv,
  isRetryableGitCloneFailure,
  runGitCloneWithProgress,
} from './saasTaskCloud.mjs';
import { hostMappedHttpPort } from './reachability.mjs';
import { rememberStaleAccessToken } from './uiAccessToken.mjs';
import { mapPool, bootstrapCloneConcurrencyFromEnv } from './mapPool.mjs';
import {
  collectRepoBranchPlans,
  checkoutWorkBranchesForJobs,
} from './bootstrapWorkBranch.mjs';

export let bootstrapCloneLayerId = null;
/** 为 true 时 server 须在引导结束后调用 registerBootstrapCloneJob（仅「任务详情已含仓库并完成引导克隆」） */
export let bootstrapRegisterCloneJob = false;
export let startupEmptyLayerId = null;
/** 最近一次 bootstrap 拉取的 task-detail（供 auto_run 首指令/交付） */
export let lastBootstrapTaskDetail = null;

/**
 * 多仓引导克隆期间：各仓 stderr 并行写入此结构，GET /api/repos/bootstrap-clone-log 再拼成 text 并返回 segments。
 * 引导结束并写入 exec-stream 后清空。
 * @type {{
 *   layerId: string,
 *   preamble: string,
 *   jobs: { raw: string, repoDir: string, index: number }[],
 *   bufs: Map<string, { header: string, body: string, failNote?: string }>,
 * } | null}
 */
let bootstrapRepoLogState = null;

/** 克隆日志走通用 exec-stream（分片 + SSE）；与 GET /api/exec-streams/clone/:id/* 同源 */
export function appendCloneLayerLog(layerId, text) {
  appendExecStream('clone', layerId, text);
}

function rebuildBootstrapParallelLogText() {
  if (!bootstrapRepoLogState) return '';
  const { preamble, jobs, bufs } = bootstrapRepoLogState;
  const parts = [preamble];
  for (const job of jobs) {
    const e = bufs.get(job.raw);
    if (!e) continue;
    parts.push(e.header + e.body + (e.failNote || ''));
  }
  return parts.join('\n\n');
}

/**
 * 引导克隆存在失败时的日志页脚：点名失败仓（目录名 + URL），避免仅写「存在失败」。
 * @param {{ raw: string, repoDir: string, errMsg?: string }[]} failedJobs
 * @returns {string}
 */
export function formatBootstrapCloneFailureFooter(failedJobs) {
  const list = Array.isArray(failedJobs) ? failedJobs : [];
  const lines = ['', '【项目克隆】已结束（存在失败，引导继续）。'];
  if (list.length) {
    lines.push(`失败仓库（${list.length}）：`);
    for (const j of list) {
      const name = path.basename(String(j?.repoDir || '')) || '(unknown)';
      const url = String(j?.raw || '').trim() || '(no-url)';
      const errOneLine = String(j?.errMsg || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      lines.push(errOneLine ? `- ${name} — ${url}（${errOneLine}）` : `- ${name} — ${url}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 单仓/多仓克隆失败不阻断引导后续（feature-params / BOOTSTRAP_COMPLETE / 业务端点就绪）。
 * 失败仓可在任务详情「重新克隆」；其余已成功仓照常可用。
 * @param {{ failedCount: number, totalCount: number, failedNames?: string }} opts
 * @returns {{ abort: boolean, progressMessage: string, level: 'ok' | 'partial' }}
 */
export function resolveBootstrapCloneFailurePolicy(opts) {
  const failedCount = Math.max(0, Number(opts?.failedCount) || 0);
  const totalCount = Math.max(0, Number(opts?.totalCount) || 0);
  if (failedCount <= 0) {
    return {
      abort: false,
      progressMessage: '【项目克隆】仓库克隆已完成',
      level: 'ok',
    };
  }
  const names = String(opts?.failedNames || '').trim() || `${failedCount} 个`;
  return {
    abort: false,
    progressMessage:
      `【项目克隆】部分失败：失败 ${failedCount}/${totalCount || failedCount} 个仓库：${names}（其余已就绪，引导继续）`.slice(
        0,
        2000,
      ),
    level: 'partial',
  };
}

/**
 * 引导多仓并行克隆进行中时供 GET /api/repos/bootstrap-clone-log 返回 `segments`（按任务详情仓库顺序）。
 * @param {string} layerId
 * @returns {{ repo_url: string, text: string }[] | null}
 */
export function getBootstrapCloneLogSegmentsForApi(layerId) {
  if (!bootstrapRepoLogState || bootstrapRepoLogState.layerId !== layerId) {
    return null;
  }
  const { jobs, bufs } = bootstrapRepoLogState;
  return jobs.map((job) => {
    const e = bufs.get(job.raw);
    const text = e ? e.header + e.body + (e.failNote || '') : '';
    return { repo_url: job.raw, text };
  });
}

export function getCloneLayerLogText(layerId) {
  if (bootstrapRepoLogState && bootstrapRepoLogState.layerId === layerId) {
    return rebuildBootstrapParallelLogText();
  }
  return getExecStreamFullText('clone', layerId);
}

export function clearCloneLayerLog(layerId) {
  resetExecStream('clone', layerId);
}

/** 引导克隆结束：封包并推送 exec_stream_complete（与 UI 克隆队列一致） */
export function finalizeCloneLayerLog(layerId) {
  completeExecStream('clone', layerId);
}

/**
 * 规范化换票用的 business_api_endpoint：
 * - 编排模板常见错误 `http://<ip>:/api`（`${PORT}` 为空）在部分校验器下非法；WHATWG URL 会折叠为无端口 origin。
 * - 若折叠后仍无显式端口且 host 像可达 IP/localhost：补全为 {@link hostMappedHttpPort}（与 listen / register-reachability 一致，含 PORT 未设时默认 8765）。
 */
function normalizeBusinessApiEndpointUrl(raw) {
  let candidate = String(raw || '').trim();
  if (!candidate) return candidate;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `http://${candidate}`;
  }
  let u;
  try {
    u = new URL(candidate);
  } catch {
    throw new Error(`Invalid BusinessApiEndPoint/BUSINESS_API_ENDPOINT (not a valid URL): ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('BusinessApiEndPoint must be http or https');
  }
  const host = u.hostname || '';
  const looksLikeIp =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost';
  if (!u.port && looksLikeIp) {
    u.port = String(hostMappedHttpPort());
  }
  return u.href.replace(/\/$/, '');
}

function businessApiEndpoint() {
  let raw = String(process.env.BusinessApiEndPoint || process.env.BUSINESS_API_ENDPOINT || '').trim();
  if (!raw) {
    throw new Error('BusinessApiEndPoint/BUSINESS_API_ENDPOINT empty');
  }
  raw = rewriteDockerInternal(raw);
  return normalizeBusinessApiEndpointUrl(raw);
}

/** 仅当显式设置 TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE 时跳过换票（本地/unit 专用）。勿用语义启发式跳过：SSH 隧道把远端 SaaS 映射到 127.0.0.1 时会误判并导致 DB 中 container_refresh_token 永不写入。 */
function skipContainerTokenExchangeByEnv() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE || '').trim().toLowerCase(),
  );
}

/**
 * 从 task-detail 收集待克隆仓库（URL + 可选 clone_alias / parent_repo_url）。
 * 优先 `git_repo_entries`；否则回退 `git_repos` 字符串列表。
 * @returns {{ url: string, cloneAlias: string, parentRepoUrl: string }[]}
 */
export function collectRepoCloneJobs(taskDetail) {
  const out = [];
  const seen = new Set();
  function add(rawUrl, rawAlias, rawParent) {
    const u = String(rawUrl || '').trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({
      url: u,
      cloneAlias: String(rawAlias || '').trim(),
      parentRepoUrl: String(rawParent || '').trim(),
    });
  }
  function walkEntries(entries) {
    if (!Array.isArray(entries)) return false;
    let any = false;
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const url = e.url || e.repo_url || e.git_repo;
      if (!url) continue;
      add(
        url,
        e.clone_alias || e.alias || '',
        e.parent_repo_url || e.parentRepoUrl || '',
      );
      any = true;
    }
    return any;
  }
  function walk(value) {
    if (typeof value === 'string') {
      add(value, '', '');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      if (walkEntries(value.git_repo_entries)) {
        return;
      }
      add(
        value.git_repo || value.url || value.repo_url,
        value.clone_alias || value.alias || '',
        value.parent_repo_url || value.parentRepoUrl || '',
      );
      if (value.git_repos != null) walk(value.git_repos);
    }
  }
  if (taskDetail?.project_repos) walk(taskDetail.project_repos);
  if (taskDetail?.git_repo_entries) walkEntries(taskDetail.git_repo_entries);
  if (taskDetail?.git_repos) walk(taskDetail.git_repos);
  const taskObj = taskDetail?.task;
  if (taskObj && typeof taskObj === 'object') {
    if (taskObj.git_repo_entries) walkEntries(taskObj.git_repo_entries);
    if (taskObj.git_repos) walk(taskObj.git_repos);
    const params = taskObj.parameters;
    if (params && typeof params === 'object') {
      for (const k of ['git_repo_entries', 'git_repos', 'project_urls', 'project_repos', 'repos', 'repositories']) {
        if (params[k]) walk(params[k]);
      }
    }
  }
  return out;
}

function collectRepoUrls(taskDetail) {
  return collectRepoCloneJobs(taskDetail).map((j) => j.url);
}

/** @deprecated use collectRepoCloneJobs; kept for internal URL-only callers */
export { collectRepoUrls };

function canonicalRepoUrlKey(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return v.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

function repoPathKey(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    return String(u.pathname || '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  } catch {
    const scp = v.match(/^[^@]+@[^:]+:(.+)$/);
    if (!scp || !scp[1]) return '';
    return String(scp[1])
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  }
}

export function resolveRepoCloneCredential(credRoot, repoUrl) {
  if (!credRoot || typeof credRoot !== 'object') return null;
  const direct = credRoot[String(repoUrl || '').trim()];
  if (direct && typeof direct === 'object') return direct;
  const target = canonicalRepoUrlKey(repoUrl);
  if (!target) return null;
  for (const [k, v] of Object.entries(credRoot)) {
    if (canonicalRepoUrlKey(k) !== target) continue;
    if (v && typeof v === 'object') return v;
  }
  // 兼容同一仓库因 allowedHost/隧道映射导致 host 不同（如 gitlab.aidevpm.com ↔ localhost:8012）。
  // 仅在“路径唯一”时回退，避免多仓同路径误配凭证。
  const targetPath = repoPathKey(repoUrl);
  if (!targetPath) return null;
  const byPath = [];
  for (const [k, v] of Object.entries(credRoot)) {
    if (!v || typeof v !== 'object') continue;
    if (repoPathKey(k) !== targetPath) continue;
    byPath.push(v);
    if (byPath.length > 1) return null;
  }
  if (byPath.length === 1) return byPath[0];
  return null;
}

function usernameFromRepoUrl(repoUrl) {
  const raw = String(repoUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const segs = String(u.pathname || '')
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean);
    if (!segs.length) return '';
    return segs[0] || '';
  } catch {
    return '';
  }
}

function defaultGitHttpUsernameForProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'gitlab') return 'oauth2';
  if (p === 'github') return 'x-access-token';
  return '';
}

export function buildHttpAuthFromRepoCredential(rawCredential, repoUrl = '') {
  if (!rawCredential || typeof rawCredential !== 'object') return null;
  const password = String(rawCredential.ephemeral_oauth_access_token || '').trim();
  if (!password) return null;
  let username = String(rawCredential.git_http_username || '').trim();
  if (!username) {
    username = defaultGitHttpUsernameForProvider(rawCredential.provider);
  }
  if (!username) {
    username = usernameFromRepoUrl(repoUrl);
  }
  if (!username) return null;
  return { username, password };
}

function createBootstrapGitAskPassScript(httpAuth) {
  if (!httpAuth) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-askpass-'));
  const shPath = path.join(dir, 'askpass.sh');
  fs.writeFileSync(
    shPath,
    [
      '#!/usr/bin/env sh',
      'prompt="$1"',
      'case "$prompt" in',
      '  *sername*) printf %s "$GIT_HTTP_USERNAME" ;;',
      '  *assword*) printf %s "$GIT_HTTP_PASSWORD" ;;',
      '  *) printf "" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 }
  );
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  return {
    envPatch: {
      GIT_ASKPASS: shPath,
      GIT_ASKPASS_ALWAYS: '1',
      GIT_HTTP_USERNAME: httpAuth.username,
      GIT_HTTP_PASSWORD: httpAuth.password,
    },
    cleanup,
  };
}

/**
 * 将仓库 URL（含 SSH）规范为 OAuth HTTPS 克隆地址，并生成 GIT_ASKPASS 环境补丁。
 * bootstrap 与 POST /repos/reclone 共用。
 *
 * @param {string} repoUrl
 * @param {Record<string, unknown> | null | undefined} credRoot
 * @returns {{
 *   cloneRemote: string,
 *   credential: object | null,
 *   httpAuth: { username: string, password: string } | null,
 *   envPatch: Record<string, string>,
 *   cleanup: () => void,
 *   normalizedFromSsh: boolean,
 * }}
 */
export function prepareOauthHttpsGitClone(repoUrl, credRoot) {
  const raw = String(repoUrl || '').trim();
  const credential = resolveRepoCloneCredential(credRoot, raw);
  const httpAuth = buildHttpAuthFromRepoCredential(credential, raw);
  let cloneRemote = raw;
  let normalizedFromSsh = false;
  if (httpAuth) {
    const httpsCloneUrl =
      credential && typeof credential === 'object'
        ? String(credential.https_clone_url || '').trim()
        : '';
    const normalized = normalizeRepoUrlForHttpsClone(raw, { httpsCloneUrl });
    if (normalized && normalized !== raw) {
      cloneRemote = normalized;
      normalizedFromSsh = true;
    }
  }
  if (httpAuth && /^git@/i.test(cloneRemote)) {
    throw new Error(
      `SSH URL 无法转为 HTTPS（缺少 https_clone_url / TRAE_GIT_HTTPS_CLONE_ORIGIN）: ${raw}`,
    );
  }
  const askpass = createBootstrapGitAskPassScript(httpAuth);
  return {
    cloneRemote,
    credential: credential && typeof credential === 'object' ? credential : null,
    httpAuth,
    envPatch: askpass?.envPatch || {},
    cleanup: () => askpass?.cleanup?.(),
    normalizedFromSsh,
  };
}

/**
 * 仅拉取 repo-clone-credentials（供 reclone 等单仓路径，避免重复拉 task-detail）。
 */
export async function fetchRepoCloneCredentialsOnly(prefix, accessToken, timeoutSec) {
  const credResp = await postJson(
    `${prefix}/server-container-token/repo-clone-credentials/`,
    { access_token: accessToken },
    timeoutSec
  );
  return credResp && typeof credResp.repo_clone_credentials === 'object'
    ? credResp.repo_clone_credentials
    : {};
}

/**
 * 并行发起单仓 git clone；stderr 写入 {@link bootstrapRepoLogState} 中对应仓库的 body（与其它仓并行追加）。
 * @returns {Promise<{ ok: boolean, err?: Error }>}
 */
async function runOneBootstrapClone({
  job,
  n,
  credRoot,
  cloudPrefix,
  accessToken,
}) {
  const { raw, repoDir, index: i } = job;
  let prepared;
  try {
    prepared = prepareOauthHttpsGitClone(raw, credRoot);
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err : new Error(String(err)) };
  }
  const { cloneRemote, httpAuth, credential, envPatch, cleanup, normalizedFromSsh } = prepared;
  if (normalizedFromSsh) {
    appendOutboundReqLog(`bootstrap-clone remote normalized ssh→https from=${raw} to=${cloneRemote}`);
  }
  if (httpAuth) {
    const provider = credential && typeof credential === 'object' ? String(credential.provider || '').trim() : '';
    appendOutboundReqLog(
      `bootstrap-clone auth repo=${raw} clone=${cloneRemote} provider=${provider || 'unknown'} git_http_username=${httpAuth.username}`,
    );
  }
  try {
    const gitEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...envPatch,
    };
    const useV4 = String(process.env.TRAE_GIT_CLONE_ALLOW_IPV6 || '').trim() !== '1';
    const args = useV4
      ? [...gitCloneConfigArgs(), 'clone', '-4', '--progress', cloneRemote, repoDir]
      : [...gitCloneConfigArgs(), 'clone', '--progress', cloneRemote, repoDir];
    const { maxAttempts, backoffMs } = gitCloneRetryConfigFromEnv();
    let attempt = 1;
    while (attempt <= maxAttempts) {
      let lastPosted = 0;
      let lastPct = -1;
      try {
        await runGitCloneWithProgress(args, gitEnv, undefined, (chunk, errAll) => {
          if (chunk) {
            const ent = bootstrapRepoLogState?.bufs.get(raw);
            if (ent) ent.body += normalizeGitProgressChunkForLog(chunk);
          }
          const g = latestGitProgressPercent(errAll);
          if (g < 0) return;
          const now = Date.now();
          if (g === lastPct && now - lastPosted < 2000) return;
          if (now - lastPosted < 400 && g <= lastPct) return;
          lastPct = g;
          lastPosted = now;
          const phases = parseGitCloneProgressPhases(errAll);
          const seg = { phase: 'bootstrap', index: i + 1, total: n };
          if (phases.recv != null) seg.recv_progress = phases.recv;
          if (phases.unpack != null) seg.unpack_progress = phases.unpack;
          void postCloneProgress(
            cloudPrefix,
            accessToken,
            g,
            `【项目克隆】(${i + 1}/${n}) ${path.basename(repoDir)} … ${g}%`,
            raw,
            seg
          );
        });
        break;
      } catch (err) {
        const retryable = isRetryableGitCloneFailure(err);
        if (!retryable || attempt >= maxAttempts) throw err;
        const waitMs = backoffMs * attempt;
        const ent = bootstrapRepoLogState?.bufs.get(raw);
        if (ent) {
          ent.body += `\n[bootstrap-clone] 网络抖动，准备第 ${attempt + 1}/${maxAttempts} 次重试（${waitMs}ms）...\n`;
        }
        await postCloneProgress(
          cloudPrefix,
          accessToken,
          0,
          `【项目克隆】(${i + 1}/${n}) 网络抖动，准备第 ${attempt + 1}/${maxAttempts} 次重试…`,
          raw,
          { phase: 'bootstrap', index: i + 1, total: n }
        );
        try {
          fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        attempt += 1;
      }
    }
    await postCloneProgress(
      cloudPrefix,
      accessToken,
      100,
      `项目克隆 (${i + 1}/${n}) 完成 ${path.basename(repoDir)}`,
      raw,
      { phase: 'bootstrap', index: i + 1, total: n, recv_progress: 100, unpack_progress: 100 }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    cleanup();
  }
}

async function bootstrapGitExec(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(gitCmd(), args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (c) => {
      out += c.toString();
    });
    proc.stderr?.on('data', (c) => {
      err += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out + err);
      else reject(new Error((err || out || `git exit ${code}`).slice(-4000)));
    });
  });
}

/**
 * 规划 bootstrap 克隆落点：顶层仓直接 final；nested 先 staging，完成后移入父仓 path。
 * @param {string} layerDir
 * @param {{ url: string, cloneAlias?: string, parentRepoUrl?: string }[]} jobsIn
 */
export function planBootstrapCloneJobs(layerDir, jobsIn) {
  const stagingRoot = path.join(layerDir, '.bootstrap-staging');
  /** @type {{ raw: string, repoDir: string, finalDir: string, needsRelocate: boolean, parentRepoUrl: string, index: number, requireParentDir: boolean }[]} */
  const jobs = [];
  const reservedTopNames = new Set();
  /** @type {Map<string, string>} */
  const parentTopDirByKey = new Map();

  for (let i = 0; i < jobsIn.length; i++) {
    const raw = String(jobsIn[i]?.url || '').trim();
    const cloneAlias = String(jobsIn[i]?.cloneAlias || jobsIn[i]?.clone_alias || '').trim();
    const parentRepoUrl = String(jobsIn[i]?.parentRepoUrl || jobsIn[i]?.parent_repo_url || '').trim();
    if (!raw || parentRepoUrl) continue;
    let name = resolveRepoCloneDirName(raw, cloneAlias);
    let suf = 2;
    let repoDir = path.join(layerDir, name);
    while (fs.existsSync(repoDir) || reservedTopNames.has(path.basename(repoDir))) {
      repoDir = path.join(layerDir, `${name}_${suf}`);
      suf += 1;
    }
    reservedTopNames.add(path.basename(repoDir));
    parentTopDirByKey.set(canonicalRepoUrlKey(raw), path.basename(repoDir));
    jobs.push({
      raw,
      repoDir,
      finalDir: repoDir,
      needsRelocate: false,
      parentRepoUrl: '',
      index: i,
      requireParentDir: false,
    });
  }

  for (let i = 0; i < jobsIn.length; i++) {
    const raw = String(jobsIn[i]?.url || '').trim();
    const cloneAlias = String(jobsIn[i]?.cloneAlias || jobsIn[i]?.clone_alias || '').trim();
    const parentRepoUrl = String(jobsIn[i]?.parentRepoUrl || jobsIn[i]?.parent_repo_url || '').trim();
    if (!raw || !parentRepoUrl) continue;
    const parentTop = parentTopDirByKey.get(canonicalRepoUrlKey(parentRepoUrl)) || '';
    const rel =
      sanitizeCloneRelPath(cloneAlias) ||
      resolveRepoCloneRelPath(raw, cloneAlias) ||
      resolveRepoCloneDirName(raw, '');
    const stagingName = `${i}-${resolveRepoCloneDirName(raw, path.basename(rel) || cloneAlias || 'repo')}`;
    const stagingDir = path.join(stagingRoot, stagingName);
    const finalDir = parentTop
      ? path.join(layerDir, parentTop, ...String(rel).split('/').filter(Boolean))
      : path.join(layerDir, ...String(rel).split('/').filter(Boolean));
    jobs.push({
      raw,
      repoDir: stagingDir,
      finalDir,
      needsRelocate: true,
      parentRepoUrl,
      index: i,
      requireParentDir: Boolean(parentTop),
    });
  }

  jobs.sort((a, b) => a.index - b.index);
  return { jobs, stagingRoot };
}

/**
 * @param {string[] | { url: string, cloneAlias?: string, parentRepoUrl?: string }[]} urlsOrJobs
 */
async function cloneReposIntoSharedLayer(urlsOrJobs, credRoot, cloudPrefix, accessToken, branchPlans) {
  const jobsIn = (Array.isArray(urlsOrJobs) ? urlsOrJobs : [])
    .map((item) => {
      if (typeof item === 'string') {
        return { url: String(item || '').trim(), cloneAlias: '', parentRepoUrl: '' };
      }
      if (item && typeof item === 'object') {
        return {
          url: String(item.url || item.raw || '').trim(),
          cloneAlias: String(item.cloneAlias || item.clone_alias || '').trim(),
          parentRepoUrl: String(item.parentRepoUrl || item.parent_repo_url || '').trim(),
        };
      }
      return { url: '', cloneAlias: '', parentRepoUrl: '' };
    })
    .filter((j) => j.url);
  if (!jobsIn.length) return null;

  /** 与 `ensureStartupEmptyLayer()` 同 id，避免引导克隆层与空层锚点目录并列。 */
  const layerId = startupEmptyLayerId || newLayerId();
  createRootLayer(layerId);
  writeLayerMeta(layerId, 'clone', null);
  clearCloneLayerLog(layerId);
  /** 须在首条日志写入前赋值：克隆可能持续数分钟，期间 GET /api/repos/bootstrap-clone-log 与 /api/project/active 依赖此 id。 */
  bootstrapCloneLayerId = layerId;

  const layerDir = layerPath(layerId);
  const { jobs, stagingRoot } = planBootstrapCloneJobs(layerDir, jobsIn);
  const n = jobsIn.length;

  try {
    bootstrapRepoLogState = {
      layerId,
      preamble: '【项目克隆】正在并行克隆任务关联仓库（任务详情已拉取）…\n\n',
      jobs: jobs.slice(),
      bufs: new Map(),
    };
    for (const job of jobs) {
      const destLabel = job.needsRelocate
        ? `${path.relative(layerDir, job.finalDir)} (via staging)`
        : path.relative(layerDir, job.finalDir) || path.basename(job.repoDir);
      bootstrapRepoLogState.bufs.set(job.raw, {
        header: `━━ (${job.index + 1}/${n}) ${job.raw}\n→ ${destLabel}\n`,
        body: '',
      });
    }

    await postCloneProgress(cloudPrefix, accessToken, 0, '【项目克隆】开始并行克隆任务关联仓库…', null, {
      kind: 'global',
      phase: 'bootstrap',
    });

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      await postCloneProgress(
        cloudPrefix,
        accessToken,
        0,
        `【项目克隆】(${i + 1}/${n}) 准备克隆 ${path.basename(job.repoDir)}…`,
        job.raw,
        { phase: 'bootstrap', index: i + 1, total: n }
      );
    }

    const concurrency = bootstrapCloneConcurrencyFromEnv();
    appendCloneLayerLog(
      layerId,
      `【项目克隆】并行克隆 ${n} 个仓库，并发上限 ${concurrency}\n`,
    );
    const cloneFactories = jobs.map(
      (job) => () =>
        runOneBootstrapClone({
          job,
          n,
          credRoot,
          cloudPrefix,
          accessToken,
        }),
    );
    const outcomes = await mapPool(cloneFactories, concurrency);
    const errors = [];
    /** @type {{ raw: string, repoDir: string, index: number, errMsg: string }[]} */
    const failedJobs = [];
    for (let idx = 0; idx < jobs.length; idx++) {
      const o = outcomes[idx];
      if (o.ok) continue;
      errors.push(o.err);
      const job = jobs[idx];
      const msg = o.err?.message || String(o.err);
      failedJobs.push({ raw: job.raw, repoDir: job.repoDir, index: job.index, errMsg: msg });
      const ent = bootstrapRepoLogState.bufs.get(job.raw);
      if (ent) {
        ent.failNote = `\n[bootstrap-clone] 克隆失败: ${msg}\n`;
      }
      const repoName = path.basename(job.finalDir || job.repoDir);
      await postCloneProgress(
        cloudPrefix,
        accessToken,
        0,
        `【项目克隆】(${idx + 1}/${n}) 失败 ${repoName}: ${msg.slice(0, 500)}`,
        job.raw,
        { phase: 'bootstrap', index: idx + 1, total: n }
      );
    }

    // Nested: move successful staging clones under the parent tree before work-branch checkout.
    for (let idx = 0; idx < jobs.length; idx++) {
      const job = jobs[idx];
      const o = outcomes[idx];
      if (!o?.ok || !job.needsRelocate) continue;
      if (job.requireParentDir) {
        const relParts = path.relative(layerDir, job.finalDir).split(path.sep).filter(Boolean);
        const parentTop = relParts.length ? path.join(layerDir, relParts[0]) : '';
        if (!parentTop || !fs.existsSync(parentTop)) {
          const ent = bootstrapRepoLogState.bufs.get(job.raw);
          if (ent) {
            ent.failNote = `${ent.failNote || ''}\n[bootstrap-clone] 父仓目录不存在，跳过移入 ${path.relative(layerDir, job.finalDir)}\n`;
          }
          continue;
        }
      }
      try {
        relocateClonedRepo(job.repoDir, job.finalDir);
        job.repoDir = job.finalDir;
        const ent = bootstrapRepoLogState.bufs.get(job.raw);
        if (ent) {
          ent.body += `\n[bootstrap-clone] 已移入 ${path.relative(layerDir, job.finalDir)}\n`;
        }
        await postCloneProgress(
          cloudPrefix,
          accessToken,
          100,
          `【项目克隆】(${job.index + 1}/${n}) 已移入 ${path.relative(layerDir, job.finalDir)}`,
          job.raw,
          { phase: 'bootstrap', index: job.index + 1, total: n },
        );
      } catch (relErr) {
        const msg = relErr instanceof Error ? relErr.message : String(relErr);
        errors.push(relErr instanceof Error ? relErr : new Error(msg));
        failedJobs.push({ raw: job.raw, repoDir: job.repoDir, index: job.index, errMsg: msg });
        const ent = bootstrapRepoLogState.bufs.get(job.raw);
        if (ent) {
          ent.failNote = `\n[bootstrap-clone] 移入失败: ${msg}\n`;
        }
      }
    }
    try {
      if (fs.existsSync(stagingRoot)) {
        const left = fs.readdirSync(stagingRoot);
        if (!left.length) fs.rmSync(stagingRoot, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }

    const footer = errors.length
      ? formatBootstrapCloneFailureFooter(failedJobs)
      : '\n【项目克隆】克隆完成。\n';
    const full = rebuildBootstrapParallelLogText() + footer;
    clearCloneLayerLog(layerId);
    appendCloneLayerLog(layerId, full);
    finalizeCloneLayerLog(layerId);
    bootstrapRepoLogState = null;

    const nameList = failedJobs.map((j) => path.basename(j.finalDir || j.repoDir)).join('、');
    const clonePolicy = resolveBootstrapCloneFailurePolicy({
      failedCount: failedJobs.length,
      totalCount: n,
      failedNames: nameList,
    });
    await postCloneProgress(
      cloudPrefix,
      accessToken,
      clonePolicy.level === 'ok' ? 100 : 0,
      clonePolicy.progressMessage,
      null,
      { kind: 'global', phase: 'bootstrap' },
    );
    if (clonePolicy.level === 'partial') {
      console.warn(
        `[onlineServiceJS] BOOTSTRAP_PHASE=clone_partial_failure failed=${failedJobs.length}/${n} continuing bootstrap (feature-params / BOOTSTRAP_COMPLETE)`,
      );
    }
    // 单仓失败不 abort：保持 HTTP 服务与业务端点就绪；失败仓可 reclone。

    const plans = branchPlans && typeof branchPlans === 'object' ? branchPlans : collectRepoBranchPlans({});
    const sharedWork = String(plans.sharedWorkBranch || '').trim();
    const byUrl = plans.byUrl instanceof Map ? plans.byUrl : new Map();
    const checkoutJobs = jobs.filter((j) => {
      try {
        return Boolean(j?.repoDir && fs.existsSync(path.join(j.repoDir, '.git')));
      } catch {
        return false;
      }
    });
    if ((sharedWork || byUrl.size) && checkoutJobs.length) {
      console.log(
        `[onlineServiceJS] BOOTSTRAP_PHASE=work_branch_checkout 开始将 ${checkoutJobs.length} 个仓库切换到工作分支（shared=${sharedWork || '(per-repo)'}）…`,
      );
      const checkoutLogLines = [];
      const checkout = await checkoutWorkBranchesForJobs({
        gitExec: bootstrapGitExec,
        jobs: checkoutJobs,
        plansByUrl: byUrl,
        sharedWorkBranch: sharedWork,
        appendLog: (line) => {
          checkoutLogLines.push(line);
          appendOutboundReqLog(line);
          console.log(`[onlineServiceJS] ${line}`);
        },
      });
      if (checkoutLogLines.length) {
        try {
          appendCloneLayerLog(layerId, `\n【工作分支切换】\n${checkoutLogLines.join('\n')}\n`);
        } catch {
          /* ignore */
        }
      }
      if (!checkout.ok) {
        console.warn(
          `[onlineServiceJS] BOOTSTRAP_PHASE=work_branch_checkout_partial failed=${checkout.errors.length}/${checkoutJobs.length} continuing bootstrap`,
        );
      } else {
        console.log(
          `[onlineServiceJS] BOOTSTRAP_PHASE=work_branch_checkout_done 工作分支切换完成（ok=${checkout.results.filter((r) => r.ok && !r.skipped).length}/${checkoutJobs.length}）`,
        );
      }
    } else if (sharedWork || byUrl.size) {
      console.log(
        '[onlineServiceJS] BOOTSTRAP_PHASE=work_branch_checkout_skip 无已成功克隆的仓库可切换工作分支',
      );
    } else {
      console.log(
        '[onlineServiceJS] BOOTSTRAP_PHASE=work_branch_checkout_skip 任务未配置工作分支，跳过 checkout',
      );
    }

    return layerId;
  } catch (e) {
    if (bootstrapRepoLogState && bootstrapRepoLogState.layerId === layerId) {
      bootstrapRepoLogState = null;
    }
    throw e;
  }
}

/**
 * 任务详情中无关联仓库时：复用 `ensureStartupEmptyLayer()` 已创建的空层锚点目录，写入 `kind=clone`，
 * 与 `GET /api/layers/empty-root` 为同一 `layer_id`，避免与空锚点并行的多余可写层。
 * 首个仓库由后续 `POST /api/repos/clone`（或等价 git clone）写入子层，父层为上述 id。
 */
function createInitialWorkspaceLayer() {
  const layerId = startupEmptyLayerId || ensureStartupEmptyLayer();
  createRootLayer(layerId);
  writeLayerMeta(layerId, 'clone', null);
  appendOutboundReqLog(`bootstrap: initial writable layer (reuse empty-root, no git, await clone) ${layerId}`);
  console.log(`[onlineServiceJS] 已复用空层锚点为初始可写层（无 git，待首次克隆）: ${layerId}`);
  return layerId;
}

/** 换票专用日志：onlineProject_state/logs/tokenRefresh.log，便于与 reqLogs/outbound.log 区分排查 */
function appendTokenRefreshLog(line) {
  try {
    fs.appendFileSync(path.join(logsDir(), 'tokenRefresh.log'), `${new Date().toISOString()} | ${line}\n`);
  } catch {
    /* ignore */
  }
}

/** 换票调试：不落库明文，仅长度等摘要。 */
function summarizeSecret(value) {
  const s = String(value || '');
  if (!s) return '(empty)';
  return `len=${s.length}`;
}

function logTokenExchange(line) {
  const msg = `token-exchange: ${line}`;
  appendOutboundReqLog(msg);
  appendTokenRefreshLog(msg);
  console.log(`[onlineServiceJS] ${msg}`);
}

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

function bootstrapStructuredPayload(errLike) {
  const direct = errLike && typeof errLike === 'object' ? errLike.structuredPayload : null;
  if (direct && typeof direct === 'object') return direct;
  return parseStructuredPayloadFromErrorMessage(errLike);
}

function summarizeMissingRepoCredentials(payload) {
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
  await staggerBootstrapSaasCall();
  appendOutboundReqLog('bootstrap post-listen: repo-clone-credentials');
  console.log('[onlineServiceJS] 开始拉取仓库克隆凭证…');
  const credResp = await postJson(
    `${prefix}/server-container-token/repo-clone-credentials/`,
    { access_token: accessToken },
    timeoutSec
  );
  const credRoot =
    credResp && typeof credResp.repo_clone_credentials === 'object'
      ? credResp.repo_clone_credentials
      : {};
  return { urls, cloneJobs, credRoot, detail, branchPlans };
}

function bootstrapTimeoutSec() {
  return Math.max(1, parseFloat(process.env.TASK_API_BOOTSTRAP_TIMEOUT_SEC || '15') || 15);
}

function tokenExchangeTimeoutSec() {
  const raw = String(process.env.TASK_API_TOKEN_EXCHANGE_TIMEOUT_SEC || '').trim();
  if (!raw) return bootstrapTimeoutSec();
  return Math.max(1, parseFloat(raw) || 15);
}

function isAbortError(e) {
  const name = String(e?.name || '').trim();
  const msg = String(e?.message || e || '');
  return name === 'AbortError' || /aborted/i.test(msg);
}

async function sleepMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function bootstrapSaasStaggerMs() {
  const raw = String(process.env.TASK_API_BOOTSTRAP_SAAS_STAGGER_MS || '200').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

/** 启动风暴缓解：连续 SaaS inbound 请求之间插入短间隔，降低 SQLite 写重叠概率。 */
async function staggerBootstrapSaasCall() {
  const ms = bootstrapSaasStaggerMs();
  if (ms > 0) await sleepMs(ms);
}

async function postJsonWithAbortRetry(url, body, timeoutSec, tag) {
  const maxAttempts = Math.max(1, parseInt(String(process.env.TASK_API_TOKEN_EXCHANGE_RETRIES || '2'), 10) || 2);
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        logTokenExchange(`${tag}: retry attempt=${attempt}/${maxAttempts} timeout_sec=${timeoutSec}`);
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

function bootstrapTaskIdForTokenStore() {
  return String(process.env.taskId || process.env.TASK_ID || '').trim();
}

/**
 * 换票 HTTP 已成功，但本地 refresh/access 落盘失败。
 * 与 TOKEN_ACCESS_INVALID（令牌本身无效）区分，避免误判为需重新签发 access。
 */
export class PersistedRefreshTokenStoreError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, storePath?: string }} [opts]
   */
  constructor(message, opts = {}) {
    const cause = opts.cause;
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PersistedRefreshTokenStoreError';
    /** @type {'TOKEN_PERSIST_FAILED'} */
    this.code = 'TOKEN_PERSIST_FAILED';
    this.storePath = String(opts.storePath || '').trim();
  }
}

/** @param {unknown} e */
export function isPersistedRefreshTokenStoreError(e) {
  return (
    e instanceof PersistedRefreshTokenStoreError ||
    (Boolean(e) && typeof e === 'object' && e.code === 'TOKEN_PERSIST_FAILED')
  );
}

export function containerRefreshTokenStorePath() {
  return path.join(runtimeDir(), 'container_refresh_token.json');
}

export function readPersistedRefreshToken() {
  const fromEnv = String(process.env.CONTAINER_REFRESH_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const storePath = containerRefreshTokenStorePath();
  if (!fs.existsSync(storePath)) return '';
  try {
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const taskId = bootstrapTaskIdForTokenStore();
    const storedTask = String(data.task_id || '').trim();
    if (taskId && storedTask && taskId !== storedTask) return '';
    return String(data.refresh_token || '').trim();
  } catch {
    return '';
  }
}

/**
 * 落盘容器换票结果，供 go_relayToTrae 在子进程换票后同步 status-push state
 *（与云主机路径一致：首次 exchange 由 onlineServiceJS 完成）。
 * @param {{ refreshToken: string, accessToken?: string, expiresAt?: string } | string} tokens
 * @returns {string | undefined} 写入路径；refresh 为空时不写盘并返回 undefined
 * @throws {PersistedRefreshTokenStoreError} 落盘失败（非令牌无效）
 */
export function writePersistedRefreshToken(tokens) {
  const refreshToken = String(
    typeof tokens === 'string' ? tokens : tokens?.refreshToken || '',
  ).trim();
  if (!refreshToken) return undefined;
  const accessToken = String(
    typeof tokens === 'string' ? '' : tokens?.accessToken || '',
  ).trim();
  const expiresAt = String(typeof tokens === 'string' ? '' : tokens?.expiresAt || '').trim();
  const payload = {
    task_id: bootstrapTaskIdForTokenStore(),
    refresh_token: refreshToken,
    updated_at: new Date().toISOString(),
  };
  if (accessToken) payload.access_token = accessToken;
  if (expiresAt) payload.expires_at = expiresAt;
  let storePath = '';
  try {
    storePath = containerRefreshTokenStorePath();
    fs.writeFileSync(storePath, `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      // 0644：selected_image 下 state 目录 bind-mount 到宿主机时，go_relay 需可读以同步 token。
      // 路径仍在 ONLINE_PROJECT_STATE_ROOT 私有目录下，不扩大到世界可读的通用位置。
      mode: 0o644,
    });
  } catch (e) {
    if (isPersistedRefreshTokenStoreError(e)) throw e;
    const causeMsg = e && e.message ? String(e.message) : String(e);
    throw new PersistedRefreshTokenStoreError(
      `token-persist: FAIL write ${storePath || 'container_refresh_token.json'}: ${causeMsg}`,
      { cause: e, storePath },
    );
  }
  return storePath;
}

export function clearPersistedRefreshToken() {
  try {
    fs.unlinkSync(containerRefreshTokenStorePath());
  } catch {
    /* ignore missing file / already cleared */
  }
}

/** exchange-refresh 返回 403：库中已有 refresh，须改走 refresh-access。 */
export function isExchangeRefreshForbiddenError(e) {
  const msg = String(e?.message || e || '');
  return /HTTP\s+403\b/i.test(msg) && /refresh-access/i.test(msg);
}

/**
 * 换票失败日志行：落盘失败用 FAIL_PERSIST + TOKEN_PERSIST_FAILED，与普通 FAIL（含令牌无效）区分。
 * @param {unknown} e
 */
export function formatTokenExchangeFailureLog(e) {
  const detail = e && typeof e === 'object' && e.message != null ? String(e.message) : String(e);
  const persistFail = isPersistedRefreshTokenStoreError(e);
  const tag = persistFail ? 'FAIL_PERSIST' : 'FAIL';
  const code =
    persistFail && e && typeof e === 'object' && e.code ? String(e.code) : 'TOKEN_PERSIST_FAILED';
  const codeHint = persistFail ? ` error_code=${code}` : '';
  return `token-exchange: ${tag}${codeHint} ${detail}`;
}

async function runRefreshAccessOnly(prefix, refreshToken, tokenTimeout) {
  const rt = String(refreshToken || '').trim();
  if (!rt) throw new Error('refresh-access: empty refresh_token');
  logTokenExchange(
    `POST ${prefix}/server-container-token/refresh-access/ refresh_token ${summarizeSecret(rt)}`,
  );
  const ref = await postJsonWithAbortRetry(
    `${prefix}/server-container-token/refresh-access/`,
    { refresh_token: rt },
    tokenTimeout,
    'refresh-access',
  );
  const at = ref.access_token;
  if (!at || typeof at !== 'string') throw new Error('refresh-access missing access_token');
  const prevAccess = String(process.env.ACCESS_TOKEN || '').trim();
  if (prevAccess && prevAccess !== at) {
    rememberStaleAccessToken(prevAccess);
  }
  process.env.ACCESS_TOKEN = at;
  const expiresAt = String(ref.expires_at || '').trim();
  logTokenExchange(
    `refresh-access OK new_access_token ${summarizeSecret(at)} ACCESS_TOKEN env updated`,
  );
  return { accessToken: at, expiresAt };
}

/**
 * HTTP 监听前：解析 TaskApi 前缀并完成换票（若需要）。
 * 任务详情拉取、仓库克隆、service_config.yaml 写入在 {@link runBootstrapAfterListen}（由 `server.mjs`
 * 在 register-reachability 与 SaaS 心跳启动之后异步执行，避免克隆阻塞 `server_url` 与心跳）。
 */
export async function runBootstrapTokenExchangeOnly() {
  bootstrapCloneLayerId = null;
  bootstrapRepoLogState = null;
  bootstrapRegisterCloneJob = false;
  let prefix;
  try {
    prefix = taskApiPrefix();
  } catch (e) {
    const skipLine = `bootstrap skip: ${e.message}`;
    appendOutboundReqLog(skipLine);
    appendTokenRefreshLog(skipLine);
    return { skipped: true };
  }
  if (!prefix) {
    const skipLine = 'bootstrap skip: empty task API prefix';
    appendOutboundReqLog(skipLine);
    appendTokenRefreshLog(skipLine);
    return { skipped: true };
  }

  const timeout = bootstrapTimeoutSec();
  const tokenTimeout = tokenExchangeTimeoutSec();
  let business;
  try {
    business = businessApiEndpoint();
  } catch (e) {
    const line = `bootstrap: business API endpoint: ${e && e.message ? String(e.message) : String(e)}`;
    appendOutboundReqLog(line);
    appendTokenRefreshLog(line);
    throw e;
  }
  let newAccess = String(process.env.ACCESS_TOKEN || '').trim();
  if (!newAccess) {
    const failLine = 'token-exchange: FAIL ACCESS_TOKEN empty for bootstrap';
    appendTokenRefreshLog(failLine);
    throw new Error('ACCESS_TOKEN empty for bootstrap');
  }

  logTokenExchange(
    `begin prefix=${prefix} timeout_sec=${timeout} token_timeout_sec=${tokenTimeout} business_api_endpoint=${business} initial_access_token ${summarizeSecret(newAccess)}`,
  );

  if (!skipContainerTokenExchangeByEnv()) {
    try {
      let refreshToken = '';
      try {
        logTokenExchange(`POST ${prefix}/server-container-token/exchange-refresh/`);
        const ex = await postJsonWithAbortRetry(
          `${prefix}/server-container-token/exchange-refresh/`,
          { access_token: newAccess, business_api_endpoint: business },
          tokenTimeout,
          'exchange-refresh',
        );
        refreshToken = ex.refresh_token;
        if (!refreshToken) throw new Error('exchange-refresh missing refresh_token');
        logTokenExchange(`exchange-refresh OK refresh_token ${summarizeSecret(refreshToken)}`);
        writePersistedRefreshToken({ refreshToken });
      } catch (e) {
        if (!isExchangeRefreshForbiddenError(e)) {
          throw e;
        }
        refreshToken = readPersistedRefreshToken();
        if (!refreshToken) {
          logTokenExchange(
            'exchange-refresh 403 and no persisted refresh_token; run env-prepare / 重新生成令牌 before start',
          );
          throw e;
        }
        logTokenExchange(
          'exchange-refresh 403: fallback to refresh-access using persisted refresh_token',
        );
        const fb = await runRefreshAccessOnly(prefix, refreshToken, tokenTimeout);
        newAccess = fb.accessToken;
        writePersistedRefreshToken({
          refreshToken,
          accessToken: newAccess,
          expiresAt: fb.expiresAt,
        });
        logTokenExchange('done (refresh-access fallback)');
        return { skipped: false, prefix, newAccess, timeout };
      }

      const refreshed = await runRefreshAccessOnly(prefix, refreshToken, tokenTimeout);
      newAccess = refreshed.accessToken;
      writePersistedRefreshToken({
        refreshToken,
        accessToken: newAccess,
        expiresAt: refreshed.expiresAt,
      });
      logTokenExchange('done');
    } catch (e) {
      const failLine = formatTokenExchangeFailureLog(e);
      appendOutboundReqLog(failLine);
      appendTokenRefreshLog(failLine);
      const tag = isPersistedRefreshTokenStoreError(e) ? 'FAIL_PERSIST' : 'FAIL';
      console.error(`[onlineServiceJS] token-exchange: ${tag}`, e);
      throw e;
    }
  } else {
    const skipExLine = 'bootstrap: skip exchange (TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE)';
    appendOutboundReqLog(skipExLine);
    appendTokenRefreshLog(skipExLine);
    logTokenExchange('skipped (TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE), using initial ACCESS_TOKEN as-is');
  }

  return { skipped: false, prefix, newAccess, timeout };
}

/**
 * 将 feature-params-env 映射写入进程环境，供后续子进程（trae-cli / bash）继承。
 * 空键跳过；值统一转为字符串。
 * @param {Record<string, unknown>} envMap
 * @param {NodeJS.ProcessEnv} [targetEnv]
 * @returns {string[]} 实际写入的键名（已排序）
 */
export function applyFeatureParamsEnvToProcess(envMap, targetEnv = process.env) {
  const applied = [];
  if (envMap == null || typeof envMap !== 'object') {
    return applied;
  }
  for (const [rawKey, value] of Object.entries(envMap)) {
    const key = String(rawKey ?? '').trim();
    if (!key) continue;
    targetEnv[key] = String(value ?? '');
    applied.push(key);
  }
  return applied.sort();
}

/**
 * 将 feature-params-env 响应写入进程环境、落盘为 service_config.yaml，并写入/打印 env 快照日志。
 * @param {Record<string, unknown>} envMap
 * @param {{
 *   appendEnvLog?: typeof appendFeatureParamsEnvLogBestEffort,
 *   resolveConfig?: typeof resolveAgentConfigFromEnv,
 *   configPath?: () => string,
 *   writeFile?: typeof fs.writeFileSync,
 *   mkdirSync?: typeof fs.mkdirSync,
 *   parseYaml?: typeof YAML.parse,
 *   logError?: (...args: unknown[]) => void,
 *   applyToProcess?: typeof applyFeatureParamsEnvToProcess,
 *   processEnv?: NodeJS.ProcessEnv,
 * }} [deps]
 * @returns {string} 写入的配置文件路径
 */
export function persistFeatureParamsEnv(envMap, deps = {}) {
  const appendEnvLog = deps.appendEnvLog || appendFeatureParamsEnvLogBestEffort;
  const resolveConfig = deps.resolveConfig || resolveAgentConfigFromEnv;
  const configPath = deps.configPath || configFilePath;
  const writeFile = deps.writeFile || fs.writeFileSync;
  const mkdir = deps.mkdirSync || fs.mkdirSync.bind(fs);
  const parseYaml = deps.parseYaml || YAML.parse.bind(YAML);
  const logError = deps.logError || console.error.bind(console);
  const applyToProcess = deps.applyToProcess || applyFeatureParamsEnvToProcess;
  const processEnv = deps.processEnv || process.env;

  if (envMap == null || typeof envMap !== 'object') {
    throw new Error('feature-params-env missing env');
  }
  if (envMap.TASK_AGENT_MAX_STEPS == null) {
    throw new Error('feature-params-env missing TASK_AGENT_MAX_STEPS');
  }

  const appliedKeys = applyToProcess(envMap, processEnv);
  appendOutboundReqLog(
    `bootstrap: applied feature-params-env to process.env keys=${appliedKeys.join(',') || '(none)'}`,
  );

  const envLogResult = appendEnvLog({ envMapping: envMap });
  if (envLogResult && envLogResult.ok === false) {
    logError('[onlineServiceJS] feature-params-env.log append error:', envLogResult.error);
  }
  appendOutboundReqLog(
    `bootstrap: feature-params-env keys=${Object.keys(envMap).sort().join(',')}`,
  );

  const yamlText = resolveConfig(envMap);
  parseYaml(yamlText);
  const dest = configPath();
  mkdir(path.dirname(dest), { recursive: true });
  writeFile(dest, yamlText, 'utf8');
  appendOutboundReqLog(`bootstrap: wrote ${dest}`);
  return dest;
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
  const timeoutSec = timeout;

  // 稳定标记供前端启动日志检索；勿改前缀，面板会高亮 BOOTSTRAP_* 行。
  console.log('[onlineServiceJS] BOOTSTRAP_PHASE=task_detail_begin 容器已启动，开始拉取任务详情…');
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
    lastBootstrapTaskDetail = repoInputs.detail || null;
  } catch (e) {
    const wrapped =
      String(e?.message || '').includes('/server-container-token/repo-clone-credentials/')
      || String(e?.message || '').includes('REPO_CLONE_CREDENTIALS_INCOMPLETE')
        ? buildRepoCloneCredentialsBootstrapError(e)
        : e instanceof Error
          ? e
          : new Error(String(e || 'task-detail failed'));
    console.error(
      `[onlineServiceJS] BOOTSTRAP_FAILED phase=task_detail_or_credentials ${String(wrapped?.message || wrapped).slice(0, 500)}`,
    );
    throw wrapped;
  }
  if (urls.length) {
    console.log('[onlineServiceJS] BOOTSTRAP_PHASE=clone_begin 任务详情已就绪，开始项目克隆…');
    try {
      bootstrapCloneLayerId = await cloneReposIntoSharedLayer(
        cloneJobs,
        credRoot,
        prefix,
        newAccess,
        branchPlans,
      );
    } catch (e) {
      console.error(
        `[onlineServiceJS] BOOTSTRAP_FAILED phase=clone ${String(e?.message || e).slice(0, 500)}`,
      );
      throw e;
    }
    bootstrapRegisterCloneJob = true;
  } else {
    appendOutboundReqLog('bootstrap: no repo urls in task-detail');
    bootstrapCloneLayerId = createInitialWorkspaceLayer();
    bootstrapRegisterCloneJob = false;
  }

  await staggerBootstrapSaasCall();
  appendOutboundReqLog('bootstrap post-listen: feature-params-env');
  console.log('[onlineServiceJS] BOOTSTRAP_PHASE=feature_params_begin 开始拉取 feature-params-env…');
  let y;
  try {
    y = await postJson(
      `${prefix}/server-container-token/feature-params-env/`,
      { access_token: newAccess },
      timeoutSec
    );
  } catch (e) {
    console.error(
      `[onlineServiceJS] BOOTSTRAP_FAILED phase=feature_params_env ${String(e?.message || e).slice(0, 500)}`,
    );
    throw e;
  }
  persistFeatureParamsEnv(y.env);
  console.log(
    '[onlineServiceJS] BOOTSTRAP_COMPLETE 任务引导完成（详情已拉取、克隆与配置已就绪）。',
  );
}

/** 顺序执行换票 + 详情/克隆/配置（单测或无需分离 listen 的场景）。 */
export async function runBootstrap() {
  const ctx = await runBootstrapTokenExchangeOnly();
  if (ctx.skipped) return;
  await runBootstrapAfterListen(ctx);
}

export function ensureStartupEmptyLayer() {
  const root = layersRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(root).sort()) {
    if (!LAYER_ID_RE.test(name)) continue;
    const m = readLayerMeta(name);
    if (m && m.kind === 'empty') {
      startupEmptyLayerId = name;
      return name;
    }
  }
  const id = newLayerId();
  createEmptyLayer(id);
  startupEmptyLayerId = id;
  return id;
}
