/** 引导流程可变状态（单一模块集中，禁止其它文件 export let）。 */

export let bootstrapCloneLayerId = null;
/** 为 true 时 server 须在引导结束后调用 registerBootstrapCloneJob（仅「任务详情已含仓库并完成引导克隆」） */
export let bootstrapRegisterCloneJob = false;
export let startupEmptyLayerId = null;
/** 最近一次 bootstrap 拉取的 task-detail（供 auto_run 首指令/交付） */
export let lastBootstrapTaskDetail = null;

/**
 * 最近一次 bootstrap 失败摘要（供 GET bootstrap-clone-log 在尚未产生 layer 时返回可读原因）。
 * @type {{ phase: string, code: string, message: string, at: string, missing_repo_credentials?: string[] } | null}
 */
export let lastBootstrapFailure = null;

/** @type {ReturnType<typeof setTimeout> | null} */
export let bootstrapCredentialsRecoveryTimer = null;
export let bootstrapCredentialsRecoveryRunning = false;
export let bootstrapCredentialsRecoveryRounds = 0;

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
export let bootstrapRepoLogState = null;

export function setBootstrapCloneLayerId(v) {
  bootstrapCloneLayerId = v;
}
export function setBootstrapRegisterCloneJob(v) {
  bootstrapRegisterCloneJob = Boolean(v);
}
export function setStartupEmptyLayerId(v) {
  startupEmptyLayerId = v;
}
export function setLastBootstrapTaskDetail(v) {
  lastBootstrapTaskDetail = v;
}
export function setLastBootstrapFailure(v) {
  lastBootstrapFailure = v;
}
export function setBootstrapCredentialsRecoveryTimer(v) {
  bootstrapCredentialsRecoveryTimer = v;
}
export function setBootstrapCredentialsRecoveryRunning(v) {
  bootstrapCredentialsRecoveryRunning = Boolean(v);
}
export function setBootstrapCredentialsRecoveryRounds(v) {
  bootstrapCredentialsRecoveryRounds = Number(v) || 0;
}
export function setBootstrapRepoLogState(v) {
  bootstrapRepoLogState = v;
}
