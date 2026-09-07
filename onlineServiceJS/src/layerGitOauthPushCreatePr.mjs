/**
 * OAuth 推送成功后创建 PR/MR；目标分支缺失时回退常见默认分支（main↔master）。
 */
import { createGithubPullRequest, createGitlabMergeRequest } from './layerGitOauthPushPr.mjs';
import { emitRuntimeEvent } from './runtimeEventLog.mjs';

/** @param {string} preferred */
export function prBaseFallbackCandidates(preferred) {
  const base = String(preferred || '').trim();
  const out = [];
  const push = (b) => {
    const s = String(b || '').trim();
    if (!s || out.includes(s)) return;
    out.push(s);
  };
  push(base);
  if (/^main$/i.test(base)) push('master');
  if (/^master$/i.test(base)) push('main');
  return out;
}

/**
 * @param {{
 *   provider: string,
 *   originUrl?: string,
 *   httpsRemote?: string,
 *   slugInfo?: { owner?: string, repo?: string } | null,
 *   gitlabInfo?: { owner?: string, repo?: string } | null,
 *   headName: string,
 *   baseName: string,
 *   repoToken: string,
 *   prTitle?: string,
 *   prBody?: string,
 *   createGithubPullRequestFn?: typeof createGithubPullRequest,
 *   createGitlabMergeRequestFn?: typeof createGitlabMergeRequest,
 * }} opts
 */
export async function createPullOrMergeRequestWithBaseFallback(opts) {
  const provider = String(opts?.provider || '').trim().toLowerCase();
  const headName = String(opts?.headName || '').trim();
  const preferredBase = String(opts?.baseName || '').trim();
  const repoToken = String(opts?.repoToken || '').trim();
  if (!provider || !headName || !preferredBase || !repoToken) {
    return { ok: false, pr: null, pr_error: 'missing_pr_params', basesTried: [] };
  }
  const bases = prBaseFallbackCandidates(preferredBase).filter((b) => b !== headName);
  if (!bases.length) {
    return { ok: false, pr: null, pr_error: 'pr_base_equals_head', basesTried: [] };
  }
  const createGh = opts.createGithubPullRequestFn || createGithubPullRequest;
  const createGl = opts.createGitlabMergeRequestFn || createGitlabMergeRequest;
  const errors = [];
  for (const base of bases) {
    if (provider === 'github') {
      const owner = opts.slugInfo?.owner;
      const repo = opts.slugInfo?.repo;
      if (!owner || !repo) {
        return { ok: false, pr: null, pr_error: 'missing_github_owner_repo', basesTried: bases };
      }
      const prRes = await createGh({
        owner,
        repo,
        head: headName,
        base,
        accessToken: repoToken,
        title: opts.prTitle,
        bodyText: opts.prBody,
      });
      if (prRes.ok && prRes.json) {
        return {
          ok: true,
          pr: {
            html_url: prRes.json.html_url || '',
            number: prRes.json.number,
            state: prRes.json.state,
            base_branch: base,
          },
          pr_error: null,
          basesTried: bases,
        };
      }
      errors.push(`${base}:${prRes.text || `http_${prRes.status}`}`);
      continue;
    }
    if (provider === 'gitlab') {
      const glOwner = opts.gitlabInfo?.owner || opts.slugInfo?.owner;
      const glRepo = opts.gitlabInfo?.repo || opts.slugInfo?.repo;
      const originUrl = String(opts.originUrl || opts.httpsRemote || '').trim();
      if (!glOwner || !glRepo || !originUrl) {
        return { ok: false, pr: null, pr_error: 'missing_gitlab_mr_params', basesTried: bases };
      }
      const prRes = await createGl({
        originUrl,
        owner: glOwner,
        repo: glRepo,
        head: headName,
        base,
        accessToken: repoToken,
        title: opts.prTitle,
        bodyText: opts.prBody,
      });
      if (prRes.ok && prRes.json) {
        const webUrl = String(prRes.json.web_url || prRes.json.html_url || '').trim();
        return {
          ok: true,
          pr: {
            html_url: webUrl,
            number: prRes.json.iid ?? prRes.json.id,
            state: prRes.json.state,
            provider: 'gitlab',
            base_branch: base,
          },
          pr_error: null,
          basesTried: bases,
        };
      }
      errors.push(`${base}:${prRes.text || `http_${prRes.status}`}`);
      continue;
    }
    return { ok: false, pr: null, pr_error: `unsupported_provider:${provider}`, basesTried: bases };
  }
  return {
    ok: false,
    pr: null,
    pr_error: errors.join(' | ').slice(0, 800) || 'pr_create_failed',
    basesTried: bases,
  };
}

/**
 * 配置了 merge_target（prBase）且 head≠base 时，每个 push_ok 仓都必须有 PR。
 * @param {object[]} repos
 * @param {{ prBaseBranch?: string, headName?: string }} opts
 */
export function expectedPrMissingDetail(repos, opts = {}) {
  const prBase = String(opts.prBaseBranch || '').trim();
  const headName = String(opts.headName || '').trim();
  if (!prBase || !headName || prBase === headName) return '';
  const list = Array.isArray(repos) ? repos : [];
  const missing = list.filter((r) => r?.push_ok && !(r?.pr && String(r.pr.html_url || '').trim()));
  if (!missing.length) return '';
  const parts = missing.map((r) => {
    const slug = String(r.github_slug || r.rel_prefix || 'repo').trim();
    const err = String(r.pr_error || 'no_pr_url').trim().slice(0, 240);
    return `${slug}: ${err}`;
  });
  return `推送成功但未创建 PR/MR（merge_target=${prBase}）：${parts.join('；')}`.slice(0, 800);
}

/**
 * @param {object[]} repos
 * @param {{ prBaseBranch?: string, headName?: string, layerId?: string }} opts
 */
export function emitPrExpectedMissingEvent(repos, opts = {}) {
  const detail = expectedPrMissingDetail(repos, opts);
  if (!detail) return null;
  emitRuntimeEvent('AUTO_RUN_PR_CREATE_FAILED', {
    level: 'warn',
    message: detail.slice(0, 240),
    fields: {
      layer_id: String(opts.layerId || '').trim(),
      merge_target: String(opts.prBaseBranch || '').trim(),
      head: String(opts.headName || '').trim(),
    },
    consoleLine: `[onlineServiceJS] AUTO_RUN_PR_CREATE_FAILED layer_id=${String(opts.layerId || '').trim()} detail=${detail.slice(0, 240)}`,
  });
  return detail;
}
