/**
 * 解析 `git clone --progress` stderr：Receiving vs 解压/Checkout，以及日志换行归一。
 */

/**
 * @param {string} stderrAll
 * @returns {{ recv: number|null, unpack: number|null, overall: number }}
 */
export function parseGitCloneProgressPhases(stderrAll) {
  const text = String(stderrAll || '');
  const tail = text.length > 12000 ? text.slice(-12000) : text;
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
    // 解压/Checkout 取全文峰值：大仓 12k 尾窗常被后续 Receiving 3% 挤掉已完成的 100%。
    while ((m = re.exec(text)) !== null) {
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
 * 同一次 git clone 进程内百分比只升不降（重试会新开进程、lastPct 重置）。
 * @param {number} lastPct
 * @param {number} nextPct
 * @param {number} nowMs
 * @param {number} lastPostedMs
 */
export function shouldEmitGitCloneProgressPercent(lastPct, nextPct, nowMs, lastPostedMs) {
  if (!Number.isFinite(nextPct) || nextPct < 0) return false;
  if (Number.isFinite(lastPct) && lastPct >= 0 && nextPct < lastPct) return false;
  if (nextPct === lastPct && nowMs - lastPostedMs < 2000) return false;
  if (nowMs - lastPostedMs < 400 && nextPct <= lastPct) return false;
  return true;
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
