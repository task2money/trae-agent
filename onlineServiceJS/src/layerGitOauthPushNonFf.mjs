/**
 * git push HEAD:refs/heads/X 被远端拒绝（non-fast-forward / fetch first）时：
 * fetch 该分支再 rebase 后重推。不 force-push。
 */
export function isGitNonFastForward(errText) {
  const s = String(errText || '');
  return /\[rejected\]/.test(s) || /fetch first/i.test(s) || /non-fast-forward/i.test(s);
}

/**
 * @param {(args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<unknown>} gitExec
 * @param {{ httpsRemote: string, dstRef: string, workdir: string, env: NodeJS.ProcessEnv }} opts
 */
export async function gitPushHeadRetryOnNonFastForward(gitExec, opts) {
  const httpsRemote = String(opts.httpsRemote || '').trim();
  const dstRef = String(opts.dstRef || '').trim();
  const workdir = String(opts.workdir || '').trim();
  const env = opts.env || process.env;
  const pushArgs = ['push', httpsRemote, `HEAD:${dstRef}`];
  try {
    await gitExec(pushArgs, workdir, env);
    return;
  } catch (e) {
    const msg = String(e?.message || e);
    if (!isGitNonFastForward(msg)) {
      throw e;
    }
    const branch = dstRef.replace(/^refs\/heads\//, '');
    await gitExec(['fetch', httpsRemote, branch], workdir, env);
    await gitExec(['rebase', 'FETCH_HEAD'], workdir, env);
    await gitExec(pushArgs, workdir, env);
  }
}
