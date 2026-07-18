import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'node:child_process';
import { layersRoot, stateRoot, layerArtifactsRootPath } from './paths.mjs';
import { gitCmd } from './gitCmd.mjs';

function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
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

export const LAYER_ID_RE = /^(\d{8}_\d{6})_([0-9a-fA-F]+)$/;

const SKIP_NAMES = new Set(['__pycache__', '.DS_Store', '.git']);
const SKIP_RECURSIVE = new Set(['__pycache__', '.DS_Store']);
/** 文件树扁平列表跳过的目录名（避免 node_modules 等占满 max_files 导致顶层目录缺失） */
const SKIP_LISTING_DIR_NAMES = new Set([
  '__pycache__',
  '.DS_Store',
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  '.turbo',
  '.next',
  'coverage',
]);

function shouldSkipListingDirName(name) {
  const n = String(name || '');
  if (!n || SKIP_LISTING_DIR_NAMES.has(n)) return true;
  // 本地/工具虚拟环境：.venv-archimate 等
  if (n.startsWith('.venv')) return true;
  return false;
}

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
 * 与 {@link layerPrimaryGitWorkdir} 不同，后者只选一个「主」目录供 git 状态/提交。
 * @returns {{ workdir: string, relPrefix: string }[]}
 */
export function layerGitWorkdirRootsForFileListing(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid) return [];
  const root = layerPath(lid);
  if (!fs.existsSync(root)) return [];

  if (dirHasGit(root)) {
    return [{ workdir: root, relPrefix: '' }];
  }
  const base = path.join(root, 'base');
  if (fs.existsSync(base) && dirHasGit(base)) {
    return [{ workdir: base, relPrefix: '' }];
  }

  const out = [];
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
      out.push({ workdir: path.join(root, name), relPrefix: name });
    }
  } catch {
    /* ignore */
  }

  if (!out.length) {
    return [{ workdir: root, relPrefix: '' }];
  }
  return out;
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
 * 将 ``GET /api/layers/:id/files`` 返回的相对路径解析为绝对路径，与 {@link listFlatRelativeFilesForLayer} 一致。
 * 克隆在子目录时列表为「仓库目录名/…」，而 {@link layerPrimaryGitWorkdir} 已落在该子目录内，若再拼接整段 ``rel`` 会得到 ``…/goPractice/goPractice/README.md`` 并 404。
 * @param {string} layerId
 * @param {string} rel - 与列表 API 相同，用 / 分隔
 * @returns {string | null}
 */
export function resolveAbsolutePathForLayerListedFile(layerId, rel) {
  const relNorm = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
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
  return null;
}

/**
 * true：存在未提交/未暂存变更；false：工作区干净；null：非 git 或检测失败（与 Python layer_git.git_worktree_dirty 对齐）。
 * 多仓并列时：任一仓库 dirty 即为 true（与容器 UI「多仓克隆任一有变更则 dirty」一致；
 * 不可只查 layerPrimaryGitWorkdir，否则次仓有变更时文件变动列表有条目但 ztree 无「提交」）。
 */
export function gitWorktreeDirty(layerId) {
  if (!layerId || !LAYER_ID_RE.test(String(layerId))) return null;
  const roots = layerGitWorkdirRootsForFileListing(layerId);
  if (!roots.length) return null;
  let checked = 0;
  for (const { workdir } of roots) {
    if (!workdir || !dirHasGit(workdir)) continue;
    try {
      const r = spawnSync(gitCmd(), ['status', '--porcelain'], {
        cwd: workdir,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 60_000,
      });
      if (r.error || r.status !== 0) continue;
      checked += 1;
      if ((r.stdout || '').trim().length > 0) return true;
    } catch {
      /* 单仓失败不短路；全部失败则下方返回 null */
    }
  }
  if (checked === 0) return null;
  return false;
}

/**
 * 规范化分支名（去掉 refs/heads|remotes 前缀），拒绝危险字符。
 * @param {string} branchRefOrName
 * @returns {string}
 */
export function normalizeGitBranchName(branchRefOrName) {
  let name = String(branchRefOrName || '').trim();
  if (!name) return '';
  if (name.startsWith('refs/heads/')) {
    name = name.slice('refs/heads/'.length);
  } else if (name.startsWith('refs/remotes/')) {
    const parts = name.split('/');
    // refs/remotes/<remote>/<branch...>
    name = parts.length >= 4 ? parts.slice(3).join('/') : parts[parts.length - 1] || '';
  }
  if (!name || name.includes('..') || name.startsWith('-') || name.includes('\0')) return '';
  return name;
}

/**
 * 将 `refs/remotes/origin/<branch>` 指到当前 HEAD。
 * OAuth/URL 形式的 `git push <url> HEAD:refs/heads/X` 不会更新 remote-tracking，
 * 导致层快照 `git rev-list @{u}..HEAD` 在推送成功后仍 > 0。
 * @param {string} workdir
 * @param {string} branchRefOrName - `feature/x` 或 `refs/heads/feature/x`
 * @returns {boolean}
 */
export function markOriginRemoteTrackingToHead(workdir, branchRefOrName) {
  const cwd = String(workdir || '').trim();
  if (!cwd) return false;
  const name = normalizeGitBranchName(branchRefOrName);
  if (!name) return false;
  const ref = `refs/remotes/origin/${name}`;
  const r = spawnSync(gitCmd(), ['update-ref', ref, 'HEAD'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 15_000,
  });
  return r.status === 0;
}

function gitPushCompareBranchPath(layerId) {
  return path.join(layerPath(layerId), 'git_push_compare_branch');
}

/**
 * 推送成功后记下工作分支名，供 GET /api/layers 刷新时按「相对推送目标」算 ahead。
 * @param {string} layerId
 * @param {string} branchRefOrName
 * @returns {boolean}
 */
export function rememberLayerGitPushCompareBranch(layerId, branchRefOrName) {
  const lid = String(layerId || '').trim();
  if (!lid || !LAYER_ID_RE.test(lid)) return false;
  const name = normalizeGitBranchName(branchRefOrName);
  if (!name) return false;
  const root = layerPath(lid);
  if (!fs.existsSync(root)) return false;
  fs.writeFileSync(gitPushCompareBranchPath(lid), `${name}\n`, 'utf8');
  return true;
}

/**
 * @param {string} layerId
 * @returns {string}
 */
export function readLayerGitPushCompareBranch(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid || !LAYER_ID_RE.test(lid)) return '';
  const p = gitPushCompareBranchPath(lid);
  if (!fs.existsSync(p)) return '';
  try {
    return normalizeGitBranchName(fs.readFileSync(p, 'utf8').split('\n')[0] || '');
  } catch {
    return '';
  }
}

/**
 * 与层快照 `git_remote`、前端「推送」旁提交数一致；目录与 `layerPrimaryGitWorkdir` / `POST .../git/push` 相同。
 * ahead 语义：相对「推送目标 / 工作分支」未推送的提交数（不是盲目信 @{u}）。
 * 比较顺序：opts.compareBranch → 层内 remember → origin/<current_branch> → @{u}。
 * @param {string} layerId
 * @param {{ compareBranch?: string }} [opts]
 * @returns {{ is_git: boolean, ahead: number | null, no_upstream: boolean, upstream: string, current_branch: string, compare_branch: string }}
 */
export function layerGitRemoteSnapshot(layerId, opts = {}) {
  const empty = {
    is_git: false,
    ahead: null,
    no_upstream: true,
    upstream: '',
    current_branch: '',
    compare_branch: '',
  };
  const lid = String(layerId || '').trim();
  if (!lid || !LAYER_ID_RE.test(lid)) return empty;
  const work = layerPrimaryGitWorkdir(lid);
  if (!work || !dirHasGit(work)) return empty;

  const run = (args) =>
    spawnSync(gitCmd(), args, {
      cwd: work,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30_000,
    });

  const tree = run(['rev-parse', '--is-inside-work-tree']);
  if (tree.status !== 0 || String(tree.stdout || '').trim() !== 'true') {
    return empty;
  }

  const headRef = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const current_branch =
    headRef.status === 0 ? String(headRef.stdout || '').trim() : '';

  const compare_branch =
    normalizeGitBranchName(opts?.compareBranch) || readLayerGitPushCompareBranch(lid) || '';

  /** @type {string[]} */
  const candidateBranches = [];
  if (compare_branch) candidateBranches.push(compare_branch);
  if (current_branch && current_branch !== 'HEAD' && current_branch !== compare_branch) {
    candidateBranches.push(current_branch);
  }

  for (const branch of candidateBranches) {
    const remoteRef = `refs/remotes/origin/${branch}`;
    const verify = run(['rev-parse', '--verify', remoteRef]);
    if (verify.status !== 0) continue;
    const count = run(['rev-list', '--count', `origin/${branch}..HEAD`]);
    if (count.status !== 0) continue;
    const n = parseInt(String(count.stdout || '').trim(), 10);
    const ahead = Number.isFinite(n) && n >= 0 ? n : 0;
    return {
      is_git: true,
      ahead,
      no_upstream: false,
      upstream: `origin/${branch}`,
      current_branch,
      compare_branch,
    };
  }

  const upRef = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = String(upRef.stdout || '').trim();
  if (upRef.status === 0 && upstream) {
    const count = run(['rev-list', '--count', '@{u}..HEAD']);
    if (count.status !== 0) {
      return {
        is_git: true,
        ahead: null,
        no_upstream: false,
        upstream,
        current_branch,
        compare_branch,
      };
    }
    const n = parseInt(String(count.stdout || '').trim(), 10);
    const ahead = Number.isFinite(n) && n >= 0 ? n : 0;
    return {
      is_git: true,
      ahead,
      no_upstream: false,
      upstream,
      current_branch,
      compare_branch,
    };
  }

  // 无 @{u} 且无 origin/<current_branch>：回退 origin/HEAD（默认分支）算 ahead，
  // 避免 feature 本地名与远端不一致时 no_upstream=true / ahead=null，ztree 推送与提交门控全灭。
  /** @type {string[]} */
  const defaultBranchCandidates = [];
  const originHead = run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead.status === 0) {
    const headRef = String(originHead.stdout || '').trim(); // refs/remotes/origin/master
    const defaultBranch = normalizeGitBranchName(headRef);
    if (defaultBranch) defaultBranchCandidates.push(defaultBranch);
  }
  for (const b of ['master', 'main']) {
    if (!defaultBranchCandidates.includes(b)) defaultBranchCandidates.push(b);
  }
  for (const defaultBranch of defaultBranchCandidates) {
    const remoteRef = `refs/remotes/origin/${defaultBranch}`;
    const verify = run(['rev-parse', '--verify', remoteRef]);
    if (verify.status !== 0) continue;
    const count = run(['rev-list', '--count', `origin/${defaultBranch}..HEAD`]);
    if (count.status !== 0) continue;
    const n = parseInt(String(count.stdout || '').trim(), 10);
    const ahead = Number.isFinite(n) && n >= 0 ? n : 0;
    return {
      is_git: true,
      ahead,
      no_upstream: false,
      upstream: `origin/${defaultBranch}`,
      current_branch,
      compare_branch,
    };
  }

  return {
    is_git: true,
    ahead: null,
    no_upstream: true,
    upstream: '',
    current_branch,
    compare_branch,
  };
}

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
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || '';
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
