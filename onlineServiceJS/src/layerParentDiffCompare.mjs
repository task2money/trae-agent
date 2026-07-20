/**
 * 父/子工作区文件索引对比（walk 路径与 git 候选路径分类共用）。
 */
import fs from 'fs';
import path from 'path';

const MAX_FILE_BYTES_FULL_COMPARE = 25 * 1024 * 1024;

export function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function safeJoin(root, relPosix) {
  const clean = normalizeRel(relPosix);
  const segs = clean ? clean.split('/').filter(Boolean) : [];
  const joined = path.resolve(path.join(root, ...segs));
  const rootR = path.resolve(root);
  if (joined !== rootR && !joined.startsWith(rootR + path.sep)) {
    throw new Error('path outside layer root');
  }
  return joined;
}

export function trySafeJoin(root, relPosix) {
  try {
    return safeJoin(root, relPosix);
  } catch {
    return null;
  }
}

export function filesContentEqual(fpA, fpB) {
  const sa = fs.statSync(fpA);
  const sb = fs.statSync(fpB);
  if (sa.size !== sb.size) return false;
  if (sa.size > MAX_FILE_BYTES_FULL_COMPARE) {
    return sa.mtimeMs === sb.mtimeMs;
  }
  const a = fs.readFileSync(fpA);
  const b = fs.readFileSync(fpB);
  return Buffer.compare(a, b) === 0;
}

/**
 * 对单个相对路径分类；相同则返回 null。
 * @returns {'added'|'removed'|'modified'|null}
 */
export function classifyPathChange(parentRoot, childRoot, relPosix) {
  const rel = normalizeRel(relPosix);
  if (!rel) return null;
  const absP = trySafeJoin(parentRoot, rel);
  const absC = trySafeJoin(childRoot, rel);
  const exP = Boolean(absP && fs.existsSync(absP));
  const exC = Boolean(absC && fs.existsSync(absC));
  if (exP && !exC) return 'removed';
  if (!exP && exC) return 'added';
  if (!exP && !exC) return null;

  let stP;
  let stC;
  try {
    stP = fs.lstatSync(absP);
    stC = fs.lstatSync(absC);
  } catch {
    return 'modified';
  }
  if (stP.isDirectory() || stC.isDirectory()) return null;
  if (stP.isSymbolicLink() || stC.isSymbolicLink()) {
    try {
      const tgP = stP.isSymbolicLink() ? fs.readlinkSync(absP) : null;
      const tgC = stC.isSymbolicLink() ? fs.readlinkSync(absC) : null;
      if (tgP !== tgC || stP.isSymbolicLink() !== stC.isSymbolicLink()) return 'modified';
      return null;
    } catch {
      return 'modified';
    }
  }
  if (!stP.isFile() || !stC.isFile()) {
    if (stP.isFile() !== stC.isFile()) return 'modified';
    return null;
  }
  if (stP.size !== stC.size) return 'modified';
  try {
    return filesContentEqual(absP, absC) ? null : 'modified';
  } catch {
    return 'modified';
  }
}

/**
 * @param {string} parentRoot
 * @param {string} childRoot
 * @param {Map<string, object>} idxP
 * @param {Map<string, object>} idxC
 */
export function compareIndices(parentRoot, childRoot, idxP, idxC) {
  const changes = [];
  const allKeys = new Set([...idxP.keys(), ...idxC.keys()]);
  for (const p of [...allKeys].sort()) {
    const a = idxP.get(p);
    const b = idxC.get(p);
    let absP;
    let absC;
    try {
      absP = a ? safeJoin(parentRoot, p) : null;
      absC = b ? safeJoin(childRoot, p) : null;
    } catch {
      continue;
    }
    if (a && !b) {
      changes.push({ path: p, kind: 'removed' });
      continue;
    }
    if (!a && b) {
      changes.push({ path: p, kind: 'added' });
      continue;
    }
    if (!a || !b) continue;
    if (a.t !== b.t) {
      changes.push({ path: p, kind: 'modified' });
      continue;
    }
    if (a.t === 'l') {
      if (a.tg !== b.tg) changes.push({ path: p, kind: 'modified' });
      continue;
    }
    if (a.t === 'f') {
      if (a.size !== b.size) {
        changes.push({ path: p, kind: 'modified' });
        continue;
      }
      try {
        if (!filesContentEqual(absP, absC)) changes.push({ path: p, kind: 'modified' });
      } catch {
        changes.push({ path: p, kind: 'modified' });
      }
    }
  }
  return changes;
}
