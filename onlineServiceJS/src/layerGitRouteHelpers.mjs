import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { gitCmd } from './gitCmd.mjs';

export { repoMatchKeyFromUrl } from './repoMatchKey.mjs';

export function gitConfigGetSync(args, cwd) {
  try {
    const out = spawnSync(gitCmd(), args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 1024 * 1024,
    });
    if (out.status !== 0) return '';
    return String(out.stdout || '')
      .trim()
      .split('\n')[0] || '';
  } catch {
    return '';
  }
}

export async function gitExec(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(gitCmd(), args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (c) => {
      out += c.toString();
    });
    proc.stderr?.on('data', (c) => {
      err += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out + err);
      else reject(new Error((err || out || `git exit ${code}`).slice(-4000)));
    });
  });
}

/** 将仓内相对路径规范为安全 pathspec（防 .. 与越界），失败返回 null */
export function safeRepoRelativePathForGitAdd(work, relPath) {
  const relNorm = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!relNorm) return null;
  const parts = relNorm.split('/').filter((p) => p.length);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null;
  const candidate = path.resolve(path.join(work, ...parts));
  const w = path.resolve(work);
  if (candidate !== w && !candidate.startsWith(w + path.sep)) return null;
  return relNorm;
}
export function findParentWorkdirForChildPrefix(rootsP, relPrefix) {
  const key = relPrefix || '';
  const hit = rootsP.find((x) => (x.relPrefix || '') === key);
  if (hit) return hit.workdir;
  if (rootsP.length === 1 && !rootsP[0].relPrefix) return rootsP[0].workdir;
  return null;
}
