/**
 * auto_run 首指令与完成后交付编排（容器内闭环）。
 * 契约见 machine_container.md §4.4 与意图 006_auto_run_first_instruction_and_delivery。
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { runtimeDir } from './paths.mjs';
import { gitCmd } from './gitCmd.mjs';
import { repoMatchKeyFromUrl } from './repoMatchKey.mjs';
import {
  layerGitWorkdirRootsForFileListing,
  layerGitRemoteSnapshot,
} from './layerFs.mjs';
import { commitLayerGitWorkdirs } from './layerGitCommit.mjs';
import { runLayerOauthRefreshPush } from './layerGitOauthRefreshPush.mjs';
import { emitRuntimeEvent } from './runtimeEventLog.mjs';

export function composeAutoRunCommand(title, description) {
  const t = String(title || '').trim();
  const d = String(description || '').trim();
  if (!t && !d) return '';
  if (t && d) return `${t}\n\n${d}`;
  return t || d;
}

export function autoRunFirstJobMarkerPath() {
  return path.join(runtimeDir(), 'auto_run_first_job.json');
}

export function autoRunDeliveryDonePath() {
  return path.join(runtimeDir(), 'auto_run_delivery.done');
}

export function hasAutoRunFirstJobMarker(fsApi = fs) {
  try {
    return fsApi.existsSync(autoRunFirstJobMarkerPath());
  } catch {
    return false;
  }
}

export function writeAutoRunFirstJobMarker(jobId, fsApi = fs) {
  const p = autoRunFirstJobMarkerPath();
  fsApi.mkdirSync(path.dirname(p), { recursive: true });
  fsApi.writeFileSync(
    p,
    JSON.stringify({ job_id: String(jobId || ''), at: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

export function hasAutoRunDeliveryDone(fsApi = fs) {
  try {
    return fsApi.existsSync(autoRunDeliveryDonePath());
  } catch {
    return false;
  }
}

export function writeAutoRunDeliveryDone(payload = {}, fsApi = fs) {
  const p = autoRunDeliveryDonePath();
  fsApi.mkdirSync(path.dirname(p), { recursive: true });
  fsApi.writeFileSync(
    p,
    JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

/**
 * 仅当交付已成功（或干净跳过）时跳过；失败态 / push_ok=false 的旧 done 文件允许重试。
 * 契约：设计文档要求「成功或明确跳过（无 diff 且无 ahead）」后才写 done。
 */
export function shouldSkipAutoRunDelivery(fsApi = fs) {
  if (!hasAutoRunDeliveryDone(fsApi)) return false;
  try {
    const raw = JSON.parse(fsApi.readFileSync(autoRunDeliveryDonePath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return false;
    if (raw.error) return false;
    if (raw.push_ok === false) return false;
    if (raw.skipped_clean === true) return true;
    if (raw.push_ok === true) return true;
    const st = Number(raw.push_http_status || 0);
    if (st >= 200 && st < 300) return true;
    // 无法判定的旧文件：为避免风暴仍跳过（新写入必带 push_ok）
    return true;
  } catch {
    return false;
  }
}

export function autoRunDeliveryRetryCountPath() {
  return path.join(runtimeDir(), 'auto_run_delivery.retry');
}

export function readAutoRunDeliveryRetryCount(fsApi = fs) {
  try {
    const n = Number.parseInt(String(fsApi.readFileSync(autoRunDeliveryRetryCountPath(), 'utf8')).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function bumpAutoRunDeliveryRetryCount(fsApi = fs) {
  const next = readAutoRunDeliveryRetryCount(fsApi) + 1;
  const p = autoRunDeliveryRetryCountPath();
  fsApi.mkdirSync(path.dirname(p), { recursive: true });
  fsApi.writeFileSync(p, `${next}\n`, 'utf8');
  return next;
}

export function shouldTriggerAutoRunFirstInstruction({
  autoRun,
  layerId,
  command,
  markerExists,
}) {
  return Boolean(autoRun) && Boolean(String(layerId || '').trim()) && Boolean(String(command || '').trim()) && !markerExists;
}

/**
 * bootstrap 完成后：若 auto_run 则创建首条 trae job（幂等）。
 * @returns {Promise<object|null>} createJob 返回的 rec，或 null（未触发）
 */
export async function maybeStartAutoRunFirstInstruction(opts) {
  const detail = opts?.detail;
  const layerId = String(opts?.layerId || '').trim();
  const createJobFn = opts?.createJobFn;
  const fsApi = opts?.fsApi || fs;
  const log = opts?.log || console;

  if (typeof createJobFn !== 'function') {
    throw new Error('createJobFn required');
  }

  const autoRun = Boolean(detail?.task?.auto_run);
  const title = detail?.task?.title;
  const description = detail?.task?.description;
  const command = composeAutoRunCommand(title, description);
  const markerExists = hasAutoRunFirstJobMarker(fsApi);

  if (!shouldTriggerAutoRunFirstInstruction({ autoRun, layerId, command, markerExists })) {
    if (autoRun && !command) {
      emitRuntimeEvent('AUTO_RUN_FIRST_SKIP', {
        level: 'warn',
        message: 'empty_title_and_description',
        fields: { reason: 'empty_title_and_description' },
        consoleLine: '[onlineServiceJS] AUTO_RUN_FIRST_SKIP reason=empty_title_and_description',
      });
    } else if (autoRun && markerExists) {
      emitRuntimeEvent('AUTO_RUN_FIRST_SKIP', {
        message: 'marker_exists',
        fields: { reason: 'marker_exists' },
        consoleLine: '[onlineServiceJS] AUTO_RUN_FIRST_SKIP reason=marker_exists',
      });
    } else if (autoRun && !layerId) {
      emitRuntimeEvent('AUTO_RUN_FIRST_SKIP', {
        level: 'warn',
        message: 'no_layer_id',
        fields: { reason: 'no_layer_id' },
        consoleLine: '[onlineServiceJS] AUTO_RUN_FIRST_SKIP reason=no_layer_id',
      });
    } else if (!autoRun) {
      emitRuntimeEvent('AUTO_RUN_FIRST_SKIP', {
        message: 'auto_run_false',
        fields: { reason: 'auto_run_false' },
      });
    }
    return null;
  }

  emitRuntimeEvent('AUTO_RUN_FIRST_INSTRUCTION_START', {
    fields: { layer_id: layerId, command_len: command.length },
    consoleLine: `[onlineServiceJS] AUTO_RUN_FIRST_INSTRUCTION_START layer_id=${layerId} command_len=${command.length}`,
  });
  const rec = await createJobFn({
    command,
    command_kind: 'trae',
    repo_layer_id: layerId,
    auto_run_first: true,
    auto_run_commit_message: String(title || '').trim() || 'auto_run',
  });
  writeAutoRunFirstJobMarker(rec?.id, fsApi);
  emitRuntimeEvent('AUTO_RUN_FIRST_INSTRUCTION_STARTED', {
    fields: {
      job_id: String(rec?.id || ''),
      layer_id: String(rec?.layer_id || layerId || ''),
    },
    consoleLine: `[onlineServiceJS] AUTO_RUN_FIRST_INSTRUCTION_STARTED job_id=${String(rec?.id || '')} layer_id=${String(rec?.layer_id || '')}`,
  });
  return rec;
}

function gitExecAsync(args, cwd, env = {}) {
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
 * 将平台下发的 repo_git_identities 写入层内各仓 local user.name / user.email。
 */
export async function syncRepoIdentitiesToLayer(layerId, identities, deps = {}) {
  const lid = String(layerId || '').trim();
  if (!lid) throw new Error('layer_id required');
  const list = Array.isArray(identities) ? identities : [];
  const byKey = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const repoUrl = String(row.repo_url || '').trim();
    const userName = String(row.user_name || '').trim();
    const userEmail = String(row.user_email || '').trim();
    if (!repoUrl || !userName || !userEmail) continue;
    const k = repoMatchKeyFromUrl(repoUrl).toLowerCase();
    if (!k) continue;
    byKey.set(k, { user_name: userName, user_email: userEmail });
  }
  if (byKey.size === 0) {
    console.log(`[onlineServiceJS] AUTO_RUN_DELIVERY identities_skip layer_id=${lid} reason=no_resolved_identities`);
    return { applied_count: 0, results: [] };
  }

  const rootsFn = deps.layerGitWorkdirRootsForFileListing || layerGitWorkdirRootsForFileListing;
  const execGit = deps.gitExec || gitExecAsync;
  const roots = rootsFn(lid);
  const results = [];
  const appliedKeys = new Set();

  for (const { workdir, relPrefix } of roots) {
    const g = path.join(workdir, '.git');
    if (!fs.existsSync(g)) continue;
    let originUrl = '';
    try {
      originUrl = String(await execGit(['config', '--get', 'remote.origin.url'], workdir)).trim().split('\n')[0] || '';
    } catch {
      originUrl = '';
    }
    const key = originUrl ? repoMatchKeyFromUrl(originUrl).toLowerCase() : '';
    if (!key || !byKey.has(key)) continue;
    const spec = byKey.get(key);
    try {
      await execGit(['config', '--local', 'user.name', spec.user_name], workdir);
      await execGit(['config', '--local', 'user.email', spec.user_email], workdir);
      appliedKeys.add(key);
      results.push({ repo_match_key: key, rel_prefix: relPrefix || '', ok: true });
    } catch (e) {
      results.push({
        repo_match_key: key,
        rel_prefix: relPrefix || '',
        ok: false,
        detail: String(e?.message || e),
      });
    }
  }
  console.log(
    `[onlineServiceJS] AUTO_RUN_DELIVERY identities_synced layer_id=${lid} applied=${appliedKeys.size}`,
  );
  return { applied_count: appliedKeys.size, results };
}

/**
 * 层内全部 git 工作区 stage + commit（含嵌套子仓 / nested-repo-heads）；无变更时返回 skipped。
 */
export async function commitLayerChanges(layerId, message, deps = {}) {
  const lid = String(layerId || '').trim();
  const msg = String(message || '').trim() || 'auto_run';
  const commitFn = deps.commitLayerGitWorkdirs || commitLayerGitWorkdirs;

  try {
    const result = commitFn(lid, { message: msg, stage_all: true });
    const n = Array.isArray(result?.committed) ? result.committed.length : 0;
    return { ok: true, committed: n, skipped: n === 0, detail: result };
  } catch (e) {
    const code = e?.code || '';
    const detail = String(e?.message || e);
    if (code === 'NOTHING_TO_COMMIT' || /nothing to commit/i.test(detail)) {
      return { ok: true, committed: 0, skipped: true, detail };
    }
    if (code === 'NO_GIT' || /no git/i.test(detail)) {
      return { ok: false, skipped: true, detail: 'no git workdir' };
    }
    throw e;
  }
}

function layerStillHasPushableCommits(layerId, targetBranch, deps = {}) {
  const snapFn = deps.layerGitRemoteSnapshot || layerGitRemoteSnapshot;
  const tb = String(targetBranch || '').trim();
  const snap = snapFn(layerId, tb ? { compareBranch: tb } : {});
  return typeof snap?.ahead === 'number' && snap.ahead > 0;
}

/**
 * 首指令成功后的交付：身份 → commit → oauth-refresh-push（含 PR）。
 * 成功或「无变更且无 ahead」才写 done；失败可重试（有次数上限）。
 */
export async function runAutoRunDelivery(opts) {
  const layerId = String(opts?.layerId || '').trim();
  const fsApi = opts?.fsApi || fs;
  const pushFn = opts?.runLayerOauthRefreshPush || runLayerOauthRefreshPush;
  const syncFn = opts?.syncRepoIdentitiesToLayer || syncRepoIdentitiesToLayer;
  const commitFn = opts?.commitLayerChanges || commitLayerChanges;
  const maxRetries = Number.isFinite(opts?.maxRetries) ? Number(opts.maxRetries) : 3;

  if (!layerId) {
    emitRuntimeEvent('AUTO_RUN_DELIVERY_FAILED', {
      level: 'warn',
      message: 'no_layer_id',
      fields: { reason: 'no_layer_id' },
      consoleLine: '[onlineServiceJS] AUTO_RUN_DELIVERY_FAILED reason=no_layer_id',
    });
    return { ok: false, detail: 'layer_id required' };
  }
  if (shouldSkipAutoRunDelivery(fsApi)) {
    emitRuntimeEvent('AUTO_RUN_DELIVERY_SKIP', {
      message: 'done_marker',
      fields: { reason: 'done_marker', layer_id: layerId },
      consoleLine: `[onlineServiceJS] AUTO_RUN_DELIVERY_SKIP reason=done_marker layer_id=${layerId}`,
    });
    return { ok: true, skipped: true, reason: 'done_marker' };
  }
  const retries = readAutoRunDeliveryRetryCount(fsApi);
  if (retries >= maxRetries) {
    emitRuntimeEvent('AUTO_RUN_DELIVERY_SKIP', {
      level: 'warn',
      message: 'max_retries',
      fields: { reason: 'max_retries', layer_id: layerId, retries },
      consoleLine: `[onlineServiceJS] AUTO_RUN_DELIVERY_SKIP reason=max_retries layer_id=${layerId} retries=${retries}`,
    });
    return { ok: false, skipped: true, reason: 'max_retries', retries };
  }

  emitRuntimeEvent('AUTO_RUN_DELIVERY_BEGIN', {
    fields: { layer_id: layerId, attempt: retries + 1 },
    consoleLine: `[onlineServiceJS] AUTO_RUN_DELIVERY_BEGIN layer_id=${layerId} attempt=${retries + 1}`,
  });
  try {
    await syncFn(layerId, opts?.identities || []);
    const commitMessage = String(opts?.commitMessage || '').trim() || 'auto_run';
    const commitResult = await commitFn(layerId, commitMessage, opts?.commitDeps);
    const targetBranch = String(opts?.targetBranch || '').trim();
    const pushResult = await pushFn({
      layerId,
      ...(targetBranch ? { targetBranch } : {}),
      traceId: opts?.traceId,
    });
    const httpStatus = Number(pushResult?.httpStatus || 0);
    const detail = String(pushResult?.payload?.detail || '');
    const nothingToPush = /nothing to push/i.test(detail);
    const pushHttpOk = httpStatus >= 200 && httpStatus < 300 && pushResult?.payload?.ok !== false;
    const stillAhead = layerStillHasPushableCommits(layerId, targetBranch, opts?.aheadDeps);
    // 干净跳过：远端无 ahead 且无待推送；若仍 ahead 则视为失败（避免 done 锁死）
    const cleanSkip = nothingToPush && !stillAhead;
    const pushOk = pushHttpOk || cleanSkip;

    if (!pushOk) {
      const n = bumpAutoRunDeliveryRetryCount(fsApi);
      emitRuntimeEvent('AUTO_RUN_DELIVERY_FAILED', {
        level: 'warn',
        phase: 'push',
        message: detail.slice(0, 240) || (stillAhead ? 'still_ahead_after_push' : 'push_failed'),
        fields: {
          layer_id: layerId,
          http_status: httpStatus,
          retries: n,
          still_ahead: stillAhead,
        },
        consoleLine: `[onlineServiceJS] AUTO_RUN_DELIVERY_FAILED layer_id=${layerId} phase=push http_status=${httpStatus} retries=${n} detail=${detail.slice(0, 240)}`,
      });
      return { ok: false, commitResult, pushResult, stillAhead, retries: n };
    }

    writeAutoRunDeliveryDone(
      {
        layer_id: layerId,
        commit: commitResult,
        push_http_status: httpStatus || (cleanSkip ? 200 : httpStatus),
        push_ok: true,
        ...(cleanSkip ? { skipped_clean: true } : {}),
      },
      fsApi,
    );
    emitRuntimeEvent('AUTO_RUN_DELIVERY_COMPLETE', {
      fields: { layer_id: layerId, skipped_clean: Boolean(cleanSkip) },
      consoleLine: `[onlineServiceJS] AUTO_RUN_DELIVERY_COMPLETE layer_id=${layerId}${cleanSkip ? ' skipped_clean=1' : ''}`,
    });
    return { ok: true, commitResult, pushResult, skipped_clean: cleanSkip };
  } catch (e) {
    const n = bumpAutoRunDeliveryRetryCount(fsApi);
    emitRuntimeEvent('AUTO_RUN_DELIVERY_FAILED', {
      level: 'error',
      message: String(e?.message || e).slice(0, 500),
      fields: { layer_id: layerId, retries: n },
      consoleLine: `[onlineServiceJS] AUTO_RUN_DELIVERY_FAILED layer_id=${layerId} retries=${n} detail=${String(e?.message || e).slice(0, 500)}`,
    });
    return { ok: false, detail: String(e?.message || e), retries: n };
  }
}
