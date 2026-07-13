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
  layerPrimaryGitWorkdir,
} from './layerFs.mjs';
import { runLayerOauthRefreshPush } from './layerGitOauthRefreshPush.mjs';

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
      log.warn?.('[onlineServiceJS] AUTO_RUN_FIRST_SKIP reason=empty_title_and_description');
      console.warn('[onlineServiceJS] AUTO_RUN_FIRST_SKIP reason=empty_title_and_description');
    } else if (autoRun && markerExists) {
      console.log('[onlineServiceJS] AUTO_RUN_FIRST_SKIP reason=marker_exists');
    } else if (autoRun && !layerId) {
      console.warn('[onlineServiceJS] AUTO_RUN_FIRST_SKIP reason=no_layer_id');
    }
    return null;
  }

  console.log(
    `[onlineServiceJS] AUTO_RUN_FIRST_INSTRUCTION_START layer_id=${layerId} command_len=${command.length}`,
  );
  const rec = await createJobFn({
    command,
    command_kind: 'trae',
    repo_layer_id: layerId,
    auto_run_first: true,
    auto_run_commit_message: String(title || '').trim() || 'auto_run',
  });
  writeAutoRunFirstJobMarker(rec?.id, fsApi);
  console.log(
    `[onlineServiceJS] AUTO_RUN_FIRST_INSTRUCTION_STARTED job_id=${String(rec?.id || '')} layer_id=${String(rec?.layer_id || '')}`,
  );
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
 * 层内全部 git 工作区 stage + commit；无变更时返回 skipped。
 */
export async function commitLayerChanges(layerId, message, deps = {}) {
  const lid = String(layerId || '').trim();
  const msg = String(message || '').trim() || 'auto_run';
  const rootsFn = deps.layerGitWorkdirRootsForFileListing || layerGitWorkdirRootsForFileListing;
  const primaryFn = deps.layerPrimaryGitWorkdir || layerPrimaryGitWorkdir;
  const execGit = deps.gitExec || gitExecAsync;

  const roots = rootsFn(lid);
  const workdirs = roots.length
    ? roots.map((r) => r.workdir)
    : (() => {
        const w = primaryFn(lid);
        return w ? [w] : [];
      })();

  if (!workdirs.length) {
    return { ok: false, skipped: true, detail: 'no git workdir' };
  }

  let committed = 0;
  let skippedNothing = 0;
  for (const work of workdirs) {
    try {
      await execGit(['add', '-A'], work);
      await execGit(['commit', '-m', msg], work);
      committed += 1;
    } catch (e) {
      const detail = String(e?.message || e);
      if (/nothing to commit/i.test(detail) || /no changes added/i.test(detail)) {
        skippedNothing += 1;
        continue;
      }
      throw e;
    }
  }
  return {
    ok: true,
    committed,
    skipped_nothing: skippedNothing,
    skipped: committed === 0 && skippedNothing > 0,
  };
}

/**
 * 首指令成功后的交付：身份 → commit → oauth-refresh-push（含 PR）。
 */
export async function runAutoRunDelivery(opts) {
  const layerId = String(opts?.layerId || '').trim();
  const fsApi = opts?.fsApi || fs;
  const pushFn = opts?.runLayerOauthRefreshPush || runLayerOauthRefreshPush;
  const syncFn = opts?.syncRepoIdentitiesToLayer || syncRepoIdentitiesToLayer;
  const commitFn = opts?.commitLayerChanges || commitLayerChanges;

  if (!layerId) {
    console.warn('[onlineServiceJS] AUTO_RUN_DELIVERY_FAILED reason=no_layer_id');
    return { ok: false, detail: 'layer_id required' };
  }
  if (hasAutoRunDeliveryDone(fsApi)) {
    console.log(`[onlineServiceJS] AUTO_RUN_DELIVERY_SKIP reason=done_marker layer_id=${layerId}`);
    return { ok: true, skipped: true, reason: 'done_marker' };
  }

  console.log(`[onlineServiceJS] AUTO_RUN_DELIVERY_BEGIN layer_id=${layerId}`);
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
    const pushOk = httpStatus >= 200 && httpStatus < 300 && pushResult?.payload?.ok !== false;
    writeAutoRunDeliveryDone(
      {
        layer_id: layerId,
        commit: commitResult,
        push_http_status: httpStatus,
        push_ok: pushOk,
      },
      fsApi,
    );
    if (!pushOk) {
      console.warn(
        `[onlineServiceJS] AUTO_RUN_DELIVERY_FAILED layer_id=${layerId} phase=push http_status=${httpStatus} detail=${String(pushResult?.payload?.detail || '').slice(0, 240)}`,
      );
      return { ok: false, commitResult, pushResult };
    }
    console.log(`[onlineServiceJS] AUTO_RUN_DELIVERY_COMPLETE layer_id=${layerId}`);
    return { ok: true, commitResult, pushResult };
  } catch (e) {
    console.error(
      `[onlineServiceJS] AUTO_RUN_DELIVERY_FAILED layer_id=${layerId} detail=${String(e?.message || e).slice(0, 500)}`,
    );
    // 失败也写 done，避免反复重试风暴；容器重建后标志清空可再试
    writeAutoRunDeliveryDone(
      {
        layer_id: layerId,
        error: String(e?.message || e).slice(0, 500),
      },
      fsApi,
    );
    return { ok: false, detail: String(e?.message || e) };
  }
}
