/**
 * 父层 diff：优先用 git status / tree-diff 生成变动路径，walk 仅作无 git 回退。
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { gitCmd, gitCloneConfigArgs } from './gitCmd.mjs';
import { collectIndex } from './layerParentDiffCollect.mjs';
import {
  classifyPathChange,
  compareIndices,
  normalizeRel,
} from './layerParentDiffCompare.mjs';

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0' };

function gitExec(cwd, args) {
  return execFileSync(gitCmd(), [...gitCloneConfigArgs(), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
    maxBuffer: 32 * 1024 * 1024,
  });
}

function isGitWorktree(cwd) {
  const dir = String(cwd || '').trim();
  if (!dir) return false;
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return false;
    const out = String(gitExec(dir, ['rev-parse', '--is-inside-work-tree']) || '').trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/** @returns {string[]|null} null = git 调用失败 */
function gitNameOnlyZ(cwd, args) {
  try {
    const out = String(gitExec(cwd, args) || '');
    return out
      .split('\0')
      .map((s) => normalizeRel(s))
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** @returns {Set<string>|null} */
function statusPathSet(cwd) {
  const staged = gitNameOnlyZ(cwd, ['diff', '--cached', '--name-only', '-z']);
  const unstaged = gitNameOnlyZ(cwd, ['diff', '--name-only', '-z']);
  const untracked = gitNameOnlyZ(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (staged === null || unstaged === null || untracked === null) return null;
  return new Set([...staged, ...unstaged, ...untracked]);
}

function revParseHead(cwd) {
  try {
    return String(gitExec(cwd, ['rev-parse', 'HEAD']) || '').trim();
  } catch {
    return '';
  }
}

/** 解析 `git diff --name-status -z` */
export function parseNameStatusZ(buf) {
  const parts = String(buf || '')
    .split('\0')
    .filter((s) => s !== '');
  const paths = new Set();
  let i = 0;
  while (i < parts.length) {
    const st = parts[i++];
    if (!st) break;
    if (st[0] === 'R' || st[0] === 'C') {
      const oldP = parts[i++];
      const newP = parts[i++];
      if (oldP) paths.add(normalizeRel(oldP));
      if (newP) paths.add(normalizeRel(newP));
    } else {
      const p = parts[i++];
      if (p) paths.add(normalizeRel(p));
    }
  }
  return paths;
}

/** @returns {Set<string>|null} */
function treeDiffPathSet(cwd, ha, hb) {
  if (!ha || !hb || ha === hb) return new Set();
  try {
    const out = String(gitExec(cwd, ['diff', '--name-status', '-z', ha, hb]) || '');
    return parseNameStatusZ(out);
  } catch {
    return null;
  }
}

/**
 * 解析 `git ls-tree -r -z`：`mode SP type SP object TAB path\0`
 * @returns {Map<string, string>|null} path → `type:object`
 */
export function parseLsTreeZ(buf) {
  const map = new Map();
  const parts = String(buf || '').split('\0');
  for (const ent of parts) {
    if (!ent) continue;
    const tab = ent.indexOf('\t');
    if (tab < 0) continue;
    const meta = ent.slice(0, tab);
    const rel = normalizeRel(ent.slice(tab + 1));
    if (!rel) continue;
    const bits = meta.split(/\s+/);
    if (bits.length < 3) continue;
    const type = bits[1];
    const object = bits[2];
    map.set(rel, `${type}:${object}`);
  }
  return map;
}

/** @returns {Map<string, string>|null} */
function lsTreeBlobMap(cwd) {
  try {
    const out = String(gitExec(cwd, ['ls-tree', '-r', '-z', 'HEAD']) || '');
    return parseLsTreeZ(out);
  } catch {
    return null;
  }
}

/**
 * 两端各自 ls-tree，不依赖跨仓对象可见性（独立 clone HEAD 分叉）。
 * @returns {Set<string>|null}
 */
function dualLsTreeDiffPaths(workP, workC) {
  const mapP = lsTreeBlobMap(workP);
  const mapC = lsTreeBlobMap(workC);
  if (!mapP || !mapC) return null;
  const paths = new Set([...mapP.keys(), ...mapC.keys()]);
  const out = new Set();
  for (const p of paths) {
    if (mapP.get(p) !== mapC.get(p)) out.add(p);
  }
  return out;
}

/**
 * HEAD 分叉时的路径候选：先跨仓 tree-diff；对象不可见则双端 ls-tree。
 * @returns {Set<string>|null} null = 两种方式均失败
 */
function headDivergeCandidates(workP, workC, hp, hc) {
  if (!hp || !hc || hp === hc) return new Set();
  let td = treeDiffPathSet(workC, hp, hc);
  if (!td) td = treeDiffPathSet(workP, hp, hc);
  if (td) return td;
  return dualLsTreeDiffPaths(workP, workC);
}

/**
 * @param {string} workP
 * @param {string} workC
 * @returns {{ ok: true, changes: Array<{path:string,kind:string}> } | { ok: false }}
 */
function tryCollectViaGit(workP, workC) {
  if (!isGitWorktree(workP) || !isGitWorktree(workC)) return { ok: false };

  const setP = statusPathSet(workP);
  const setC = statusPathSet(workC);
  if (!setP || !setC) return { ok: false };

  const candidates = new Set([...setP, ...setC]);
  const hp = revParseHead(workP);
  const hc = revParseHead(workC);
  if (hp && hc && hp !== hc) {
    const diverged = headDivergeCandidates(workP, workC, hp, hc);
    if (!diverged) return { ok: false };
    for (const p of diverged) candidates.add(p);
  }

  const changes = [];
  for (const rel of [...candidates].sort()) {
    const kind = classifyPathChange(workP, workC, rel);
    if (kind) changes.push({ path: rel, kind });
  }
  return { ok: true, changes };
}

/**
 * 配对工作区变动：git-first，失败或不适用则 walk。
 * @returns {{ changes: Array<{path:string,kind:string}>, truncated: boolean, strategy: 'git'|'walk' }}
 */
export function collectPairChanges(workP, workC) {
  const viaGit = tryCollectViaGit(workP, workC);
  if (viaGit.ok) {
    return { changes: viaGit.changes, truncated: false, strategy: 'git' };
  }
  const cp = collectIndex(workP);
  const cc = collectIndex(workC);
  return {
    changes: compareIndices(workP, workC, cp.map, cc.map),
    truncated: cp.truncated || cc.truncated,
    strategy: 'walk',
  };
}
