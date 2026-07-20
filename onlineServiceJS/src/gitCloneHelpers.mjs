import { gitCloneConfigArgs } from './gitCmd.mjs';

export function useGitCloneForceIpv4() {
  return String(process.env.TRAE_GIT_CLONE_ALLOW_IPV6 || '').trim() !== '1';
}

export function buildGitCloneArgs(cloneUrl, { branch, depth }) {
  const args = [...gitCloneConfigArgs(), 'clone'];
  // Docker/部分网络下对 github.com 等优先走 IPv6 会连不上，强制 -4 可稳定 HTTPS/SSH 克隆
  if (useGitCloneForceIpv4()) {
    args.push('-4');
  }
  args.push('--progress');
  if (depth != null && Number.isFinite(depth) && depth > 0) {
    args.push('--depth', String(Math.floor(depth)));
  }
  if (branch) {
    args.push('--branch', branch);
  }
  args.push(cloneUrl, '.');
  return args;
}
