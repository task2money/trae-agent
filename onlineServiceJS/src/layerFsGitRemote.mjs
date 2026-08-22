/**
 * 层 Git dirty / 远端 ahead 快照（从 layerFs 拆出以满足行数门禁）。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { gitCmd } from './gitCmd.mjs';
import {
  LAYER_ID_RE,
  layerPath,
  layerPrimaryGitWorkdir,
  layerGitWorkdirRootsForFileListing,
} from './layerFs.mjs';
import {
  clearLayerLastPushError,
  withRememberedLastPushError,
} from './layerFsGitLastPushError.mjs';

function dirHasGit(p) {
  try {
    return fs.existsSync(path.join(p, '.git'));
  } catch {
    return false;
  }
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

function gitPrHtmlUrlPath(layerId) {
  return path.join(layerPath(layerId), 'git_pr_html_url');
}

/**
 * 推送并创建 PR/MR 成功后记下审查页 URL，供层图刷新后 zTree 附着可点击 PR 链接。
 * @param {string} layerId
 * @param {string} htmlUrl
 * @returns {boolean}
 */
export function rememberLayerPrHtmlUrl(layerId, htmlUrl) {
  const lid = String(layerId || '').trim();
  const url = String(htmlUrl || '').trim();
  if (!lid || !LAYER_ID_RE.test(lid) || !url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  const root = layerPath(lid);
  if (!fs.existsSync(root)) return false;
  fs.writeFileSync(gitPrHtmlUrlPath(lid), `${url}\n`, 'utf8');
  clearLayerLastPushError(lid);
  return true;
}

/**
 * @param {string} layerId
 * @returns {string}
 */
export function readLayerPrHtmlUrl(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid || !LAYER_ID_RE.test(lid)) return '';
  const p = gitPrHtmlUrlPath(lid);
  if (!fs.existsSync(p)) return '';
  try {
    const raw = String(fs.readFileSync(p, 'utf8').split('\n')[0] || '').trim();
    return /^https?:\/\//i.test(raw) ? raw : '';
  } catch {
    return '';
  }
}

/** @param {object} snap @param {string} layerId */
function withRememberedPrHtmlUrl(snap, layerId) {
  const pr = readLayerPrHtmlUrl(layerId);
  let out = snap;
  if (pr && snap && typeof snap === 'object') {
    out = { ...snap, pr_html_url: pr };
  }
  return withRememberedLastPushError(out, layerId);
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
 * 单工作树 ahead 快照（供层内多仓聚合）。
 * @param {string} work
 * @param {{ compareBranch?: string }} [opts]
 */
function gitRemoteSnapshotForWorkdir(work, opts = {}) {
  const empty = {
    is_git: false,
    ahead: null,
    no_upstream: true,
    upstream: '',
    current_branch: '',
    compare_branch: '',
  };
  const cwd = String(work || '').trim();
  if (!cwd || !dirHasGit(cwd)) return empty;

  const run = (args) =>
    spawnSync(gitCmd(), args, {
      cwd,
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

  const compare_branch = normalizeGitBranchName(opts?.compareBranch) || '';

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

  /** @type {string[]} */
  const defaultBranchCandidates = [];
  const originHead = run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead.status === 0) {
    const href = String(originHead.stdout || '').trim();
    const defaultBranch = normalizeGitBranchName(href);
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

/**
 * 聚合多仓 ahead：嵌套子仓有未推送提交时层快照也须 ahead>0，否则 ztree「推送」不出现
 *（仅查主仓时常见「相对父层有文件 / 提交禁用 / 推送也无」）。
 * @param {ReturnType<typeof gitRemoteSnapshotForWorkdir>[]} snaps
 */
export function aggregateGitRemoteSnapshots(snaps) {
  const empty = {
    is_git: false,
    ahead: null,
    no_upstream: true,
    upstream: '',
    current_branch: '',
    compare_branch: '',
  };
  const list = (Array.isArray(snaps) ? snaps : []).filter((s) => s && s.is_git);
  if (!list.length) return empty;

  let aheadSum = 0;
  let anyAheadKnown = false;
  let anyTracked = false;
  let current_branch = '';
  let upstream = '';
  let compare_branch = '';
  for (const s of list) {
    if (s.no_upstream !== true) anyTracked = true;
    if (typeof s.ahead === 'number' && Number.isFinite(s.ahead) && s.ahead >= 0) {
      aheadSum += Math.floor(s.ahead);
      anyAheadKnown = true;
    }
    if (!current_branch && s.current_branch) current_branch = s.current_branch;
    if (!upstream && s.upstream) upstream = s.upstream;
    if (!compare_branch && s.compare_branch) compare_branch = s.compare_branch;
  }
  return {
    is_git: true,
    ahead: anyAheadKnown ? aheadSum : null,
    no_upstream: !anyTracked,
    upstream,
    current_branch,
    compare_branch,
  };
}

/**
 * 与层快照 `git_remote`、前端「推送」旁提交数一致。
 * ahead：层内各 git 工作树（含 staging→移入后的嵌套子仓）相对推送目标未推送提交数之和。
 * @param {string} layerId
 * @param {{ compareBranch?: string }} [opts]
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

  const compare_branch =
    normalizeGitBranchName(opts?.compareBranch) || readLayerGitPushCompareBranch(lid) || '';
  const perOpts = compare_branch ? { compareBranch: compare_branch } : {};

  const roots = layerGitWorkdirRootsForFileListing(lid).filter(
    (r) => r?.workdir && dirHasGit(r.workdir),
  );
  if (!roots.length) {
    const work = layerPrimaryGitWorkdir(lid);
    if (!work || !dirHasGit(work)) return withRememberedPrHtmlUrl({ ...empty }, lid);
    return withRememberedPrHtmlUrl(gitRemoteSnapshotForWorkdir(work, perOpts), lid);
  }

  const snaps = roots.map((r) => gitRemoteSnapshotForWorkdir(r.workdir, perOpts));
  return withRememberedPrHtmlUrl(aggregateGitRemoteSnapshots(snaps), lid);
}

