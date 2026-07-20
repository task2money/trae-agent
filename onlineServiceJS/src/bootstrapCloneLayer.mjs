import fs from 'fs';
import path from 'path';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import {
  newLayerId,
  createRootLayer,
  layerPath,
  writeLayerMeta,
  resolveRepoCloneDirName,
  resolveRepoCloneRelPath,
  sanitizeCloneRelPath,
  relocateClonedRepo,
} from './layerFs.mjs';
import { postCloneProgress } from './saasTaskCloud.mjs';
import { mapPool, bootstrapCloneConcurrencyFromEnv } from './mapPool.mjs';
import {
  collectRepoBranchPlans,
  checkoutWorkBranchesForJobs,
} from './bootstrapWorkBranch.mjs';
import { setBootstrapReposLayoutReady } from './bootstrapCloneLayoutSeal.mjs';
import {
  bootstrapRepoLogState,
  startupEmptyLayerId,
  setBootstrapCloneLayerId,
  setBootstrapRepoLogState,
} from './bootstrapState.mjs';
import {
  appendCloneLayerLog,
  clearCloneLayerLog,
  finalizeCloneLayerLog,
  formatBootstrapCloneFailureFooter,
  rebuildBootstrapParallelLogText,
  resolveBootstrapCloneFailurePolicy,
} from './bootstrapCloneLog.mjs';
import { canonicalRepoUrlKey } from './bootstrapRepoCredentials.mjs';
import { ensureStartupEmptyLayer } from './bootstrapStartupEmptyLayer.mjs';
import { runOneBootstrapClone, bootstrapGitExec } from './bootstrapCloneOne.mjs';

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
export async function cloneReposIntoSharedLayer(urlsOrJobs, credRoot, cloudPrefix, accessToken, branchPlans) {
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
  setBootstrapCloneLayerId(layerId);
  /** 父仓落盘后 anyLayerHasGitRepo 即为 true；须等 nested 移入+切分支后才密封，防止过早叠层。 */
  setBootstrapReposLayoutReady(false);

  const layerDir = layerPath(layerId);
  const { jobs, stagingRoot } = planBootstrapCloneJobs(layerDir, jobsIn);
  const n = jobsIn.length;

  try {
    setBootstrapRepoLogState({
      layerId,
      preamble: '【项目克隆】正在并行克隆任务关联仓库（任务详情已拉取）…\n\n',
      jobs: jobs.slice(),
      bufs: new Map(),
    });
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
    setBootstrapRepoLogState(null);

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

    // 克隆层锁定点：并行克隆 + 子仓移入父仓 +（可选）工作分支切换均已结束
    setBootstrapReposLayoutReady(true);
    console.log(
      '[onlineServiceJS] BOOTSTRAP_PHASE=clone_layer_sealed 克隆层布局已锁定（含 nested relocate）',
    );
    return layerId;
  } catch (e) {
    if (bootstrapRepoLogState && bootstrapRepoLogState.layerId === layerId) {
      setBootstrapRepoLogState(null);
    }
    setBootstrapReposLayoutReady(false);
    throw e;
  }
}

/**
 * 任务详情中无关联仓库时：复用 `ensureStartupEmptyLayer()` 已创建的空层锚点目录，写入 `kind=clone`，
 * 与 `GET /api/layers/empty-root` 为同一 `layer_id`，避免与空锚点并行的多余可写层。
 * 首个仓库由后续 `POST /api/repos/clone`（或等价 git clone）写入子层，父层为上述 id。
 */
export function createInitialWorkspaceLayer() {
  const layerId = startupEmptyLayerId || ensureStartupEmptyLayer();
  createRootLayer(layerId);
  writeLayerMeta(layerId, 'clone', null);
  /** 无关联仓库：无 nested relocate，空克隆层即可视为已锁定（建任务仍受 anyLayerHasGitRepo 约束）。 */
  setBootstrapReposLayoutReady(true);
  appendOutboundReqLog(`bootstrap: initial writable layer (reuse empty-root, no git, await clone) ${layerId}`);
  console.log(`[onlineServiceJS] 已复用空层锚点为初始可写层（无 git，待首次克隆）: ${layerId}`);
  return layerId;
}
