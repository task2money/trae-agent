import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { jobsStatePath } from './paths.mjs';

/** @type {Map<string, object>} */
const jobs = new Map();
/** @type {Map<string, import('child_process').ChildProcess>} */
const running = new Map();

/** @type {Map<string, Array<{ phase: string, message: string, ts: number }>>} */
const jobEvents = new Map();

/** 某层上「当前任务结束后」按顺序执行的指令（与 UI 加入队列一致）；键为层 id，值为待执行项 */
/** @type {Record<string, Array<{ command: string, command_kind: string, env?: object | null }>>} */
let layerQueues = {};

const MAX_OUTPUT_LENGTH = 50000;
const OUTPUT_TRUNCATION_MARKER = '\n[...truncated...]\n';

export function getJobsMap() {
  return jobs;
}

export function getRunningMap() {
  return running;
}

export function getLayerQueues() {
  return layerQueues;
}

export function setLayerQueues(next) {
  layerQueues = next;
}

export function recordJobEvent(jobId, phase, message = '') {
  const events = jobEvents.get(jobId) || [];
  events.push({ phase, message, ts: Date.now() });
  jobEvents.set(jobId, events);
}

/**
 * Truncate job output if it exceeds MAX_OUTPUT_LENGTH, keeping only the tail.
 * ExecStream is NOT affected — only the in-memory rec.output buffer.
 */
export function truncateJobOutput(rec) {
  if (!rec || typeof rec.output !== 'string') return;
  if (rec.output.length <= MAX_OUTPUT_LENGTH) return;
  rec.output = OUTPUT_TRUNCATION_MARKER + rec.output.slice(-MAX_OUTPUT_LENGTH);
}

export function getJobEvents(jobId, offset = 0, limit = 500) {
  const events = jobEvents.get(jobId) || [];
  const start = Math.max(0, offset);
  const end = start + limit;
  return {
    events: events.slice(start, end),
    next_offset: end < events.length ? end : null,
  };
}

export function newJobId() {
  return crypto.randomUUID();
}

export function saveState() {
  for (const j of jobs.values()) {
    truncateJobOutput(j);
  }
  const payload = {
    jobs: [...jobs.values()].map((j) => ({ ...j })),
    layer_queues: { ...layerQueues },
  };
  const p = jobsStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
}

export function loadState() {
  const p = jobsStatePath();
  if (!fs.existsSync(p)) return;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const row of data.jobs || []) {
      if (!row.id) continue;
      if (row.status === 'running') row.status = 'interrupted';
      jobs.set(row.id, row);
    }
    const lq = data.layer_queues;
    if (lq && typeof lq === 'object' && !Array.isArray(lq)) {
      layerQueues = {};
      for (const [k, v] of Object.entries(lq)) {
        if (!k || !Array.isArray(v)) continue;
        const cleaned = v
          .filter((x) => x && String(x.command || '').trim())
          .map((x) => ({
            command: String(x.command).trim(),
            command_kind: String(x.command_kind || 'trae').toLowerCase(),
            env: x.env && typeof x.env === 'object' ? x.env : null,
          }));
        if (cleaned.length) layerQueues[k] = cleaned;
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 将内存中的 job 转为 API 可见字段。
 * 默认不附带完整 output（列表 / 层级快照可达十余 MB，拖垮 JSON 与剪贴板）；
 * 需要全文时传 `{ includeOutput: true }`（如 GET /api/jobs/:id?include_output=1）。
 *
 * @param {object} rec
 * @param {{ includeOutput?: boolean }} [opts]
 */
export function jobToApiDict(rec, opts = {}) {
  const includeOutput = opts.includeOutput === true;
  const out = rec && rec.output != null ? String(rec.output) : '';
  const base = { ...rec, git_destructive_locked: false, output_chars: out.length };
  if (includeOutput) {
    base.output = out;
    base.output_omitted = false;
  } else {
    delete base.output;
    base.output_omitted = true;
  }
  return base;
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function removeLayerQueue(layerId) {
  const lid = String(layerId || '').trim();
  if (!lid || !layerQueues[lid]) return;
  delete layerQueues[lid];
  saveState();
}

loadState();
