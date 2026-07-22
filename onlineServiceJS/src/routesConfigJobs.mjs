import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { appendOutboundReqLog } from './outboundReqLog.mjs';
import { addSseClient } from './sseHub.mjs';
import { readOrPullServiceConfig } from './ensureServiceConfig.mjs';
import { isBootstrapReposLayoutReady } from './bootstrapCloneLayoutSeal.mjs';
import { startupEmptyLayerId, bootstrapCloneLayerId } from './bootstrap.mjs';
import { getAgentRenderHints } from './agentRenderHints.mjs';
import {
  bundledAutoRunStepsTemplatePath,
  readAutoRunStepsMarkdown,
} from './autoRunSteps.mjs';
import { serviceRoot } from './paths.mjs';
import { configFilePath } from './paths.mjs';
import {
  createJob,
  listJobs,
  getJob,
  jobToApiDict,
  interruptJob,
  deleteJob,
  buildLayersSnapshot,
  mirrorLayerGraphToTaskCloudSSE,
  getJobEvents,
} from './jobsRuntime.mjs';
import { getJobStepsForLayer, paginateJobStepsPayload } from './jobSteps.mjs';
import {
  layerPath,
  newLayerId,
  anyLayerHasGitRepo,
  listLayerRows,
  createStackedLayer,
  deleteLayerTree,
} from './layerFs.mjs';


export function registerConfigJobsRoutes(api, { upload }) {
  api.get('/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    addSseClient(res);
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  });

  api.post('/config', upload.single('file'), (req, res) => {
    const buf = req.file?.buffer;
    if (!buf?.length) return res.status(400).json({ detail: 'Empty file' });
    try {
      YAML.parse(buf.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ detail: String(e.message || e) });
    }
    const dest = configFilePath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    res.json({ path: dest, status: 'ok' });
  });

  api.post('/config/raw', (req, res) => {
    const yaml = (req.query.yaml || '').toString();
    if (!yaml.trim()) return res.status(400).json({ detail: 'yaml required' });
    try {
      YAML.parse(yaml);
    } catch (e) {
      return res.status(400).json({ detail: String(e.message || e) });
    }
    const dest = configFilePath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, yaml, 'utf8');
    res.json({ path: dest, status: 'ok' });
  });

  api.get('/config', async (req, res) => {
    try {
      const result = await readOrPullServiceConfig({
        postOpts: {
          traceId: req.traceId,
          spanId: req.spanId,
        },
      });
      res.json({ path: result.path, yaml: result.yaml, source: result.source });
    } catch (e) {
      const detail = String(e?.message || e || 'not found').trim() || 'not found';
      appendOutboundReqLog(`GET /api/config: ${detail.slice(0, 400)}`);
      if (e?.code === 'SAAS_CONFIG_UNAVAILABLE') {
        return res.status(404).json({ detail: 'not found' });
      }
      // SaaS 回源失败：502 保留上游细节；纯缺失仍 404 not found（前端按 traceId 指引展示）
      if (/not found/i.test(detail) && !/HTTP\s+\d+/i.test(detail)) {
        return res.status(404).json({ detail: 'not found' });
      }
      return res.status(502).json({ detail: detail.slice(0, 500) });
    }
  });

  api.get('/requirements/task-gate', (req, res) => {
    // clone_done：有 git 且克隆层布局已锁定（含 nested 移入父仓），与建任务门闸一致
    res.json({
      clone_done: anyLayerHasGitRepo() && isBootstrapReposLayoutReady(),
    });
  });

  /** SaaS 下行心跳探测：GET ?seq=N，回显 ack=N（类 TCP ack，供 server-container-token/heartbeat/ 校验双向可达） */
  api.get('/saas-heartbeat-probe', (req, res) => {
    const raw = req.query?.seq;
    const seq = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(seq) || seq < 0) {
      return res.status(400).json({ detail: 'seq 须为非负整数' });
    }
    res.json({ status: 'ok', ack: seq });
  });

  /** Agent 步骤字段 → 富文本呈现策略（表驱动）；前端 GET 后按 step_rows / tool_expansion / tail_rows 渲染 */
  api.get('/ui/agent-render-hints', (req, res) => {
    res.json(getAgentRenderHints());
  });

  /** 镜像内 autoRunStep.md（任务详情 / 自动运行说明 live 源） */
  api.get('/auto-run-steps', (req, res) => {
    let result = readAutoRunStepsMarkdown();
    if (!result.ok) {
      const bundled = bundledAutoRunStepsTemplatePath(serviceRoot());
      result = readAutoRunStepsMarkdown(bundled);
      if (result.ok) {
        result = { ...result, source: 'bundled_template' };
      }
    }
    if (!result.ok) {
      return res.status(404).json({ detail: result.detail || 'autoRunStep.md not found' });
    }
    res.json({
      markdown: result.markdown,
      path: result.path,
      source: result.source,
    });
  });

  api.get('/layers/empty-root', (req, res) => {
    res.json({ layer_id: startupEmptyLayerId });
  });

  api.get('/layers', (req, res) => {
    const snap = buildLayersSnapshot(bootstrapCloneLayerId);
    res.json({
      layers: snap.layers,
      layers_root: snap.layers_root,
      bootstrap_layer_id: snap.bootstrap_layer_id,
    });
  });

  api.post('/layers', async (req, res) => {
    const parentLayerId = req.body?.parent_layer_id ? String(req.body.parent_layer_id).trim() : '';
    if (!parentLayerId) {
      return res.status(400).json({ detail: 'parent_layer_id 必填' });
    }
    const known = new Set(listLayerRows().map((r) => r.layer_id));
    if (!known.has(parentLayerId)) {
      return res.status(404).json({ detail: 'parent layer not found' });
    }

    const lid = newLayerId();
    const root = layerPath(lid);

    try {
      createStackedLayer(lid, parentLayerId);

      // 根据层类型和提交信息设置元数据
      const layerKind = req.body?.layer_kind ? String(req.body.layer_kind).trim() : 'job';
      const commitMessage = req.body?.commit_message ? String(req.body.commit_message).trim() : '';

      // 如果是 git commit 类型，设置特殊的元数据
      if (layerKind === 'git_commit' && commitMessage) {
        const metaPath = path.join(root, 'layer_meta.json');
        if (fs.existsSync(metaPath)) {
          let meta = {};
          try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          } catch {
            meta = {};
          }
          meta.kind = 'git_commit';
          meta.commit_message = commitMessage;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        }
      }
      await mirrorLayerGraphToTaskCloudSSE();
      res.status(201).json({
        layer_id: lid,
        layer_path: root,
        parent_layer_id: parentLayerId,
        kind: layerKind,
      });
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  api.get('/jobs', (req, res) => {
    res.json({ jobs: listJobs().map((j) => jobToApiDict(j)) });
  });

  api.get('/jobs/:job_id', (req, res) => {
    const j = getJob(req.params.job_id);
    if (!j) return res.status(404).json({ detail: 'not found' });
    const includeOutput = String(req.query.include_output || '') === '1';
    res.json(jobToApiDict(j, { includeOutput }));
  });

  /** 任务原始控制台日志纯文本（供「复制日志」下载 / 按需拉取，避免塞进列表 JSON）。 */
  api.get('/jobs/:job_id/output', (req, res) => {
    const j = getJob(req.params.job_id);
    if (!j) return res.status(404).json({ detail: 'not found' });
    const text = j.output != null ? String(j.output) : '';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="job-' + j.id + '.log.txt"');
    res.send(text);
  });

  api.get('/jobs/:job_id/steps', (req, res) => {
    const j = getJob(req.params.job_id);
    if (!j) return res.status(404).json({ detail: 'not found' });
    const payload = getJobStepsForLayer(j.layer_id, j.id, j.command_kind);
    const afterStep = parseInt(String(req.query.after_step ?? '0'), 10) || 0;
    /** 未传 limit 时返回全部（兼容旧客户端）；SaaS/前端应传 limit 做按步拉取 */
    const limitQ = req.query.limit;
    const limit =
      limitQ != null && String(limitQ).trim() !== ''
        ? parseInt(String(limitQ), 10)
        : null;
    res.json(paginateJobStepsPayload(payload, { afterStep, limit }));
  });

  api.get('/jobs/:job_id/events', (req, res) => {
    const j = getJob(req.params.job_id);
    if (!j) return res.status(404).json({ detail: 'not found' });
    const offset = parseInt(req.query.offset || '0', 10) || 0;
    const limit = parseInt(req.query.limit || '500', 10) || 500;
    const result = getJobEvents(req.params.job_id, offset, limit);
    res.json(result);
  });

  api.get('/jobs/:job_id/parent', (req, res) => {
    const j = getJob(req.params.job_id);
    if (!j) return res.status(404).json({ detail: 'not found' });
    const p = j.parent_job_id ? getJob(j.parent_job_id) : null;
    res.json({ parent: p ? jobToApiDict(p) : null });
  });

  api.post('/jobs', async (req, res) => {
    try {
      const rec = await createJob(req.body || {});
      res.status(201).json(jobToApiDict(rec));
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  api.post('/jobs/:job_id/interrupt', (req, res) => {
    try {
      const rec = interruptJob(req.params.job_id);
      res.json(jobToApiDict(rec));
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  api.post('/task-lifecycle/shutdown', (req, res) => {
    // 立即 202，收尾异步执行，避免 SaaS/Events 出站 HTTP 阻塞。
    res.status(202).json({ ok: true, accepted: true });
    void import('./taskLifecycleShutdown.mjs')
      .then(({ runTerminalShutdown }) =>
        runTerminalShutdown(req.body || {}, {
          exitProcess: !['1', 'true', 'yes', 'on'].includes(
            String(process.env.TRAE_SKIP_SHUTDOWN_EXIT || '').toLowerCase(),
          ),
        }),
      )
      .catch((e) => {
        console.error(`[onlineServiceJS] task-lifecycle/shutdown failed: ${e?.message || e}`);
      });
  });

  api.post('/task-lifecycle/closing-soon', (req, res) => {
    void import('./taskLifecycleClosingSoon.mjs')
      .then(({ recordClosingSoon }) => {
        res.status(202).json(recordClosingSoon(req.body || {}));
      })
      .catch((e) => {
        console.error(`[onlineServiceJS] task-lifecycle/closing-soon failed: ${e?.message || e}`);
        res.status(500).json({ detail: String(e?.message || e) });
      });
  });

  api.delete('/jobs/:job_id', (req, res) => {
    try {
      res.json(deleteJob(req.params.job_id));
    } catch (e) {
      res.status(400).json({ detail: String(e.message || e) });
    }
  });

  api.post('/jobs/:job_id/redo', (req, res) => {
    res.status(501).json({ detail: 'onlineServiceJS: redo 尚未实现，请新建任务或在本仓库补齐该端点' });
  });

  api.post('/jobs/:job_id/continue', (req, res) => {
    res.status(501).json({ detail: 'onlineServiceJS: continue 尚未实现' });
  });

  api.post('/jobs/reset', async (req, res) => {
    const layerIds = listLayerRows().map((r) => r.layer_id);
    for (const j of [...listJobs()]) {
      try {
        deleteJob(j.id);
      } catch {
        /* ignore */
      }
    }
    for (const lid of layerIds) {
      try {
        deleteLayerTree(lid);
      } catch {
        /* ignore */
      }
    }
    await mirrorLayerGraphToTaskCloudSSE().catch(() => {});
    res.json({ jobs_cleared: true, layers_removed: layerIds });
  });

}
