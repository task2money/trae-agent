import fs from 'fs';
import path from 'path';
import { appendGitPushReqLog } from './outboundReqLog.mjs';
import {
  layerPath,
  layerPrimaryGitWorkdir,
  listLayerRows,
  layerGitWorkdirRootsForFileListing,
  resolveLayerGitLogContext,
  clickedPathIsGitRepoRoot,
  markOriginRemoteTrackingToHead,
  rememberLayerGitPushCompareBranch,
  rememberLayerPrHtmlUrl,
  layerGitRemoteSnapshot,
} from './layerFs.mjs';
import {
  rememberLayerLastPushError,
  clearLayerLastPushError,
} from './layerFsGitLastPushError.mjs';
import { suggestStagedCommitMessage } from './stagedCommitSuggest.mjs';
import { commitLayerGitWorkdirs } from './layerGitCommit.mjs';
import { runLayerGitMerge } from './layerGitMerge.mjs';
import { runLayerGithubOauthAccessPush } from './layerGitOauthPush.mjs';
import { runLayerOauthRefreshPush } from './layerGitOauthRefreshPush.mjs';
import { runLayerOauthFetchTokenFiles } from './layerGitOauthFetchTokenFiles.mjs';
import { formatGitExecDebugLine } from './gitCmd.mjs';
import { gitPushRemoteArgFromOrigin } from './gitRemote.mjs';
import {
  repoMatchKeyFromUrl,
  gitConfigGetSync,
  gitExec,
  safeRepoRelativePathForGitAdd,
} from './layerGitRouteHelpers.mjs';


/**
 * 网关兜底：把 SaaS 侧拿到的 PR/合并请求 URL 持久化到层文件系统（OPT-20260817-042）。
 * 容器 oauth-access-push 成功路径已自行 remember；本端点用于「PR 由 SaaS follow-up 创建、
 * 容器侧未落盘」的兜底，幂等（相同 URL 覆盖写）。
 * @param {{ layerId?: string, htmlUrl?: string }} opts
 * @returns {{ httpStatus: number, payload: object }}
 */
export function runRememberPrHtmlUrl(opts = {}) {
  const layerId = String(opts?.layerId || '').trim();
  const htmlUrl = String(opts?.htmlUrl || '').trim();
  if (!layerId || !htmlUrl) {
    return { httpStatus: 400, payload: { ok: false, detail: 'layer_id and html_url required' } };
  }
  const ok = rememberLayerPrHtmlUrl(layerId, htmlUrl);
  appendGitPushReqLog(`remember-pr-html-url layer_id=${layerId} ok=${ok}`);
  return { httpStatus: 200, payload: { ok, remembered: ok } };
}

export function registerLayerGitRoutes(api) {
  api.get('/layers/:layer_id/git/commit/latest-log', async (req, res) => {
    const work = layerPrimaryGitWorkdir(req.params.layer_id);
    if (!work) return res.status(400).json({ detail: 'no git' });
    try {
      const t = await gitExec(['log', '-1', '--stat'], work);
      res.json({ log: t });
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  /** 与 Django ``forward_container_layer_git_log`` 及文件树侧栏一致：``text``、可选空列表 ``commits``；
   *  点击目录为仓库根时额外返回 ``is_repo_root`` / ``current_branch``。 */
  api.get('/layers/:layer_id/git/log', async (req, res) => {
    const layerId = String(req.params.layer_id || '');
    let limit = 20;
    if (req.query.limit != null && String(req.query.limit).trim() !== '') {
      const n = parseInt(String(req.query.limit), 10);
      if (Number.isNaN(n)) return res.status(400).json({ detail: 'limit 必须为整数' });
      limit = Math.max(1, Math.min(100, n));
    }
    const rawPath = (req.query.path ?? '').toString().trim();
    const ctx = resolveLayerGitLogContext(layerId, rawPath);
    if (!ctx) {
      if (!layerPrimaryGitWorkdir(layerId)) return res.status(400).json({ detail: 'no git' });
      return res.status(400).json({ detail: 'path 不合法' });
    }
    const { work, pathspec } = ctx;
    const isRepoRoot = clickedPathIsGitRepoRoot(ctx);
    const args = [
      'log',
      `-${limit}`,
      '--date=short',
      '--pretty=format:%h %ad %s',
    ];
    if (pathspec) args.push('--', pathspec);
    try {
      const t = (await gitExec(args, work)).replace(/\s+$/, '');
      /** @type {{ text: string, commits: unknown[], is_repo_root: boolean, current_branch?: string }} */
      const body = {
        text: t || '',
        commits: [],
        is_repo_root: isRepoRoot,
      };
      if (isRepoRoot) {
        const branchWork = pathspec ? path.join(work, pathspec) : work;
        try {
          const branch = String(await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], branchWork))
            .trim()
            .split('\n')[0];
          if (branch) body.current_branch = branch;
        } catch (branchErr) {
          console.warn(
            `[onlineServiceJS] git/log current_branch failed layer_id=${layerId} path=${rawPath}: ${String(branchErr?.message || branchErr)}`,
          );
        }
      }
      return res.json(body);
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  /**
   * 接口 A：给定可写层 ``layer_id``，枚举该层内各 Git 工作区（与多仓 ``rel_prefix`` 语义一致），
   * 读取各仓 ``user.name`` / ``user.email`` 及 ``remote.origin.url``（若存在），供任务详情「关联项目」与 SaaS 仓库 URL 对齐展示。
   */
  api.get('/layers/:layer_id/git/repo-identities', (req, res) => {
    const layerId = String(req.params.layer_id || '').trim();
    if (!layerId) return res.status(400).json({ detail: 'layer_id required' });
    const root = layerPath(layerId);
    if (!fs.existsSync(root)) {
      return res.status(404).json({ detail: 'layer not found' });
    }
    const roots = layerGitWorkdirRootsForFileListing(layerId);
    const repos = [];
    for (const { workdir, relPrefix } of roots) {
      const rel = relPrefix || '';
      try {
        const g = path.join(workdir, '.git');
        if (!fs.existsSync(g)) {
          repos.push({
            rel_prefix: rel,
            origin_url: '',
            repo_match_key: '',
            user_name: '',
            user_email: '',
            error: 'not a git worktree',
          });
          continue;
        }
        const originUrl = gitConfigGetSync(['config', '--get', 'remote.origin.url'], workdir);
        const userName = gitConfigGetSync(['config', '--get', 'user.name'], workdir);
        const userEmail = gitConfigGetSync(['config', '--get', 'user.email'], workdir);
        repos.push({
          rel_prefix: rel,
          origin_url: originUrl,
          repo_match_key: originUrl ? repoMatchKeyFromUrl(originUrl) : '',
          user_name: userName,
          user_email: userEmail,
        });
      } catch (e) {
        repos.push({
          rel_prefix: rel,
          origin_url: '',
          repo_match_key: '',
          user_name: '',
          user_email: '',
          error: String(e.message || e),
        });
      }
    }
    res.json({ layer_id: layerId, repos });
  });

  /**
   * 接口 A：将请求体中各 ``repo_match_key`` 对应的 ``user.name`` / ``user.email`` 写入该层内匹配的 Git 工作区
   *（与 ``GET …/git/repo-identities`` 的枚举与 ``repoMatchKeyFromUrl(origin)`` 对齐）。
   */
  api.post('/layers/:layer_id/git/repo-identities/sync', async (req, res) => {
    const layerId = String(req.params.layer_id || '').trim();
    if (!layerId) return res.status(400).json({ detail: 'layer_id required' });
    const root = layerPath(layerId);
    if (!fs.existsSync(root)) {
      return res.status(404).json({ detail: 'layer not found' });
    }
    const rawList = req.body?.repos;
    if (!Array.isArray(rawList)) {
      return res.status(400).json({ detail: 'repos 须为非空数组' });
    }
    /** @type {Map<string, { user_name: string, user_email: string }>} */
    const byKey = new Map();
    for (const row of rawList) {
      if (!row || typeof row !== 'object') continue;
      const k = String(row.repo_match_key || '').trim().toLowerCase();
      const userName = String(row.user_name || '').trim();
      const userEmail = String(row.user_email || '').trim();
      if (!k || !userName || !userEmail) continue;
      byKey.set(k, { user_name: userName, user_email: userEmail });
    }
    if (byKey.size === 0) {
      return res.status(400).json({
        detail: 'repos 中至少须有一条有效记录（repo_match_key、user_name、user_email 均非空）',
      });
    }

    const roots = layerGitWorkdirRootsForFileListing(layerId);
    /** @type {{ repo_match_key: string, rel_prefix: string, ok: boolean, detail?: string }[]} */
    const results = [];
    const appliedKeys = new Set();

    for (const { workdir, relPrefix } of roots) {
      const rel = relPrefix || '';
      const g = path.join(workdir, '.git');
      if (!fs.existsSync(g)) {
        continue;
      }
      let originUrl = '';
      try {
        originUrl = gitConfigGetSync(['config', '--get', 'remote.origin.url'], workdir);
      } catch {
        originUrl = '';
      }
      const key = originUrl ? repoMatchKeyFromUrl(originUrl).toLowerCase() : '';
      if (!key || !byKey.has(key)) {
        continue;
      }
      const spec = byKey.get(key);
      try {
        await gitExec(['config', '--local', 'user.name', spec.user_name], workdir);
        await gitExec(['config', '--local', 'user.email', spec.user_email], workdir);
        appliedKeys.add(key);
        results.push({ repo_match_key: key, rel_prefix: rel, ok: true });
      } catch (e) {
        results.push({
          repo_match_key: key,
          rel_prefix: rel,
          ok: false,
          detail: String(e.message || e),
        });
      }
    }

    for (const k of byKey.keys()) {
      if (!appliedKeys.has(k)) {
        results.push({
          repo_match_key: k,
          rel_prefix: '',
          ok: false,
          detail: '当前层级未找到 remote.origin.url 与此 repo_match_key 一致的 Git 工作区',
        });
      }
    }

    const failed = results.filter((r) => !r.ok);
    const statusCode = failed.length ? 207 : 200;
    res.status(statusCode).json({
      ok: failed.length === 0,
      layer_id: layerId,
      applied_count: appliedKeys.size,
      results,
    });
  });

  api.post('/layers/:layer_id/git/add', async (req, res) => {
    const layerId = String(req.params.layer_id || '');
    const rawPath = (req.body?.path ?? '').toString().trim();
    if (!rawPath) return res.status(400).json({ detail: 'path 必填' });
    if (!layerPrimaryGitWorkdir(layerId)) return res.status(400).json({ detail: 'no git' });
    const ctx = resolveLayerGitLogContext(layerId, rawPath);
    if (!ctx) return res.status(400).json({ detail: 'path 不合法' });
    const { work, pathspec } = ctx;
    try {
      if (!pathspec) {
        await gitExec(['add', '.'], work);
      } else {
        const rel = safeRepoRelativePathForGitAdd(work, pathspec);
        if (!rel) return res.status(400).json({ detail: 'path 不合法' });
        await gitExec(['add', '--', rel], work);
      }
      let suggested_commit_message = '';
      try {
        suggested_commit_message = await suggestStagedCommitMessage(gitExec, work);
      } catch (e) {
        console.error('[onlineServiceJS] suggestStagedCommitMessage:', e);
      }
      res.json({
        ok: true,
        ...(suggested_commit_message ? { suggested_commit_message } : {}),
      });
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  api.post('/layers/:layer_id/git/unstage', async (req, res) => {
    const layerId = String(req.params.layer_id || '');
    const rawPath = (req.body?.path ?? '').toString().trim();
    if (!rawPath) return res.status(400).json({ detail: 'path 必填' });
    if (!layerPrimaryGitWorkdir(layerId)) return res.status(400).json({ detail: 'no git' });
    const ctx = resolveLayerGitLogContext(layerId, rawPath);
    if (!ctx) return res.status(400).json({ detail: 'path 不合法' });
    const { work, pathspec } = ctx;
    try {
      if (!pathspec) {
        await gitExec(['reset', 'HEAD', '.'], work);
      } else {
        const rel = safeRepoRelativePathForGitAdd(work, pathspec);
        if (!rel) return res.status(400).json({ detail: 'path 不合法' });
        await gitExec(['reset', 'HEAD', '--', rel], work);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  api.post('/layers/:layer_id/git/commit', async (req, res) => {
    const msg = (req.body?.message || 'commit').toString();
    const sa = req.body?.stage_all;
    const doStageAll = sa === undefined || sa === true;
    try {
      const result = commitLayerGitWorkdirs(req.params.layer_id, {
        message: msg,
        stage_all: doStageAll,
      });
      res.json(result);
    } catch (e) {
      const detail = String(e.message || e);
      if (e.code === 'NO_GIT') return res.status(400).json({ detail: 'no git' });
      res.status(400).json({ detail });
    }
  });

  api.post('/layers/:layer_id/git/push', async (req, res) => {
    const layerId = String(req.params.layer_id || '').trim();
    const work = layerPrimaryGitWorkdir(req.params.layer_id);
    if (!work) {
      appendGitPushReqLog(`api layer_id=${layerId} fail reason=no_git_workdir`);
      return res.status(400).json({ detail: 'no git' });
    }
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    let cmdLine = '';
    try {
      const branch = (req.body?.target_branch || '').toString().trim();
      const originUrl = gitConfigGetSync(['config', '--get', 'remote.origin.url'], work);
      const pushRemoteArg = gitPushRemoteArgFromOrigin(originUrl);
      const args = ['push'];
      // `git push origin <name>` 要求本地存在同名的 *本地 ref*。任务里传入的 `target_branch` 往往是
      // 要在远端建立的工作分支名，而 clone 后所在分支可能是 main，并无该本地分支，会报
      // "src refspec does not match any"。用 HEAD:<dst> 将当前工作区提交推送到远端分支。
      if (branch) {
        const dst = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
        args.push(pushRemoteArg, `HEAD:${dst}`);
      } else {
        args.push(pushRemoteArg, 'HEAD');
      }
      cmdLine = formatGitExecDebugLine(work, args, null);
      appendGitPushReqLog(`api layer_id=${layerId} run ${cmdLine}`);
      if (pushRemoteArg !== 'origin') {
        appendGitPushReqLog(
          `api layer_id=${layerId} push_remote=ssh_from_origin origin=${String(originUrl || '').slice(0, 240)} remote=${pushRemoteArg}`,
        );
      }
      await gitExec(args, work, env);
      const pushedRef = branch
        ? branch.startsWith('refs/')
          ? branch
          : `refs/heads/${branch}`
        : 'origin HEAD';
      // 非 named-remote / URL push 时补齐 origin/<branch>，避免层快照 ahead 仍 > 0
      if (branch) {
        markOriginRemoteTrackingToHead(work, branch);
        rememberLayerGitPushCompareBranch(layerId, branch);
      }
      console.log('[LayerGitPush] ok layer_id=%s ref=%s', req.params.layer_id, pushedRef);
      appendGitPushReqLog(`api layer_id=${layerId} ok ref=${pushedRef}`);
      clearLayerLastPushError(layerId);
      res.json({
        ok: true,
        git_remote: layerGitRemoteSnapshot(layerId, branch ? { compareBranch: branch } : {}),
      });
    } catch (e) {
      console.warn('[LayerGitPush] fail layer_id=%s err=%s', req.params.layer_id, String(e.message || e));
      appendGitPushReqLog(
        `api layer_id=${layerId} fail ${cmdLine ? `cmd=${cmdLine} ` : ''}err=${String(e.message || e).slice(0, 800)}`,
      );
      rememberLayerLastPushError(layerId, String(e.message || e));
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  /**
   * 兜底持久化 PR/合并请求 URL（OPT-20260817-042）：网关在 oauth-access-push 响应拿到
   * github_pull_request.html_url 后调用本端点，保证 SaaS follow-up 场景刷新后层图仍有 PR 锚点。
   */
  api.post('/layers/:layer_id/git/remember-pr-html-url', async (req, res) => {
    const { httpStatus, payload } = runRememberPrHtmlUrl({
      layerId: req.params.layer_id,
      htmlUrl: req.body?.html_url,
    });
    res.status(httpStatus).json(payload);
  });

  /**
   * 将当前 HEAD（或 source_ref）本地合并进 target_branch（合并目标分支）。
   * 工作区须干净；冲突时 abort 并切回源分支。
   */
  api.post('/layers/:layer_id/git/merge', async (req, res) => {
    const layerId = String(req.params.layer_id || '').trim();
    const work = layerPrimaryGitWorkdir(layerId);
    const targetBranch = String(req.body?.target_branch || '').trim();
    const sourceRef = String(req.body?.source_ref || '').trim();
    console.log(
      '[LayerGitMerge] start layer_id=%s target_branch=%s source_ref=%s',
      layerId,
      targetBranch || '(empty)',
      sourceRef || '(HEAD)',
    );
    try {
      const { httpStatus, payload } = await runLayerGitMerge({
        gitExec,
        work: work || '',
        targetBranch,
        sourceRef: sourceRef || undefined,
      });
      if (httpStatus >= 400) {
        console.warn(
          '[LayerGitMerge] fail layer_id=%s status=%s detail=%s',
          layerId,
          httpStatus,
          String(payload?.detail || '').slice(0, 400),
        );
        return res.status(httpStatus).json(payload);
      }
      const body = { ...payload };
      try {
        body.git_remote = layerGitRemoteSnapshot(layerId);
      } catch {
        /* optional */
      }
      console.log(
        '[LayerGitMerge] ok layer_id=%s status=%s target=%s',
        layerId,
        body.status,
        targetBranch,
      );
      res.status(httpStatus).json(body);
    } catch (e) {
      console.warn('[LayerGitMerge] fail layer_id=%s err=%s', layerId, String(e.message || e));
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  /**
   * 接口 A：OAuth 按仓库 token 入参（github_auth_by_repo / oauth_auth_by_repo），对层内远程工作区 HTTPS 推送当前 HEAD，
   * 并在给定 base 上创建 PR（可选）。供 SaaS 在 refresh_token 换票后转发，与 TaskDetail 推送流程对齐。
   */
  api.post('/layers/:layer_id/git/oauth-access-push', async (req, res) => {
    const rawTokenByRepo = req.body?.github_auth_by_repo;
    const tokenByRepo =
      rawTokenByRepo && typeof rawTokenByRepo === 'object' && !Array.isArray(rawTokenByRepo)
        ? rawTokenByRepo
        : null;
    const rawOauthAuthByRepo = req.body?.oauth_auth_by_repo;
    const oauthAuthByRepo =
      rawOauthAuthByRepo && typeof rawOauthAuthByRepo === 'object' && !Array.isArray(rawOauthAuthByRepo)
        ? rawOauthAuthByRepo
        : null;
    const targetBranch = String(req.body?.target_branch || '').trim();
    const prBase = String(req.body?.pr_base_branch || '').trim();
    const prTitle = String(req.body?.pr_title || '').trim();
    const prBody = String(req.body?.pr_body || '').trim();
    const layerId = String(req.params.layer_id || '').trim();
    try {
      const { httpStatus, payload } = await runLayerGithubOauthAccessPush({
        layerId,
        targetBranch,
        accessTokenByRepoSlug: tokenByRepo,
        oauthAuthByRepo,
        prBaseBranch: prBase,
        prTitle,
        prBody,
        traceId: req.traceId,
      });
      res.status(httpStatus).json(payload);
    } catch (e) {
      console.warn('[LayerGitOauthPush] fail layer_id=%s err=%s', layerId, String(e.message || e));
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  /** 从 task2app 拉取 GitHub OAuth access_token 并对层内各仓 HTTPS 推送（容器 UI）。 */
  api.post('/layers/:layer_id/git/oauth-refresh-push', async (req, res) => {
    const layerId = String(req.params.layer_id || '').trim();
    const targetBranch = String(req.body?.target_branch || '').trim();
    try {
      const { httpStatus, payload } = await runLayerOauthRefreshPush({
        layerId,
        targetBranch,
        traceId: req.traceId,
      });
      res.status(httpStatus).json(payload);
    } catch (e) {
      console.warn('[LayerGitOauthRefreshPush] fail layer_id=%s err=%s', layerId, String(e.message || e));
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  /** 从 task2app 拉取 GitHub OAuth access_token 并按仓库写入 .task2app_access_token（不推送）。 */
  api.post('/layers/:layer_id/git/oauth-fetch-token-files', async (req, res) => {
    const layerId = String(req.params.layer_id || '').trim();
    const targetBranch = String(req.body?.target_branch || '').trim();
    try {
      const { httpStatus, payload } = await runLayerOauthFetchTokenFiles({
        layerId,
        targetBranch,
        traceId: req.traceId,
      });
      res.status(httpStatus).json(payload);
    } catch (e) {
      console.warn('[LayerGitOauthFetchTokenFiles] fail layer_id=%s err=%s', layerId, String(e.message || e));
      res.status(400).json({ detail: String(e.message || e) });
    }
  });
}
