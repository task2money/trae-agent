/**
 * 父层 diff：目录索引扫描（跳过噪声目录，避免占满 MAX_DIFF_ENTRIES）。
 */
import fs from 'fs';
import path from 'path';
import { shouldSkipListingDirName } from './layerFs.mjs';

/** 单侧工作区文件索引条目上限；触顶则 truncated=true */
export const MAX_DIFF_ENTRIES = 4000;

function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** 排除 .git 目录及路径任一段为 .git 的条目（含子模块 worktree 的 `.git` 文件） */
export function isGitInternalPath(relPosix) {
  const p = normalizeRel(relPosix);
  if (!p) return false;
  if (p === '.git' || p.startsWith('.git/')) return true;
  if (p.includes('/.git/')) return true;
  if (p.endsWith('/.git')) return true;
  return false;
}

/**
 * @param {string} absRoot
 * @returns {{ map: Map<string, object>, truncated: boolean }}
 */
export function collectIndex(absRoot) {
  const map = new Map();
  let n = 0;
  let truncated = false;

  function walk(abs, rel) {
    if (n >= MAX_DIFF_ENTRIES) {
      truncated = true;
      return;
    }
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    const relN = normalizeRel(rel);
    if (isGitInternalPath(relN)) return;
    if (st.isSymbolicLink()) {
      map.set(relN, { t: 'l', tg: fs.readlinkSync(abs) });
      n++;
      return;
    }
    if (st.isDirectory()) {
      let ents;
      try {
        ents = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.name === '.git' || shouldSkipListingDirName(e.name)) continue;
        walk(path.join(abs, e.name), relN ? `${relN}/${e.name}` : e.name);
        if (n >= MAX_DIFF_ENTRIES) {
          truncated = true;
          return;
        }
      }
      return;
    }
    if (st.isFile()) {
      map.set(relN, { t: 'f', size: st.size, mtime: st.mtimeMs });
      n++;
    }
  }

  walk(absRoot, '');
  return { map, truncated };
}
