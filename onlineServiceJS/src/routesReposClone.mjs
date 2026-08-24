import fs from 'fs';
import path from 'path';
import {
  bootstrapCloneLayerId,
  getCloneLayerLogText,
  getBootstrapCloneLogSegmentsForApi,
  clearCloneLayerLog,
  appendCloneLayerLog,
  prepareOauthHttpsGitClone,
  fetchRepoCloneCredentialsOnly,
  lastBootstrapTaskDetail,
  collectRepoCloneJobs,
  bootstrapCloneLogFailurePayload,
  applyBootstrapCloneGitIdentities,
} from './bootstrap.mjs';
import {
  taskApiPrefix,
  postCloneProgress,
  latestGitProgressPercent,
  parseGitCloneProgressPhases,
  normalizeGitProgressChunkForLog,
  gitCloneRetryConfigFromEnv,
  isRetryableGitCloneFailure,
  runGitCloneWithProgress,
  shouldEmitGitCloneProgressPercent,
} from './saasTaskCloud.mjs';
import {
  getExecStreamManifest,
  getExecStreamSegment,
  validExecStreamKind,
  validExecStreamResourceId,
} from './execStream.mjs';
import { enqueueClone, getCloneOpStatus } from './cloneQueue.mjs';
import {
  layerPath,
  newLayerId,
  listLayerRows,
  layerPrimaryGitWorkdir,
  writeLayerMeta,
  resolveRepoCloneDirName,
  resolveRepoCloneRelPath,
  sanitizeCloneRelPath,
  relocateClonedRepo,
} from './layerFs.mjs';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import { buildGitCloneArgs } from './gitCloneHelpers.mjs';
import { runRecloneSuccessSideEffects } from './postBootstrapAgentKickoff.mjs';


export function registerReposCloneRoutes(api) {
  api.get('/repos/clone-log/:layer_id', (req, res) => {
    const lid = req.params.layer_id;
    res.json({ layer_id: lid, text: getCloneLayerLogText(lid) });
  });

  /** 通用执行流：总览（分片列表，JSON）；后续其他 kind（如 job）共用同一路径 */
  api.get('/exec-streams/:kind/:resourceId/manifest', (req, res) => {
    const { kind, resourceId } = req.params;
    if (!validExecStreamKind(kind) || !validExecStreamResourceId(resourceId)) {
      return res.status(400).json({ detail: 'invalid kind or resource_id' });
    }
    const manifest = getExecStreamManifest(kind, resourceId);
    res.json(manifest);
  });

  api.get('/exec-streams/:kind/:resourceId/segments/:seq', (req, res) => {
    const { kind, resourceId, seq } = req.params;
    if (!validExecStreamKind(kind) || !validExecStreamResourceId(resourceId)) {
      return res.status(400).json({ detail: 'invalid kind or resource_id' });
    }
    const seg = getExecStreamSegment(kind, resourceId, seq);
    if (!seg) {
      return res.status(404).json({ detail: 'segment not found' });
    }
    res.json(seg);
  });

  api.get('/repos/clone-status/:layer_id', (req, res) => {
    const lid = req.params.layer_id;
    const st = getCloneOpStatus(lid);
    if (st) {
      return res.json({ layer_id: lid, ...st });
    }
    res.json({ layer_id: lid, status: 'unknown' });
  });

  api.get('/repos/bootstrap-clone-log', (req, res) => {
    const lid = bootstrapCloneLayerId;
    const text = lid ? getCloneLayerLogText(lid) : '';
    const segments = lid ? getBootstrapCloneLogSegmentsForApi(lid) : null;
    const payload = { layer_id: lid, text };
    if (segments && segments.length) {
      payload.segments = segments;
    }
    // 凭证未齐等导致从未进入 clone 时 layer 为空；仍返回可读失败摘要，避免 UI/8888 侧「静默空 /app」。
    if (!String(text || '').trim()) {
      const fail = bootstrapCloneLogFailurePayload();
      if (fail) {
        payload.text = fail.text;
        if (fail.error_code) payload.error_code = fail.error_code;
        if (fail.phase) payload.phase = fail.phase;
        if (fail.at) payload.failed_at = fail.at;
        if (fail.missing_repo_credentials?.length) {
          payload.missing_repo_credentials = fail.missing_repo_credentials;
        }
      }
    }
    res.json(payload);
  });

  api.post('/repos/clone', (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ detail: 'url required' });
    const parent_layer_id = req.body?.parent_layer_id ? String(req.body.parent_layer_id).trim() : '';
    const branch = req.body?.branch ? String(req.body.branch).trim() : '';
    let depth = null;
    if (req.body?.depth != null && req.body?.depth !== '') {
      const d = parseInt(String(req.body.depth), 10);
      if (!Number.isFinite(d) || d < 1) {
        return res.status(400).json({ detail: 'depth 须为正整数' });
      }
      depth = d;
    }

    const lid = newLayerId();
    const root = layerPath(lid);
    try {
      // 在克隆开始前先创建层级节点，建立可写层
      writeLayerMeta(lid, 'clone', parent_layer_id || null);
      fs.mkdirSync(root, { recursive: true });
      const cloneCwd = path.join(root, 'base');
      fs.mkdirSync(cloneCwd, { recursive: true });
      clearCloneLayerLog(lid);

      const cloneUrl = url;
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

      const gitArgs = buildGitCloneArgs(cloneUrl, { branch, depth });
      const queuePosition = enqueueClone({
        lid,
        root,
        cloneCwd,
        parentLayerId: parent_layer_id || null,
        gitArgs,
        env,
        ephemeralKeyDir: null,
        titleUrl: url,
      });

      res.status(202).json({
        accepted: true,
        status: 'queued',
        layer_id: lid,
        layer_path: root,
        queue_position: queuePosition,
      });
    } catch (e) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      res.status(400).json({ detail: String(e.message || e), exit_code: 1 });
    }
  });

  api.post('/repos/reclone', async (req, res) => {
    const repoUrl = String(req.body?.repo_url || '').trim();
    if (!repoUrl) return res.status(400).json({ detail: 'repo_url required' });
    let layerId = bootstrapCloneLayerId;
    if (!layerId) {
      for (const row of listLayerRows()) {
        if (layerPrimaryGitWorkdir(row.layer_id)) {
          layerId = row.layer_id;
          break;
        }
      }
    }
    if (!layerId) return res.status(400).json({ detail: '引导克隆层不存在' });
    const bodyAlias = String(req.body?.clone_alias || req.body?.cloneAlias || '').trim();
    let bodyParent = String(req.body?.parent_repo_url || req.body?.parentRepoUrl || '').trim();
    let resolvedAlias = bodyAlias;
    if (lastBootstrapTaskDetail) {
      const jobs = collectRepoCloneJobs(lastBootstrapTaskDetail);
      const hit = jobs.find((j) => String(j.url || '').trim() === repoUrl);
      if (!resolvedAlias && hit?.cloneAlias) resolvedAlias = hit.cloneAlias;
      if (!bodyParent && hit?.parentRepoUrl) bodyParent = hit.parentRepoUrl;
    }
    const layerDir = layerPath(layerId);
    let parentTop = '';
    if (bodyParent) {
      const parentJobs = lastBootstrapTaskDetail ? collectRepoCloneJobs(lastBootstrapTaskDetail) : [];
      const parentHit = parentJobs.find(
        (j) =>
          !j.parentRepoUrl &&
          String(j.url || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase() ===
            bodyParent.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase(),
      );
      const parentName = parentHit
        ? resolveRepoCloneDirName(parentHit.url, parentHit.cloneAlias)
        : resolveRepoCloneDirName(bodyParent, '');
      const candidate = path.join(layerDir, parentName);
      if (fs.existsSync(candidate)) parentTop = parentName;
    }
    const rel =
      sanitizeCloneRelPath(resolvedAlias) ||
      resolveRepoCloneRelPath(repoUrl, resolvedAlias) ||
      resolveRepoCloneDirName(repoUrl, resolvedAlias);
    const name = parentTop ? path.join(parentTop, rel) : rel;
    const target = path.join(layerDir, ...String(name).split(/[/\\]/).filter(Boolean));
    const stagingDir = path.join(layerDir, '.bootstrap-staging', `reclone-${Date.now()}`);
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    let prefix = null;
    try {
      prefix = taskApiPrefix();
    } catch {
      prefix = null;
    }
    const accessToken = String(process.env.ACCESS_TOKEN || '').trim();

    const runRecloneInBackground = () => {
      void (async () => {
        let cleanupAskpass = () => {};
        try {
          if (prefix && accessToken) {
            await postCloneProgress(prefix, accessToken, 0, `【重新克隆】开始 ${name}…`, repoUrl, {
              phase: 'reclone',
            });
          }
          let credRoot = {};
          if (prefix && accessToken) {
            try {
              credRoot = await fetchRepoCloneCredentialsOnly(prefix, accessToken, 30);
            } catch (credErr) {
              appendOutboundReqLog(
                `reclone: repo-clone-credentials failed: ${credErr instanceof Error ? credErr.message : String(credErr)}`,
              );
            }
          }
          const prepared = prepareOauthHttpsGitClone(repoUrl, credRoot);
          cleanupAskpass = prepared.cleanup;
          const cloneRemote = prepared.cloneRemote;
          if (prepared.normalizedFromSsh) {
            appendOutboundReqLog(
              `reclone remote normalized ssh→https from=${repoUrl} to=${cloneRemote}`,
            );
          }
          if (prepared.httpAuth) {
            const provider =
              prepared.credential && typeof prepared.credential === 'object'
                ? String(prepared.credential.provider || '').trim()
                : '';
            appendOutboundReqLog(
              `reclone auth repo=${repoUrl} clone=${cloneRemote} provider=${provider || 'unknown'} git_http_username=${prepared.httpAuth.username}`,
            );
          }
          const env = {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_HTTP_IPV4: String(process.env.GIT_HTTP_IPV4 || '1'),
            ...prepared.envPatch,
          };
          const gitArgs = buildGitCloneArgs(cloneRemote, { branch: '', depth: null });
          try {
            appendCloneLayerLog(
              layerId,
              `\n━━ 重新克隆 ${repoUrl}${cloneRemote !== repoUrl ? ` → ${cloneRemote}` : ''}\n→ ${name}\n`,
            );
          } catch {
            /* ignore */
          }
          const { maxAttempts, backoffMs } = gitCloneRetryConfigFromEnv();
          let attempt = 1;
          while (attempt <= maxAttempts) {
            let lastPosted = 0;
            let lastPct = -1;
            try {
              await runGitCloneWithProgress(gitArgs, env, stagingDir, (chunk, errAll) => {
                if (chunk) {
                  try {
                    appendCloneLayerLog(layerId, normalizeGitProgressChunkForLog(chunk));
                  } catch {
                    /* ignore */
                  }
                }
                if (!prefix || !accessToken) return;
                const g = latestGitProgressPercent(errAll);
                if (!shouldEmitGitCloneProgressPercent(lastPct, g, Date.now(), lastPosted)) return;
                lastPct = g;
                lastPosted = Date.now();
                const phases = parseGitCloneProgressPhases(errAll);
                const seg = { phase: 'reclone' };
                if (phases.recv != null) seg.recv_progress = phases.recv;
                if (phases.unpack != null) seg.unpack_progress = phases.unpack;
                void postCloneProgress(prefix, accessToken, g, `【重新克隆】${name} … ${g}%`, repoUrl, seg);
              });
              break;
            } catch (e) {
              const retryable = isRetryableGitCloneFailure(e);
              if (!retryable || attempt >= maxAttempts) throw e;
              const waitMs = backoffMs * attempt;
              try {
                appendCloneLayerLog(
                  layerId,
                  `\n[重新克隆] 网络抖动，准备第 ${attempt + 1}/${maxAttempts} 次重试（${waitMs}ms）\n`
                );
              } catch {
                /* ignore */
              }
              if (prefix && accessToken) {
                await postCloneProgress(
                  prefix,
                  accessToken,
                  0,
                  `【重新克隆】网络抖动，准备第 ${attempt + 1}/${maxAttempts} 次重试…`,
                  repoUrl,
                  { phase: 'reclone' }
                );
              }
              try {
                fs.rmSync(stagingDir, { recursive: true, force: true });
                fs.mkdirSync(stagingDir, { recursive: true });
              } catch {
                /* ignore */
              }
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              attempt += 1;
            }
          }
          relocateClonedRepo(stagingDir, target);
          try {
            const metaPath = path.join(layerPath(layerId), 'layer_meta.json');
            const existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            existingMeta.clone_url = String(cloneRemote || repoUrl).trim();
            fs.writeFileSync(metaPath, JSON.stringify(existingMeta, null, 2), 'utf8');
          } catch {
            /* ignore */
          }
          if (prefix && accessToken) {
            await postCloneProgress(prefix, accessToken, 100, `【重新克隆】完成 ${name}`, repoUrl, {
              phase: 'reclone',
              recv_progress: 100,
              unpack_progress: 100,
            });
          }
          try {
            appendCloneLayerLog(layerId, `\n[重新克隆] 完成 ${name}\n`);
          } catch {
            /* ignore */
          }
          // 身份同步 + 恢复被中断的自动任务（与凭证恢复成功路径同 kickoff）
          await runRecloneSuccessSideEffects({
            layerId,
            repoUrl,
            detail: lastBootstrapTaskDetail,
            applyIdentities: applyBootstrapCloneGitIdentities,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          try {
            appendCloneLayerLog(layerId, `\n[重新克隆] 失败: ${msg}\n`);
          } catch {
            /* ignore */
          }
          if (prefix && accessToken) {
            await postCloneProgress(
              prefix,
              accessToken,
              0,
              `【重新克隆】失败: ${msg.slice(0, 500)}`,
              repoUrl,
              { phase: 'reclone' }
            );
          }
          try {
            fs.rmSync(target, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        } finally {
          cleanupAskpass();
        }
      })();
    };

    res.status(202).json({
      accepted: true,
      status: 'started',
      layer_id: layerId,
      repo_url: repoUrl,
      message: '重新克隆已在后台进行，进度经任务 SSE 推送',
    });
    setImmediate(runRecloneInBackground);
  });
}
