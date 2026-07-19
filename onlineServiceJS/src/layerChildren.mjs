/**
 * GET /api/layers/:id/children — 与扁平文件列表 / files/* 共用多仓前缀语义。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { gitCmd } from './gitCmd.mjs';
import { layerGitWorkdirRootsForFileListing } from './layerFs.mjs';

function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function deletedPathsInWorkdir(workDir) {
  const cwd = String(workDir || '').trim();
  if (!cwd) return new Set();
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let statusPorcelain = '';
  try {
    const out = spawnSync(gitCmd(), ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    statusPorcelain = String(out.stdout || '');
  } catch {
    return new Set();
  }
  const deleted = new Set();
  for (const line of statusPorcelain.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const status = trimmed.slice(0, 2);
    const pathPart = trimmed.slice(3);
    const normalizedPath = normalizeRel(pathPart);
    if (normalizedPath && (status.startsWith('D') || status.includes('D'))) {
      deleted.add(normalizedPath);
    }
  }
  return deleted;
}

function entryMatchesPrefix(relPosix, baseName, prefixRaw) {
  if (!prefixRaw) return true;
  if (relPosix.startsWith(prefixRaw)) return true;
  if (baseName.startsWith(prefixRaw)) return true;
  const noTrail = prefixRaw.endsWith('/') ? prefixRaw.slice(0, -1) : prefixRaw;
  if (noTrail && (baseName === noTrail || relPosix === noTrail)) return true;
  return false;
}

/**
 * @param {string} work
 * @param {string} absDir
 * @returns {boolean}
 */
function isUnderWorkdir(work, absDir) {
  const workResolved = path.resolve(work);
  const dirResolved = path.resolve(absDir);
  return dirResolved === workResolved || dirResolved.startsWith(workResolved + path.sep);
}

/**
 * @param {string} layerId
 * @param {string} dirRel
 * @returns {{ kind: 'virtual' } | { kind: 'fs', work: string, absDir: string, listPathPrefix: string, innerDirRel: string } | { kind: 'error', status: number, detail: string }}
 */
function resolveChildrenTarget(layerId, dirRel) {
  const roots = layerGitWorkdirRootsForFileListing(layerId);
  if (!roots.length) {
    return { kind: 'error', status: 404, detail: 'layer not found' };
  }
  const prefixed = roots.filter((r) => r.relPrefix);
  if (!prefixed.length) {
    const work = roots[0].workdir;
    const absDir = path.resolve(path.join(work, dirRel || '.'));
    if (!isUnderWorkdir(work, absDir)) {
      return { kind: 'error', status: 400, detail: 'invalid dir' };
    }
    return { kind: 'fs', work, absDir, listPathPrefix: '', innerDirRel: dirRel };
  }

  if (!dirRel) {
    return { kind: 'virtual' };
  }

  const segs = dirRel.split('/').filter((s) => s.length);
  if (segs.some((s) => s === '.' || s === '..')) {
    return { kind: 'error', status: 400, detail: 'invalid dir' };
  }
  for (const { workdir, relPrefix } of prefixed) {
    if (segs[0] !== relPrefix) continue;
    const insideParts = segs.slice(1);
    const innerDirRel = insideParts.join('/');
    const absDir = path.resolve(path.join(workdir, innerDirRel || '.'));
    if (!isUnderWorkdir(workdir, absDir)) {
      return { kind: 'error', status: 400, detail: 'invalid dir' };
    }
    return {
      kind: 'fs',
      work: workdir,
      absDir,
      listPathPrefix: relPrefix,
      innerDirRel,
    };
  }
  return { kind: 'error', status: 400, detail: 'invalid dir' };
}

/**
 * @param {string} layerId
 * @param {{ dir?: string, prefix?: string, offset?: number, limit?: number }} [opts]
 * @returns {{ ok: true, entries: object[], total: number, next_offset: number, truncated: boolean } | { ok: false, status: number, detail: string }}
 */
export function listLayerChildren(layerId, opts = {}) {
  const dirRel = normalizeRel(opts.dir ?? '');
  const prefixRaw = String(opts.prefix ?? '').replace(/\\/g, '/');
  const offset = Math.max(0, parseInt(String(opts.offset ?? '0'), 10) || 0);
  const limit = Math.min(Math.max(1, parseInt(String(opts.limit ?? '200'), 10) || 200), 2000);

  const target = resolveChildrenTarget(layerId, dirRel);
  if (target.kind === 'error') {
    return { ok: false, status: target.status, detail: target.detail };
  }

  /** @type {{ type: string, path: string, size: number }[]} */
  let rows = [];

  if (target.kind === 'virtual') {
    const roots = layerGitWorkdirRootsForFileListing(layerId).filter((r) => r.relPrefix);
    for (const { relPrefix } of roots) {
      if (!entryMatchesPrefix(relPrefix, relPrefix, prefixRaw)) continue;
      rows.push({ type: 'dir', path: relPrefix, size: 0 });
    }
  } else {
    let dirents = [];
    try {
      dirents = fs.readdirSync(target.absDir, { withFileTypes: true });
    } catch (e) {
      return { ok: false, status: 400, detail: String(e?.message || e) };
    }

    const deletedInner = deletedPathsInWorkdir(target.work);

    for (const ent of dirents) {
      if (ent.name === '.git') continue;
      const innerRel = target.innerDirRel ? `${target.innerDirRel}/${ent.name}` : ent.name;
      const relPosix = target.listPathPrefix
        ? `${target.listPathPrefix}/${innerRel}`
        : innerRel;
      if (!entryMatchesPrefix(relPosix, ent.name, prefixRaw)) continue;

      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        try {
          const st = fs.statSync(path.join(target.absDir, ent.name));
          isDir = st.isDirectory();
        } catch {
          continue;
        }
      }

      if (!isDir && deletedInner.has(normalizeRel(innerRel))) continue;

      let size = 0;
      if (!isDir) {
        try {
          size = fs.statSync(path.join(target.absDir, ent.name)).size;
        } catch {
          /* ignore */
        }
      }
      rows.push({
        type: isDir ? 'dir' : 'file',
        path: relPosix,
        size,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return String(a.path).localeCompare(String(b.path));
  });

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  const truncated = offset + page.length < total;
  return {
    ok: true,
    entries: page,
    total,
    next_offset: offset + page.length,
    truncated,
  };
}
