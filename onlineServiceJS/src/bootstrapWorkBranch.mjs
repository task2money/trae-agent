/**
 * bootstrap 克隆后：将各仓库切换到任务工作分支。
 * 分支名来自容器 task-detail（task.target_branch / branch_strategy / repo_branch_plans）。
 */

/**
 * @typedef {{ baseBranch: string, workBranch: string }} RepoBranchPlan
 */

/**
 * @param {unknown} taskDetail
 * @returns {{ sharedWorkBranch: string, byUrl: Map<string, RepoBranchPlan> }}
 */
export function collectRepoBranchPlans(taskDetail) {
  const detail = taskDetail && typeof taskDetail === 'object' ? taskDetail : {};
  const task = detail.task && typeof detail.task === 'object' ? detail.task : {};
  const params = task.parameters && typeof task.parameters === 'object' ? task.parameters : {};
  const bs =
    params.branch_strategy && typeof params.branch_strategy === 'object' ? params.branch_strategy : {};

  const sharedWorkBranch =
    String(task.target_branch || '').trim() ||
    String(bs.work_branch_name || '').trim() ||
    String(bs.target_branch_name || '').trim();

  /** @type {Map<string, RepoBranchPlan>} */
  const byUrl = new Map();

  const remember = (rawUrl, baseBranch, workBranch) => {
    const url = String(rawUrl || '').trim();
    if (!url) return;
    const work = String(workBranch || '').trim() || sharedWorkBranch;
    const base = String(baseBranch || '').trim();
    const prev = byUrl.get(url);
    if (prev) {
      byUrl.set(url, {
        baseBranch: base || prev.baseBranch,
        workBranch: work || prev.workBranch,
      });
      return;
    }
    byUrl.set(url, { baseBranch: base, workBranch: work });
  };

  const topPlans = Array.isArray(detail.repo_branch_plans) ? detail.repo_branch_plans : [];
  for (const p of topPlans) {
    if (!p || typeof p !== 'object') continue;
    remember(p.repo_url || p.git_repo, p.base_branch, p.target_branch || p.work_branch);
  }

  const projectRepos = Array.isArray(detail.project_repos) ? detail.project_repos : [];
  for (const pr of projectRepos) {
    if (!pr || typeof pr !== 'object') continue;
    const repoBranches = Array.isArray(pr.repo_branches) ? pr.repo_branches : [];
    for (const rb of repoBranches) {
      if (!rb || typeof rb !== 'object') continue;
      remember(rb.git_repo || rb.repo_url, rb.base_branch, rb.target_branch || rb.work_branch);
    }
    const urls = Array.isArray(pr.git_repos) ? pr.git_repos : [];
    for (const u of urls) {
      remember(u, '', sharedWorkBranch);
    }
  }

  return { sharedWorkBranch, byUrl };
}

/**
 * 在已克隆的仓库目录内检出工作分支。
 * @param {object} deps
 * @param {(args: string[], cwd: string, env?: object) => Promise<string>} deps.gitExec
 * @param {string} deps.repoDir
 * @param {string} deps.workBranch
 * @param {string} [deps.baseBranch]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, mode?: string, current?: string, detail?: string }>}
 */
export async function ensureRepoOnWorkBranch(deps) {
  const gitExec = deps.gitExec;
  const repoDir = String(deps.repoDir || '').trim();
  const workBranch = String(deps.workBranch || '').trim();
  const baseBranch = String(deps.baseBranch || '').trim();

  if (!repoDir) {
    return { ok: false, detail: 'repoDir 为空' };
  }
  if (!workBranch) {
    return { ok: true, skipped: true, reason: 'empty_work_branch' };
  }

  const env = { GIT_TERMINAL_PROMPT: '0' };

  let current = '';
  try {
    current = String(await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir, env)).trim();
  } catch (e) {
    return { ok: false, detail: `无法读取当前分支: ${e?.message || e}` };
  }
  if (current === workBranch) {
    return { ok: true, skipped: true, reason: 'already_on_work_branch', current };
  }

  // 优先跟踪远端已有工作分支
  try {
    await gitExec(['rev-parse', '--verify', `refs/remotes/origin/${workBranch}`], repoDir, env);
    await gitExec(['checkout', '-B', workBranch, `origin/${workBranch}`], repoDir, env);
    return { ok: true, mode: 'track_origin', current: workBranch };
  } catch {
    /* continue */
  }

  // 本地已有同名分支
  try {
    await gitExec(['rev-parse', '--verify', `refs/heads/${workBranch}`], repoDir, env);
    await gitExec(['checkout', workBranch], repoDir, env);
    return { ok: true, mode: 'local', current: workBranch };
  } catch {
    /* continue */
  }

  // 可选：先切到基准分支再创建工作分支
  if (baseBranch && baseBranch !== workBranch) {
    try {
      await gitExec(['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}`], repoDir, env);
      await gitExec(['checkout', '-B', baseBranch, `origin/${baseBranch}`], repoDir, env);
    } catch {
      try {
        await gitExec(['rev-parse', '--verify', `refs/heads/${baseBranch}`], repoDir, env);
        await gitExec(['checkout', baseBranch], repoDir, env);
      } catch {
        /* 保持当前 HEAD */
      }
    }
  }

  await gitExec(['checkout', '-b', workBranch], repoDir, env);
  return { ok: true, mode: 'create_local', current: workBranch };
}

/**
 * @param {object} deps
 * @param {(args: string[], cwd: string, env?: object) => Promise<string>} deps.gitExec
 * @param {{ raw: string, repoDir: string }[]} deps.jobs
 * @param {Map<string, RepoBranchPlan>} deps.plansByUrl
 * @param {string} [deps.sharedWorkBranch]
 * @param {(line: string) => void} [deps.appendLog]
 * @returns {Promise<{ ok: boolean, results: object[], errors: Error[] }>}
 */
export async function checkoutWorkBranchesForJobs(deps) {
  const gitExec = deps.gitExec;
  const jobs = Array.isArray(deps.jobs) ? deps.jobs : [];
  const plansByUrl = deps.plansByUrl instanceof Map ? deps.plansByUrl : new Map();
  const sharedWorkBranch = String(deps.sharedWorkBranch || '').trim();
  const appendLog = typeof deps.appendLog === 'function' ? deps.appendLog : () => {};

  const results = [];
  const errors = [];

  for (const job of jobs) {
    const raw = String(job?.raw || '').trim();
    const repoDir = String(job?.repoDir || '').trim();
    const plan = plansByUrl.get(raw) || { baseBranch: '', workBranch: sharedWorkBranch };
    const workBranch = String(plan.workBranch || sharedWorkBranch).trim();
    const baseBranch = String(plan.baseBranch || '').trim();

    try {
      const r = await ensureRepoOnWorkBranch({
        gitExec,
        repoDir,
        workBranch,
        baseBranch,
      });
      results.push({ raw, repoDir, workBranch, ...r });
      if (r.ok && r.skipped) {
        appendLog(
          `[work-branch-checkout] skip repo=${raw} work=${workBranch || '(empty)'} reason=${r.reason || ''}`,
        );
      } else if (r.ok) {
        appendLog(
          `[work-branch-checkout] ok repo=${raw} work=${workBranch} mode=${r.mode || ''} current=${r.current || ''}`,
        );
      } else {
        const err = new Error(r.detail || `checkout failed for ${raw}`);
        errors.push(err);
        appendLog(`[work-branch-checkout] fail repo=${raw} work=${workBranch} detail=${r.detail || ''}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      errors.push(err);
      appendLog(`[work-branch-checkout] fail repo=${raw} work=${workBranch} detail=${err.message}`);
      results.push({ raw, repoDir, workBranch, ok: false, detail: err.message });
    }
  }

  return { ok: errors.length === 0, results, errors };
}
