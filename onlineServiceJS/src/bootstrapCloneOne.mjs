import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import { gitCmd, gitCloneConfigArgs } from './gitCmd.mjs';
import {
  postCloneProgress,
  latestGitProgressPercent,
  parseGitCloneProgressPhases,
  normalizeGitProgressChunkForLog,
  gitCloneRetryConfigFromEnv,
  isRetryableGitCloneFailure,
  runGitCloneWithProgress,
  shouldEmitGitCloneProgressPercent,
} from './saasTaskCloud.mjs';
import { bootstrapRepoLogState } from './bootstrapState.mjs';
import { prepareOauthHttpsGitClone } from './bootstrapRepoCredentials.mjs';

export async function runOneBootstrapClone({
  job,
  n,
  credRoot,
  cloudPrefix,
  accessToken,
}) {
  const { raw, repoDir, index: i } = job;
  let prepared;
  try {
    prepared = prepareOauthHttpsGitClone(raw, credRoot);
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err : new Error(String(err)) };
  }
  const { cloneRemote, httpAuth, credential, envPatch, cleanup, normalizedFromSsh } = prepared;
  if (normalizedFromSsh) {
    appendOutboundReqLog(`bootstrap-clone remote normalized ssh→https from=${raw} to=${cloneRemote}`);
  }
  if (httpAuth) {
    const provider = credential && typeof credential === 'object' ? String(credential.provider || '').trim() : '';
    appendOutboundReqLog(
      `bootstrap-clone auth repo=${raw} clone=${cloneRemote} provider=${provider || 'unknown'} git_http_username=${httpAuth.username}`,
    );
  }
  try {
    const gitEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...envPatch,
    };
    const useV4 = String(process.env.TRAE_GIT_CLONE_ALLOW_IPV6 || '').trim() !== '1';
    const args = useV4
      ? [...gitCloneConfigArgs(), 'clone', '-4', '--progress', cloneRemote, repoDir]
      : [...gitCloneConfigArgs(), 'clone', '--progress', cloneRemote, repoDir];
    const { maxAttempts, backoffMs } = gitCloneRetryConfigFromEnv();
    let attempt = 1;
    while (attempt <= maxAttempts) {
      let lastPosted = 0;
      let lastPct = -1;
      try {
        await runGitCloneWithProgress(args, gitEnv, undefined, (chunk, errAll) => {
          if (chunk) {
            const ent = bootstrapRepoLogState?.bufs.get(raw);
            if (ent) ent.body += normalizeGitProgressChunkForLog(chunk);
          }
          const g = latestGitProgressPercent(errAll);
          if (!shouldEmitGitCloneProgressPercent(lastPct, g, Date.now(), lastPosted)) return;
          lastPct = g;
          lastPosted = Date.now();
          const phases = parseGitCloneProgressPhases(errAll);
          const seg = { phase: 'bootstrap', index: i + 1, total: n };
          if (phases.recv != null) seg.recv_progress = phases.recv;
          if (phases.unpack != null) seg.unpack_progress = phases.unpack;
          void postCloneProgress(
            cloudPrefix,
            accessToken,
            g,
            `【项目克隆】(${i + 1}/${n}) ${path.basename(repoDir)} … ${g}%`,
            raw,
            seg
          );
        });
        break;
      } catch (err) {
        const retryable = isRetryableGitCloneFailure(err);
        if (!retryable || attempt >= maxAttempts) throw err;
        const waitMs = backoffMs * attempt;
        const ent = bootstrapRepoLogState?.bufs.get(raw);
        if (ent) {
          ent.body += `\n[bootstrap-clone] 网络抖动，准备第 ${attempt + 1}/${maxAttempts} 次重试（${waitMs}ms）...\n`;
        }
        await postCloneProgress(
          cloudPrefix,
          accessToken,
          0,
          `【项目克隆】(${i + 1}/${n}) 网络抖动，准备第 ${attempt + 1}/${maxAttempts} 次重试…`,
          raw,
          { phase: 'bootstrap', index: i + 1, total: n }
        );
        try {
          fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        attempt += 1;
      }
    }
    await postCloneProgress(
      cloudPrefix,
      accessToken,
      100,
      `项目克隆 (${i + 1}/${n}) 完成 ${path.basename(repoDir)}`,
      raw,
      { phase: 'bootstrap', index: i + 1, total: n, recv_progress: 100, unpack_progress: 100 }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    cleanup();
  }
}

export async function bootstrapGitExec(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(gitCmd(), args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    });
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

/**
 * 规划 bootstrap 克隆落点：顶层仓直接 final；nested 先 staging，完成后移入父仓 path。
 * @param {string} layerDir
 * @param {{ url: string, cloneAlias?: string, parentRepoUrl?: string }[]} jobsIn
 */
