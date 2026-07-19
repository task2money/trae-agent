/**
 * 层内多 git 工作树提交：脏子仓优先，再同步父仓 `.nested-repo-heads` 关联。
 * 不引入 mode=160000 gitlink（见 docs/dev/nested-repos-submodule-eval.md）。
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { gitCmd } from './gitCmd.mjs';
import { layerGitWorkdirRootsForFileListing } from './layerFs.mjs';

function gitExecSync(args, cwd) {
  const r = spawnSync(gitCmd(), args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim() || `git ${args[0]} failed`;
    throw new Error(err.slice(0, 800));
  }
  return (r.stdout || '').trim();
}

function gitStatusOk(args, cwd) {
  return spawnSync(gitCmd(), args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 10 * 1024 * 1024,
  });
}

export function workdirIsGitDirty(workdir) {
  const cwd = String(workdir || '').trim();
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) return false;
  try {
    const r = gitStatusOk(['status', '--porcelain'], cwd);
    if (r.error || r.status !== 0) return false;
    return (r.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

function headSha(workdir) {
  try {
    return gitExecSync(['rev-parse', 'HEAD'], workdir);
  } catch {
    return '';
  }
}

function hasCachedChanges(workdir) {
  const r = gitStatusOk(['diff', '--cached', '--quiet'], workdir);
  return r.status !== 0;
}

function commitOneWorkdir(workdir, message, stageAll) {
  if (stageAll) gitExecSync(['add', '-A'], workdir);
  if (!hasCachedChanges(workdir)) return null;
  gitExecSync(['commit', '-m', message], workdir);
  return headSha(workdir);
}

/**
 * 父仓存在 `.gitmodules` 时，把子仓 path→HEAD 写入 `.nested-repo-heads`。
 * @returns {boolean} 是否写入了文件
 */
export function syncNestedRepoHeadsFile(parentWorkdir, nestedEntries) {
  const parent = String(parentWorkdir || '').trim();
  if (!parent || !fs.existsSync(path.join(parent, '.gitmodules'))) return false;
  const list = Array.isArray(nestedEntries) ? nestedEntries : [];
  if (!list.length) return false;

  const pinPath = path.join(parent, '.nested-repo-heads');
  /** @type {Map<string, string>} */
  const map = new Map();
  if (fs.existsSync(pinPath)) {
    for (const line of fs.readFileSync(pinPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const tab = t.indexOf('\t');
      const sp = t.indexOf(' ');
      const sep = tab >= 0 ? tab : sp;
      if (sep <= 0) continue;
      const p = t.slice(0, sep).trim();
      const sha = t.slice(sep + 1).trim();
      if (p && sha) map.set(p, sha);
    }
  }
  for (const ent of list) {
    const p = String(ent.path || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const sha = String(ent.sha || '').trim();
    if (p && sha) map.set(p, sha);
  }
  const lines = [
    '# path<TAB>sha — nested independent repos (not gitlink)',
    ...[...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([p, sha]) => `${p}\t${sha}`),
  ];
  fs.writeFileSync(pinPath, `${lines.join('\n')}\n`, 'utf8');
  return true;
}

function findNearestAncestorRoot(row, roots) {
  const cur = row.relPrefix || '';
  const ancestors = roots
    .filter((p) => {
      if (p.workdir === row.workdir) return false;
      const pre = p.relPrefix || '';
      if (!pre) {
        return Boolean(cur) && String(row.workdir).startsWith(`${p.workdir}${path.sep}`);
      }
      return cur.startsWith(`${pre}/`);
    })
    .sort((a, b) => (b.relPrefix || '').length - (a.relPrefix || '').length);
  return ancestors[0] || null;
}

/**
 * @param {string} layerId
 * @param {{ message?: string, stage_all?: boolean }} [opts]
 * @returns {{ ok: true, committed: { rel_prefix: string, sha: string }[] }}
 */
export function commitLayerGitWorkdirs(layerId, opts = {}) {
  const lid = String(layerId || '').trim();
  const msg = (opts.message || 'commit').toString();
  const doStageAll = opts.stage_all === undefined || opts.stage_all === true;
  const roots = layerGitWorkdirRootsForFileListing(lid).filter((r) => {
    try {
      return r?.workdir && fs.existsSync(path.join(r.workdir, '.git'));
    } catch {
      return false;
    }
  });
  if (!roots.length) {
    const err = new Error('no git');
    err.code = 'NO_GIT';
    throw err;
  }

  const prefixDepth = (p) => {
    const s = String(p || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (!s) return 0;
    return s.split('/').filter(Boolean).length;
  };
  const dirty = roots
    .filter((r) => workdirIsGitDirty(r.workdir))
    .sort((a, b) => prefixDepth(b.relPrefix) - prefixDepth(a.relPrefix));

  /** @type {{ rel_prefix: string, sha: string }[]} */
  const committed = [];
  /** @type {Map<string, { path: string, sha: string }[]>} */
  const nestedByParentWorkdir = new Map();

  // 1) 先提交嵌套子仓（有祖先根的），避免父仓先 add 到无关状态
  const nestedDirty = dirty.filter((r) => findNearestAncestorRoot(r, roots));
  const topDirty = dirty.filter((r) => !findNearestAncestorRoot(r, roots));

  for (const row of nestedDirty) {
    const sha = commitOneWorkdir(row.workdir, msg, doStageAll);
    if (!sha) continue;
    committed.push({ rel_prefix: row.relPrefix || '', sha });
    const parent = findNearestAncestorRoot(row, roots);
    if (!parent) continue;
    const pre = parent.relPrefix || '';
    const cur = row.relPrefix || '';
    const relToParent = pre ? cur.slice(pre.length + 1) : cur;
    if (!nestedByParentWorkdir.has(parent.workdir)) nestedByParentWorkdir.set(parent.workdir, []);
    nestedByParentWorkdir.get(parent.workdir).push({ path: relToParent, sha });
  }

  // 2) 父仓关联 pin
  for (const [parentWorkdir, entries] of nestedByParentWorkdir) {
    syncNestedRepoHeadsFile(parentWorkdir, entries);
  }

  // 3) 提交顶层脏仓 + 因 pin 变脏的父仓
  const parentDirtyAfterPin = roots.filter(
    (r) => nestedByParentWorkdir.has(r.workdir) && workdirIsGitDirty(r.workdir),
  );
  const round2 = [...topDirty, ...parentDirtyAfterPin]
    .filter((r, i, arr) => arr.findIndex((x) => x.workdir === r.workdir) === i)
    .sort((a, b) => (b.relPrefix || '').length - (a.relPrefix || '').length);

  for (const row of round2) {
    if (!workdirIsGitDirty(row.workdir)) continue;
    const pinMsg = nestedByParentWorkdir.has(row.workdir)
      ? `${msg}\n\nchore(nested): record nested-repo heads`
      : msg;
    const sha = commitOneWorkdir(row.workdir, pinMsg, doStageAll);
    if (!sha) continue;
    const existing = committed.findIndex((c) => c.rel_prefix === (row.relPrefix || ''));
    if (existing >= 0) committed[existing] = { rel_prefix: row.relPrefix || '', sha };
    else committed.push({ rel_prefix: row.relPrefix || '', sha });
  }

  if (!committed.length) {
    const err = new Error('nothing to commit');
    err.code = 'NOTHING_TO_COMMIT';
    throw err;
  }
  return { ok: true, committed };
}

function revListCount(workdir, range) {
  const r = gitStatusOk(['rev-list', '--count', range], workdir);
  if (r.status !== 0) return null;
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

function refExists(workdir, ref) {
  const r = gitStatusOk(['rev-parse', '--verify', ref], workdir);
  return r.status === 0;
}

function hasOriginRemote(workdir) {
  const r = gitStatusOk(['config', '--get', 'remote.origin.url'], workdir);
  return r.status === 0 && Boolean(String(r.stdout || '').trim());
}

function hasAnyOriginTracking(workdir) {
  try {
    const p = path.join(workdir, '.git', 'refs', 'remotes', 'origin');
    if (fs.existsSync(p)) {
      const walk = (d) => {
        let ents;
        try {
          ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return false;
        }
        for (const e of ents) {
          if (e.isFile()) return true;
          if (e.isDirectory() && walk(path.join(d, e.name))) return true;
        }
        return false;
      };
      if (walk(p)) return true;
    }
    // packed-refs 也可能含 origin
    const packed = path.join(workdir, '.git', 'packed-refs');
    if (fs.existsSync(packed)) {
      const txt = fs.readFileSync(packed, 'utf8');
      if (/refs\/remotes\/origin\//.test(txt)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 工作树是否需要 push：仍脏，或相对远端有可推送提交。
 * 已 clone 且与 origin/main 同步的干净嵌套仓 → false；
 * 仅 local commit、尚未 fetch 过 tracking 的仓 → true（允许推新建目标分支）。
 */
export function workdirNeedsPush(workdir, targetBranch) {
  const cwd = String(workdir || '').trim();
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) return false;
  if (workdirIsGitDirty(cwd)) return true;
  const branch = String(targetBranch || '')
    .trim()
    .replace(/^refs\/heads\//, '');
  if (branch && refExists(cwd, `refs/remotes/origin/${branch}`)) {
    const n = revListCount(cwd, `origin/${branch}..HEAD`);
    return n != null && n > 0;
  }
  try {
    const r = gitStatusOk(['rev-list', '--count', '@{u}..HEAD'], cwd);
    if (r.status === 0) {
      const n = Number(String(r.stdout || '').trim());
      if (Number.isFinite(n) && n > 0) return true;
      if (Number.isFinite(n) && n === 0) return false;
    }
  } catch {
    /* ignore */
  }
  for (const base of ['origin/HEAD', 'origin/main', 'origin/master']) {
    if (!refExists(cwd, base === 'origin/HEAD' ? 'refs/remotes/origin/HEAD' : `refs/remotes/${base}`)) {
      continue;
    }
    const n = revListCount(cwd, `${base}..HEAD`);
    if (n != null && n > 0) return true;
    if (n === 0) return false;
  }
  // 配置了 origin 但从未有 tracking（如测试仓 init+commit）：允许尝试推送
  if (hasOriginRemote(cwd) && refExists(cwd, 'HEAD') && !hasAnyOriginTracking(cwd)) {
    return true;
  }
  return false;
}
