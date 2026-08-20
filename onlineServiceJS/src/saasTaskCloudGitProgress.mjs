/**
 * 解析 `git clone --progress` stderr：Receiving vs 解压/Checkout，以及日志换行归一。
 */

/**
 * @param {string} stderrAll
 * @returns {{ recv: number|null, unpack: number|null, overall: number }}
 */
export function parseGitCloneProgressPhases(stderrAll) {
  const tail = stderrAll.length > 12000 ? stderrAll.slice(-12000) : stderrAll;
  let bestRecv = -1;
  for (const m of tail.matchAll(/Receiving objects:\s*(\d+)%/g)) {
    const v = parseInt(m[1], 10);
    if (Number.isFinite(v)) bestRecv = Math.max(bestRecv, v);
  }
  const secondary = [
    /Resolving deltas:\s*(\d+)%/g,
    /Unpacking objects:\s*(\d+)%/g,
    /Checking out files:\s*(\d+)%/g,
  ];
  let bestSecondary = -1;
  for (const re of secondary) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(tail)) !== null) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v)) bestSecondary = Math.max(bestSecondary, v);
    }
  }
  /** 大仓 stderr 尾窗口常留下早期 Receiving 9%，同时已有 Resolving/Checkout 100%；取 max 避免整体卡在 recv。 */
  let overall = -1;
  if (bestRecv >= 0 && bestSecondary >= 0) overall = Math.max(bestRecv, bestSecondary);
  else if (bestRecv >= 0) overall = bestRecv;
  else if (bestSecondary >= 0) overall = bestSecondary;
  return {
    recv: bestRecv >= 0 ? bestRecv : null,
    unpack: bestSecondary >= 0 ? bestSecondary : null,
    overall: overall >= 0 ? overall : -1,
  };
}

/**
 * @param {string} stderrAll
 * @returns {number}
 */
export function latestGitProgressPercent(stderrAll) {
  const { overall } = parseGitCloneProgressPhases(stderrAll);
  return overall;
}

/** git --progress 用 \r 刷行；写入持久克隆日志时换成换行 */
export function normalizeGitProgressChunkForLog(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
