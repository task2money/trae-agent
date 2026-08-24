/**
 * 层扁平文件列表（从 layerFs 拆出以满足行数门禁）。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { gitCmd } from './gitCmd.mjs';
import { shouldSkipListingDirName } from './layerFsListingSkip.mjs';
import {
  layerGitWorkdirRootsForFileListing,
  layerPrimaryGitWorkdir,
} from './layerFs.mjs';

function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/(^\/+)|(\/+$)/g, '');
}

function gitStatusPathSets(work) {
  const cwd = String(work || '').trim();
  if (!cwd) return { staged: new Set(), unstaged: new Set() };
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const runZ = (args) => {
    try {
      const out = spawnSync(gitCmd(), args, {
        cwd,
        encoding: 'utf8',
        env,
        maxBuffer: 32 * 1024 * 1024,
      });
      return String(out.stdout || '')
        .split('\0')
        .map((s) => normalizeRel(s))
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const staged = new Set(runZ(['diff', '--cached', '--name-only', '-z']));
  const unstaged = new Set(runZ(['diff', '--name-only', '-z']));

  // 获取 git status --porcelain 来检查哪些是已删除的
  const statusPorcelain = (() => {
    try {
      const out = spawnSync(gitCmd(), ['status', '--porcelain'], {
        cwd,
        encoding: 'utf8',
        env,
        maxBuffer: 32 * 1024 * 1024,
      });
      return String(out.stdout || '');
    } catch {
      return '';
    }
  })();

  const deleted = new Set();
  for (const line of statusPorcelain.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const status = trimmed.slice(0, 2);
    const pathPart = trimmed.slice(3);
    const normalizedPath = normalizeRel(pathPart);
    if (normalizedPath && (status === 'D ' || status === ' D' || status === 'D ' || status === ' D' || status === 'DD')) {
      deleted.add(normalizedPath);
    }
  }

  return { staged, unstaged, deleted };
}


/**
 * 在目录下找第一个可列出的文件相对路径（BFS，跳过噪声目录）。
 * @param {string} absDir
 * @param {string} relDir - 相对 workdir 的路径前缀
 * @param {Set<string>} deletedInner
 * @returns {string | null} 相对 workdir 的路径（不含 relPrefix）
 */
function findFirstListableFile(absDir, relDir, deletedInner = new Set()) {
  const queue = [{ abs: absDir, rel: relDir }];
  while (queue.length) {
    const { abs, rel } = queue.shift();
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    ents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const ent of ents) {
      if (shouldSkipListingDirName(ent.name)) continue;
      const p = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        queue.push({ abs: p, rel: r });
        continue;
      }
      if (deletedInner.has(normalizeRel(r))) continue;
      return r;
    }
  }
  return null;
}

function listedPath(relPrefix, rel) {
  return relPrefix ? `${relPrefix}/${rel}` : rel;
}

/**
 * 保证工作区顶层条目在 max_files 截断后仍可见：
 * - 顶层文件直接加入
 * - 顶层目录优先加入其下第一个可列出文件；若无文件则加入 `dirname/` 目录标记
 * @returns {boolean} truncated
 */
function seedTopLevelListing(absBase, relPrefix, files, maxFiles, deletedInner = new Set()) {
  let ents;
  try {
    ents = fs.readdirSync(absBase, { withFileTypes: true });
  } catch {
    return false;
  }
  ents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const seen = new Set(files);
  for (const ent of ents) {
    if (files.length >= maxFiles) return true;
    if (shouldSkipListingDirName(ent.name)) continue;
    const p = path.join(absBase, ent.name);
    if (ent.isDirectory()) {
      const first = findFirstListableFile(p, ent.name, deletedInner);
      if (first) {
        const listed = listedPath(relPrefix, first);
        if (!seen.has(listed)) {
          files.push(listed);
          seen.add(listed);
        }
      } else {
        // 空目录或仅有被跳过内容：仍展示目录名
        const listed = listedPath(relPrefix, `${ent.name}/`);
        if (!seen.has(listed)) {
          files.push(listed);
          seen.add(listed);
        }
      }
      continue;
    }
    const r = ent.name;
    if (deletedInner.has(normalizeRel(r))) continue;
    const listed = listedPath(relPrefix, r);
    if (!seen.has(listed)) {
      files.push(listed);
      seen.add(listed);
    }
  }
  return files.length >= maxFiles;
}

/**
 * BFS 补齐更多文件路径（先浅后深），避免 DFS 深入早期目录占满额度。
 * @returns {boolean} truncated
 */
function walkRepoRelativeFiles(absBase, relPrefix, files, maxFiles, deletedInner = new Set()) {
  const seen = new Set(files);
  const queue = [{ abs: absBase, rel: '' }];
  let truncated = false;
  try {
    while (queue.length) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const { abs, rel } = queue.shift();
      let ents;
      try {
        ents = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      ents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      for (const ent of ents) {
        if (shouldSkipListingDirName(ent.name)) continue;
        const p = path.join(abs, ent.name);
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          queue.push({ abs: p, rel: r });
          continue;
        }
        if (deletedInner.has(normalizeRel(r))) continue;
        const listed = listedPath(relPrefix, r);
        if (seen.has(listed)) continue;
        files.push(listed);
        seen.add(listed);
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
      }
    }
    if (queue.length) truncated = true;
  } catch {
    /* ignore */
  }
  return truncated;
}

/**
 * 遍历层内（含多并列克隆仓）相对路径列表，供 GET /api/layers/:id/files 与单测使用。
 * 策略：先为每个仓/工作区种子化顶层条目，再 BFS 补齐，并跳过 node_modules 等噪声目录，
 * 避免大仓 DFS + max_files 截断导致「顶层目录不全」。
 * @param {string} layerId
 * @param {number} [maxFiles]
 * @returns {{ files: string[], truncated: boolean }}
 */
export function listFlatRelativeFilesForLayer(layerId, maxFiles = 2000) {
  const cap = Math.max(1, Math.min(5000, Number(maxFiles) || 2000));
  const roots = layerGitWorkdirRootsForFileListing(layerId);
  if (!roots.length) return { files: [], truncated: false };
  const files = [];
  let truncated = false;
  const rootStates = [];
  for (const { workdir, relPrefix } of roots) {
    const { deleted: deletedInner } = gitStatusPathSets(workdir);
    rootStates.push({ workdir, relPrefix, deletedInner });
  }
  // Phase 1：所有仓先种子化顶层，保证多仓并列时后序仓不会被前序仓深文件挤掉
  for (const { workdir, relPrefix, deletedInner } of rootStates) {
    if (seedTopLevelListing(workdir, relPrefix, files, cap, deletedInner)) {
      truncated = true;
      break;
    }
  }
  // Phase 2：BFS 补齐
  if (!truncated) {
    for (const { workdir, relPrefix, deletedInner } of rootStates) {
      if (walkRepoRelativeFiles(workdir, relPrefix, files, cap, deletedInner)) {
        truncated = true;
        break;
      }
    }
  }
  return { files, truncated };
}

/**
 * 规范化 files/* 路径：解码 URI，并把误编码的 %2F 还原为路径分隔符。
 * @param {string} rel
 * @returns {string}
 */
function normalizeListedFileRel(rel) {
  let s = String(rel || '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  s = s.replace(/%2F/gi, '/');
  return s.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * 将 ``GET /api/layers/:id/files`` 返回的相对路径解析为绝对路径，与 {@link listFlatRelativeFilesForLayer} 一致。
 * 克隆在子目录时列表为「仓库目录名/…」，而 {@link layerPrimaryGitWorkdir} 已落在该子目录内，若再拼接整段 ``rel`` 会得到 ``…/goPractice/goPractice/README.md`` 并 404。
 * 另兼容历史 children API 相对 primary 工作区、无仓库前缀的路径。
 * @param {string} layerId
 * @param {string} rel - 与列表 API 相同，用 / 分隔
 * @returns {string | null}
 */
export function resolveAbsolutePathForLayerListedFile(layerId, rel) {
  const relNorm = normalizeListedFileRel(rel);
  if (!relNorm) return null;
  const parts = relNorm.split('/').filter((p) => p.length);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null;

  const roots = layerGitWorkdirRootsForFileListing(layerId);
  if (!roots.length) return null;

  for (const { workdir, relPrefix } of roots) {
    const wResolved = path.resolve(workdir);
    try {
      if (relPrefix) {
        if (parts[0] !== relPrefix) continue;
        const insideParts = parts.slice(1);
        if (!insideParts.length) continue;
        const candidate = path.resolve(path.join(workdir, ...insideParts));
        if (candidate !== wResolved && !candidate.startsWith(wResolved + path.sep)) continue;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } else {
        const candidate = path.resolve(path.join(workdir, ...parts));
        if (candidate !== wResolved && !candidate.startsWith(wResolved + path.sep)) continue;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    } catch {
      /* ignore */
    }
  }

  // 兼容：旧 children 相对 layerPrimaryGitWorkdir 返回无前缀路径
  const primary = layerPrimaryGitWorkdir(layerId);
  if (primary) {
    try {
      const wResolved = path.resolve(primary);
      const candidate = path.resolve(path.join(primary, ...parts));
      if (
        (candidate === wResolved || candidate.startsWith(wResolved + path.sep)) &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile()
      ) {
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

