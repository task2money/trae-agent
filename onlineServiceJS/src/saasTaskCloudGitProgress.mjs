/**
 * 解析 `git clone --progress` stderr：Receiving vs 解压/Checkout，以及日志换行归一。
 */
import fs from 'fs';
import path from 'path';

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

const GIT_SIZE_UNIT_BYTES = {
  B: 1,
  byte: 1,
  bytes: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
  GiB: 1024 * 1024 * 1024,
  KB: 1000,
  MB: 1000 * 1000,
  GB: 1000 * 1000 * 1000,
};

/**
 * 从 `git clone --progress` stderr 解析 Receiving objects 已接收字节（取最后一次带单位的行）。
 * @param {string} stderrAll
 * @returns {number}
 */
export function parseGitCloneReceivedBytes(stderrAll) {
  const text = String(stderrAll || '');
  const re = /Receiving objects:\s*\d+%\s*\([^)]+\),\s*([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB|bytes?)/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number.parseFloat(m[1]);
    const unit = String(m[2] || '');
    const mul = GIT_SIZE_UNIT_BYTES[unit] || GIT_SIZE_UNIT_BYTES[unit.replace(/s$/i, '')];
    if (Number.isFinite(n) && n > 0 && mul) {
      last = Math.round(n * mul);
    }
  }
  return last > 0 ? last : 0;
}

/**
 * 回退：`.git/objects/pack/*.pack` 体积（无 progress 尺寸行时）。
 * @param {string} repoDir
 * @returns {number}
 */
export function sumGitPackBytes(repoDir) {
  const root = String(repoDir || '').trim();
  if (!root) return 0;
  const packDir = path.join(root, '.git', 'objects', 'pack');
  let names;
  try {
    names = fs.readdirSync(packDir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!String(name).endsWith('.pack')) continue;
    try {
      const st = fs.statSync(path.join(packDir, name));
      if (st && Number.isFinite(st.size) && st.size > 0) total += st.size;
    } catch {
      /* ignore one pack */
    }
  }
  return total;
}

/**
 * @param {string} stderrAll
 * @param {string} [repoDir]
 * @returns {number}
 */
export function resolveGitCloneReceivedBytes(stderrAll, repoDir) {
  const fromLog = parseGitCloneReceivedBytes(stderrAll);
  if (fromLog > 0) return fromLog;
  if (!repoDir) return 0;
  return sumGitPackBytes(repoDir);
}
