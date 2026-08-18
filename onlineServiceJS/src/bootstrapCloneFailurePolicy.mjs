import path from 'path';

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
 * 分仓失败进度文案：仓库名后带 git URL，便于冷打开从 binding 日志还原「手动重试」。
 * @param {number} index 1-based
 * @param {number} total
 * @param {string} repoName
 * @param {string} repoUrl
 * @param {string} errMsg
 * @returns {string}
 */
export function formatBootstrapCloneRepoFailureMessage(index, total, repoName, repoUrl, errMsg) {
  const i = Math.max(1, Number(index) || 1);
  const n = Math.max(1, Number(total) || 1);
  const name = String(repoName || '').trim() || 'repo';
  const url = String(repoUrl || '').trim();
  const detail = String(errMsg || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  const who = url && url !== name ? `${name} ${url}` : name;
  return `【项目克隆】(${i}/${n}) 失败 ${who}: ${detail}`;
}

/**
 * 单仓/多仓克隆失败不阻断引导后续（feature-params / BOOTSTRAP_COMPLETE / 业务端点就绪）。
 * 全部失败时不写「其余已就绪」；失败仓可在任务详情「手动重试」。
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
  const total = totalCount || failedCount;
  if (failedCount >= total) {
    return {
      abort: false,
      progressMessage:
        `【项目克隆】失败：${failedCount}/${total} 个仓库均失败：${names}（引导仍继续，可手动重试）`.slice(
          0,
          2000,
        ),
      level: 'partial',
    };
  }
  return {
    abort: false,
    progressMessage:
      `【项目克隆】部分失败：失败 ${failedCount}/${total} 个仓库：${names}（其余已就绪，引导继续）`.slice(
        0,
        2000,
      ),
    level: 'partial',
  };
}
