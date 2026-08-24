import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'node:child_process';
import { layersRoot, stateRoot, layerArtifactsRootPath } from './paths.mjs';
import { expandGitWorkdirRootsWithNested } from './layerFsNestedGit.mjs';

export { shouldSkipListingDirName } from './layerFsListingSkip.mjs';
export {
  findNestedGitRoots,
  expandGitWorkdirRootsWithNested,
  matchGitRootByLongestPrefix,
} from './layerFsNestedGit.mjs';

export const LAYER_ID_RE = /^(\d{8}_\d{6})_([0-9a-fA-F]+)$/;

const SKIP_NAMES = new Set(['__pycache__', '.DS_Store', '.git']);
const SKIP_RECURSIVE = new Set(['__pycache__', '.DS_Store']);

export function newLayerId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const suf = crypto.randomBytes(3).toString('hex');
  return `${ts}_${suf}`;
}

export function layerPath(layerId) {
  return path.join(layersRoot(), layerId);
}

export function readLayerMeta(layerId) {
  const p = path.join(layerPath(layerId), 'layer_meta.json');
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const kind = raw.kind;
    if (!['clone', 'job', 'empty'].includes(kind)) return null;
    let parent = raw.parent_layer_id ? String(raw.parent_layer_id).trim() : null;
    if (parent && !LAYER_ID_RE.test(parent)) parent = null;
    let clone_url = null;
    if (raw.clone_url != null && String(raw.clone_url).trim()) {
      clone_url = String(raw.clone_url).trim();
    }
    return { version: Number(raw.version || 1), kind, parent_layer_id: parent, clone_url };
  } catch {
    return null;
  }
}

export function writeLayerMeta(layerId, kind, parentLayerId = null) {
  const root = layerPath(layerId);
  fs.mkdirSync(root, { recursive: true });
  const payload = { version: 1, kind, parent_layer_id: parentLayerId };
  fs.writeFileSync(path.join(root, 'layer_meta.json'), JSON.stringify(payload, null, 2), 'utf8');
}

export function createEmptyLayer(layerId) {
  const p = layerPath(layerId);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
  writeLayerMeta(layerId, 'empty', null);
  return p;
}

export function createRootLayer(layerId) {
  const p = layerPath(layerId);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function dirHasGit(p) {
  const g = path.join(p, '.git');
  try {
    return fs.existsSync(g);
  } catch {
    return false;
  }
}

/** 层内用于 git / 任务的工作目录（与 Python layer_fs 语义接近） */
export function layerPrimaryGitWorkdir(layerId) {
  const root = layerPath(layerId);
  if (!fs.existsSync(root)) return null;
  if (dirHasGit(root)) return root;
  const base = path.join(root, 'base');
  if (fs.existsSync(base) && dirHasGit(base)) return base;
  try {
    const subs = fs.readdirSync(root, { withFileTypes: true });
    for (const ent of subs) {
      if (!ent.isDirectory() || SKIP_NAMES.has(ent.name)) continue;
      const c = path.join(root, ent.name);
      if (dirHasGit(c)) return c;
    }
  } catch {
    /* ignore */
  }
  return root;
}

/**
 * 扁平文件列表 API 用的工作区根：一层内多仓并列时返回多个根，相对路径带仓库目录名前缀；
 * 父仓内嵌套独立 `.git`（staging 移入后）也会展开，避免仅查父仓 porcelain 时
 * 「相对父层有文件变化但 git_worktree_dirty=false / 提交禁用」。
 * 与 {@link layerPrimaryGitWorkdir} 不同，后者只选一个「主」目录供部分旧路径。
 * @returns {{ workdir: string, relPrefix: string }[]}
 */
export function layerGitWorkdirRootsForFileListing(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid) return [];
  const root = layerPath(lid);
  if (!fs.existsSync(root)) return [];

  /** @type {{ workdir: string, relPrefix: string }[]} */
  let top = [];
  if (dirHasGit(root)) {
    top = [{ workdir: root, relPrefix: '' }];
  } else {
    const base = path.join(root, 'base');
    if (fs.existsSync(base) && dirHasGit(base)) {
      top = [{ workdir: base, relPrefix: '' }];
    } else {
      try {
        const subs = fs.readdirSync(root, { withFileTypes: true });
        const names = [];
        for (const ent of subs) {
          if (!ent.isDirectory() || SKIP_NAMES.has(ent.name)) continue;
          const c = path.join(root, ent.name);
          if (dirHasGit(c)) names.push(ent.name);
        }
        names.sort();
        for (const name of names) {
          top.push({ workdir: path.join(root, name), relPrefix: name });
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!top.length) {
    return [{ workdir: root, relPrefix: '' }];
  }
  return expandGitWorkdirRootsWithNested(top);
}

/**
 * 项目文件树点击目录拉取 git log 时，解析应执行 `git log` 的工作目录与 pathspec，与
 * {@link layerGitWorkdirRootsForFileListing} 多仓前缀语义一致，避免只使用 {@link layerPrimaryGitWorkdir} 在「第一个仓」上误跑其它仓的路径。
 * @param {string} layerId
 * @param {string} rawPath - 与 flat files 相同，如 `goPractice/README.md` 或 `goPractice`
 * @returns {{ work: string, pathspec: string | null } | null}
 */
export function resolveLayerGitLogContext(layerId, rawPath) {
  const lid = String(layerId || '').trim();
  if (!lid) return null;
  const norm = String(rawPath || '').trim().replace(/\\/g, '/');
  const segs = norm ? norm.split('/').filter((x) => x.length) : [];
  for (const seg of segs) {
    if (seg === '..' || seg === '.') return null;
  }
  const roots = layerGitWorkdirRootsForFileListing(lid);
  if (!roots.length) return null;
  if (segs.length === 0) {
    const w = layerPrimaryGitWorkdir(lid);
    return w ? { work: w, pathspec: null } : null;
  }
  if (roots.length === 1 && !roots[0].relPrefix) {
    return { work: roots[0].workdir, pathspec: segs.join('/') };
  }
  for (const { workdir, relPrefix } of roots) {
    if (!relPrefix) continue;
    if (segs[0] !== relPrefix) continue;
    const rest = segs.slice(1);
    return { work: workdir, pathspec: rest.length ? rest.join('/') : null };
  }
  const w = layerPrimaryGitWorkdir(lid);
  if (w) return { work: w, pathspec: segs.join('/') };
  return null;
}

/**
 * 文件树点击的目录是否为 Git 仓库根（该目录下存在 `.git`）。
 * @param {{ work: string, pathspec: string | null } | null} ctx
 * @returns {boolean}
 */
export function clickedPathIsGitRepoRoot(ctx) {
  if (!ctx || !ctx.work) return false;
  const abs = ctx.pathspec ? path.join(ctx.work, ctx.pathspec) : ctx.work;
  return dirHasGit(abs);
}

export {
  listFlatRelativeFilesForLayer,
  resolveAbsolutePathForLayerListedFile,
} from './layerFsFlatFiles.mjs';

export {
  gitWorktreeDirty,
  normalizeGitBranchName,
  markOriginRemoteTrackingToHead,
  rememberLayerGitPushCompareBranch,
  readLayerGitPushCompareBranch,
  rememberLayerPrHtmlUrl,
  readLayerPrHtmlUrl,
  layerGitRemoteSnapshot,
} from './layerFsGitRemote.mjs';

export function layerRootOrChildHasGit(layerDir) {
  try {
    for (const base of [layerDir, path.join(layerDir, 'base')]) {
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;
      if (dirHasGit(base)) return true;
      const subs = fs.readdirSync(base, { withFileTypes: true });
      for (const ent of subs) {
        if (!ent.isDirectory() || SKIP_NAMES.has(ent.name)) continue;
        if (dirHasGit(path.join(base, ent.name))) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function listLayerRows() {
  const root = layersRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (!LAYER_ID_RE.test(name)) continue;
    const p = path.join(root, name);
    if (!fs.statSync(p).isDirectory()) continue;
    const m = name.match(LAYER_ID_RE);
    let createdAt = null;
    if (m) {
      const ts = m[1].replace('_', '');
      if (ts.length === 14) {
        const y = ts.slice(0, 4);
        const mo = ts.slice(4, 6);
        const da = ts.slice(6, 8);
        const h = ts.slice(8, 10);
        const mi = ts.slice(10, 12);
        const s = ts.slice(12, 14);
        createdAt = `${y}-${mo}-${da}T${h}:${mi}:${s}`;
      }
    }
    out.push({ layer_id: name, created_at: createdAt });
  }
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return out;
}

export function anyLayerHasGitRepo() {
  for (const row of listLayerRows()) {
    if (layerRootOrChildHasGit(layerPath(row.layer_id))) return true;
  }
  return false;
}

function copyEntry(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP_RECURSIVE.has(ent.name)) continue;
      copyEntry(path.join(src, ent.name), path.join(dest, ent.name));
    }
  } else if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
  } else {
    fs.copyFileSync(src, dest);
  }
}

function useOverlayStack() {
  return String(process.env.TRAE_USE_OVERLAY_STACK || '').trim() === '1';
}

function mountStackedOverlay(childDir, parentDir, childId) {
  const base = path.join(stateRoot(), 'overlay_stack', childId);
  const upper = path.join(base, 'upper');
  const work = path.join(base, 'work');
  fs.mkdirSync(upper, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const opts = `lowerdir=${parentDir},upperdir=${upper},workdir=${work}`;
  const r = spawnSync('mount', ['-t', 'overlay', 'overlay', '-o', opts, childDir], {
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || r.error?.message || '').trim() || `exit ${r.status}`;
    throw new Error(`overlay mount failed: ${msg}`);
  }
}

function createStackedLayerCopy(childId, parentLayerId) {
  const parentDir = layerPath(parentLayerId);
  const childDir = layerPath(childId);
  if (!fs.existsSync(parentDir)) throw new Error(`parent layer not found: ${parentLayerId}`);
  if (fs.existsSync(childDir)) fs.rmSync(childDir, { recursive: true, force: true });
  fs.mkdirSync(childDir, { recursive: true });
  for (const ent of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (ent.name === '.git' || SKIP_NAMES.has(ent.name)) continue;
    copyEntry(path.join(parentDir, ent.name), path.join(childDir, ent.name));
  }
  const pg = path.join(parentDir, '.git');
  const cg = path.join(childDir, '.git');
  if (fs.existsSync(pg)) {
    try {
      if (fs.existsSync(cg)) fs.rmSync(cg, { recursive: true, force: true });
      const rel = path.join('..', parentLayerId, '.git');
      fs.symlinkSync(rel, cg, 'dir');
    } catch {
      /* ignore symlink failure on Windows rare */
    }
  }
  writeLayerMeta(childId, 'job', parentLayerId);
  return childDir;
}

function createStackedLayerOverlay(childId, parentLayerId) {
  const parentDir = layerPath(parentLayerId);
  const childDir = layerPath(childId);
  if (!fs.existsSync(parentDir)) throw new Error(`parent layer not found: ${parentLayerId}`);
  deleteLayerTree(childId);
  fs.mkdirSync(childDir, { recursive: true });
  const base = path.join(stateRoot(), 'overlay_stack', childId);
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(base, 'upper'), { recursive: true });
  fs.mkdirSync(path.join(base, 'work'), { recursive: true });
  mountStackedOverlay(childDir, parentDir, childId);
  writeLayerMeta(childId, 'job', parentLayerId);
  return childDir;
}

export function createStackedLayer(childId, parentLayerId) {
  if (!useOverlayStack()) {
    return createStackedLayerCopy(childId, parentLayerId);
  }
  try {
    return createStackedLayerOverlay(childId, parentLayerId);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    console.warn(
      '[layerFs] overlay 叠层失败，已回退为目录拷贝（常见于 Docker bind 卷/部分内核）。原因:',
      (msg.split('\n').find((s) => s.trim()) || msg).trim(),
    );
    try {
      deleteLayerTree(childId);
    } catch {
      /* ignore */
    }
    return createStackedLayerCopy(childId, parentLayerId);
  }
}

export function directChildLayerIds(baseLayerId) {
  const out = [];
  for (const row of listLayerRows()) {
    if (row.layer_id === baseLayerId) continue;
    const m = readLayerMeta(row.layer_id);
    if (m && m.parent_layer_id === baseLayerId) out.push(row.layer_id);
  }
  return out;
}

export function deleteLayerTree(layerId) {
  const p = layerPath(layerId);
  if (fs.existsSync(p)) {
    spawnSync('umount', [p], { stdio: 'ignore', env: process.env });
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  const ob = path.join(stateRoot(), 'overlay_stack', layerId);
  if (fs.existsSync(ob)) {
    try {
      fs.rmSync(ob, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    const art = layerArtifactsRootPath(layerId);
    if (fs.existsSync(art)) fs.rmSync(art, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 从 clone URL 推导层内子目录名。须支持 HTTPS 与 SCP 风格（`git@host:group/repo.git`）；
 * 后者不能用 WHATWG URL 解析，否则会落到默认 `repo`，多仓并行克隆互相踩目录。
 */
export function sanitizeCloneDirName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/(?:^[-._]+|[-._]+$)/g, '') || '';
}

/**
 * 相对路径别名（允许 `/`）：按段 sanitize，拒绝 `..` / 绝对路径。
 * 用于 nested 子仓在父仓工作树内的落点（如 `task2app`、`libs/foo`）。
 */
export function sanitizeCloneRelPath(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/\\/g, '/');
  if (!s || s.startsWith('/')) return '';
  const parts = s.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return '';
  const out = [];
  for (const p of parts) {
    if (p === '..') return '';
    const seg = sanitizeCloneDirName(p);
    if (!seg) return '';
    out.push(seg);
  }
  return out.join('/');
}

/** 优先使用用户别名，否则从 URL 推导（单段目录名；`/` 仍压成 `-`，兼容顶层别名）。 */
export function resolveRepoCloneDirName(url, cloneAlias) {
  const fromAlias = sanitizeCloneDirName(cloneAlias);
  if (fromAlias) return fromAlias;
  return repoDirNameFromUrl(url);
}

/**
 * 层内相对落点路径：优先保留别名中的 `/` 分段；否则回退 {@link resolveRepoCloneDirName}。
 */
export function resolveRepoCloneRelPath(url, cloneAlias) {
  const rel = sanitizeCloneRelPath(cloneAlias);
  if (rel) return rel;
  return resolveRepoCloneDirName(url, cloneAlias);
}

/**
 * 将已完成的 clone 目录移到最终位置（覆盖空占位或旧目录）。
 * 同卷优先 rename；跨卷失败时 copy+rm。
 */
export function relocateClonedRepo(stagingDir, finalDir) {
  const from = path.resolve(String(stagingDir || ''));
  const to = path.resolve(String(finalDir || ''));
  if (!from || !to) throw new Error('relocateClonedRepo: empty path');
  if (from === to) return;
  if (!fs.existsSync(from)) throw new Error(`relocateClonedRepo: staging missing: ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) {
    fs.rmSync(to, { recursive: true, force: true });
  }
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export function repoDirNameFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return 'repo';
  let pathPart = '';
  try {
    const u = new URL(raw);
    pathPart = String(u.pathname || '');
  } catch {
    const scp = raw.match(/^[^@\s]+@[^:\s]+:(.+)$/);
    if (scp && scp[1]) {
      pathPart = String(scp[1]).replace(/^\/+/, '');
    } else {
      pathPart = raw;
    }
  }
  let base = pathPart.split('/').filter(Boolean).pop() || 'repo';
  if (base.toLowerCase().endsWith('.git')) base = base.slice(0, -4);
  return sanitizeCloneDirName(base) || 'repo';
}

export function resolvedParentLayerId(layerId, knownIds, jobs) {
  const meta = readLayerMeta(layerId);
  if (meta?.parent_layer_id && knownIds.has(meta.parent_layer_id)) return meta.parent_layer_id;
  const work = layerPrimaryGitWorkdir(layerId);
  if (!work) return null;
  let cur = path.dirname(work);
  const root = layersRoot();
  while (cur && cur.startsWith(root)) {
    const name = path.basename(cur);
    if (knownIds.has(name) && name !== layerId) return name;
    const parentDir = path.dirname(cur);
    if (parentDir === cur) break;
    cur = parentDir;
  }
  return null;
}
