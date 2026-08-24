/**
 * 父仓内嵌套独立 `.git` 工作树发现（staging→移入父仓 path 后的布局）。
 * 与并列多仓不同：父仓根已有 `.git` 时仍需继续向下发现子仓。
 */
import fs from 'fs';
import path from 'path';
import { shouldSkipListingDirName } from './layerFsListingSkip.mjs';

function dirHasGit(p) {
  try {
    return fs.existsSync(path.join(p, '.git'));
  } catch {
    return false;
  }
}

function normalizeRelPrefix(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/(^\/+)|(\/+$)/g, '');
}

/**
 * 在 startWorkdir 下有界扫描内嵌 git 根（不进入已发现的子仓内部、不进噪声目录）。
 * @param {string} startWorkdir
 * @param {string} startRelPrefix - 相对层根的前缀（与 startWorkdir 对应）
 * @param {{ maxDepth?: number }} [opts]
 * @returns {{ workdir: string, relPrefix: string }[]}
 */
export function findNestedGitRoots(startWorkdir, startRelPrefix = '', opts = {}) {
  const maxDepth = Number.isFinite(Number(opts.maxDepth)) ? Number(opts.maxDepth) : 8;
  const base = String(startWorkdir || '').trim();
  if (!base || !fs.existsSync(base)) return [];
  const basePrefix = normalizeRelPrefix(startRelPrefix);
  /** @type {{ workdir: string, relPrefix: string }[]} */
  const results = [];

  function walk(abs, rel, depth) {
    if (depth > maxDepth) return;
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (name === '.git' || name === '.bootstrap-staging') continue;
      if (shouldSkipListingDirName(name)) continue;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (dirHasGit(childAbs)) {
        results.push({ workdir: childAbs, relPrefix: normalizeRelPrefix(childRel) });
        continue;
      }
      walk(childAbs, childRel, depth + 1);
    }
  }

  walk(base, basePrefix, 0);
  results.sort((a, b) => a.relPrefix.localeCompare(b.relPrefix));
  return results;
}

/**
 * 顶层根 + 各顶层根下的内嵌仓；去重（同 workdir 只保留一次）。
 * @param {{ workdir: string, relPrefix: string }[]} topLevelRoots
 * @param {{ maxDepth?: number }} [opts]
 * @returns {{ workdir: string, relPrefix: string }[]}
 */
export function expandGitWorkdirRootsWithNested(topLevelRoots, opts = {}) {
  const list = Array.isArray(topLevelRoots) ? topLevelRoots : [];
  /** @type {Map<string, { workdir: string, relPrefix: string }>} */
  const byWorkdir = new Map();
  const add = (row) => {
    if (!row?.workdir) return;
    const key = path.resolve(row.workdir);
    if (byWorkdir.has(key)) return;
    byWorkdir.set(key, {
      workdir: row.workdir,
      relPrefix: normalizeRelPrefix(row.relPrefix),
    });
  };
  for (const row of list) {
    add(row);
    const nested = findNestedGitRoots(row.workdir, row.relPrefix || '', opts);
    for (const n of nested) add(n);
  }
  const depth = (p) => {
    const s = normalizeRelPrefix(p);
    if (!s) return 0;
    return s.split('/').filter(Boolean).length;
  };
  return [...byWorkdir.values()].sort((a, b) => {
    // 按路径段深度排序（勿用字符串长度：zOther < goPractice 会打乱并列仓字典序）
    const dp = depth(a.relPrefix) - depth(b.relPrefix);
    if (dp !== 0) return dp;
    return (a.relPrefix || '').localeCompare(b.relPrefix || '');
  });
}

/**
 * 按最长 relPrefix 匹配路径所属工作树。
 * @param {{ workdir: string, relPrefix: string }[]} roots
 * @param {string} relPath
 * @returns {{ workdir: string, relPrefix: string, inner: string } | null}
 */
export function matchGitRootByLongestPrefix(roots, relPath) {
  const rel = normalizeRelPrefix(relPath);
  if (!Array.isArray(roots) || !roots.length) return null;
  const sorted = [...roots].sort(
    (a, b) => (b.relPrefix || '').length - (a.relPrefix || '').length,
  );
  for (const r of sorted) {
    const pre = normalizeRelPrefix(r.relPrefix);
    if (!pre) {
      if (r.workdir) return { workdir: r.workdir, relPrefix: '', inner: rel };
      continue;
    }
    if (rel === pre || rel.startsWith(`${pre}/`)) {
      const inner = rel === pre ? '' : rel.slice(pre.length + 1);
      return { workdir: r.workdir, relPrefix: pre, inner };
    }
  }
  return null;
}
