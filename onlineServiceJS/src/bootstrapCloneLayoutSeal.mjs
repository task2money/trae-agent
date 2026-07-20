/**
 * 克隆层布局密封：须在「并行克隆 → 子仓移入父仓 → 工作分支切换」完成后才为 true。
 * 避免仅父仓已落盘、子仓仍在 staging 时 anyLayerHasGitRepo() 已为 true，从而过早叠层/建任务。
 */

let bootstrapReposLayoutReady = false;

/** @returns {boolean} */
export function isBootstrapReposLayoutReady() {
  return bootstrapReposLayoutReady === true;
}

/** @param {boolean} ready */
export function setBootstrapReposLayoutReady(ready) {
  bootstrapReposLayoutReady = ready === true;
}

/**
 * 建任务前校验：有 git；若处于引导克隆层生命周期则须布局已密封（含 nested relocate）。
 * @param {boolean} hasGit
 * @param {{ enforceSeal?: boolean }} [opts]
 *   enforceSeal：引导已分配 bootstrapCloneLayerId 时为 true；单测/无引导上下文不强制密封。
 */
export function assertReposLayoutReadyForJobs(hasGit, opts = {}) {
  if (!hasGit) {
    throw new Error('请先完成「克隆仓库」后再创建任务。');
  }
  if (opts.enforceSeal === true && !bootstrapReposLayoutReady) {
    throw new Error(
      '克隆层布局尚未锁定：须完成子仓移入父仓（及工作分支切换）后再创建任务。',
    );
  }
}
