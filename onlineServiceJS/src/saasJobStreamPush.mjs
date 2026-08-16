import { recordJobEvent as recordJobEventMem, getJob } from './jobsRuntimeState.mjs';
import { publishJobStreamEventToSaas } from './saasTaskCloudJobStream.mjs';

const DEFAULT_CHUNK_FLUSH_MS = 150;
const DEFAULT_CHUNK_MAX_CHARS = 6000;

/** 短窗口内按 job_id 合并 chunk，避免每个 stdout 片段都 POST job-stream-push（OPT-20260816-041）。 */
const pendingChunks = new Map();

function chunkBufferConfigFromEnv() {
  const flushRaw = parseInt(String(process.env.TASK_JOB_STREAM_CHUNK_FLUSH_MS || ''), 10);
  const maxRaw = parseInt(String(process.env.TASK_JOB_STREAM_CHUNK_MAX_CHARS || ''), 10);
  return {
    flushMs: Number.isFinite(flushRaw) && flushRaw >= 10 ? flushRaw : DEFAULT_CHUNK_FLUSH_MS,
    maxChars: Number.isFinite(maxRaw) && maxRaw >= 512 ? maxRaw : DEFAULT_CHUNK_MAX_CHARS,
  };
}

function publishChunk(jobId, entry) {
  const message = entry.buf;
  if (!message) return;
  void publishJobStreamEventToSaas({
    job_id: jobId,
    seq: entry.seq,
    phase: 'chunk',
    message,
    step_number: entry.stepNumber,
    delivery_summary: entry.deliverySummary,
    state: entry.state,
    event: { phase: 'chunk', message, ts: entry.ts },
    job_status: entry.jobStatus,
    layer_id: entry.layerId,
  });
}

function flushChunkForJob(jobId) {
  const entry = pendingChunks.get(jobId);
  if (!entry) return;
  pendingChunks.delete(jobId);
  if (entry.timer) clearTimeout(entry.timer);
  publishChunk(jobId, entry);
}

/** 立即清空所有待 flush 的 chunk（测试与进程退出时调用）。 */
export function flushPendingJobStreamChunks() {
  for (const jobId of [...pendingChunks.keys()]) flushChunkForJob(jobId);
}

function enqueueChunk(jobId, row, rec) {
  const cfg = chunkBufferConfigFromEnv();
  const existing = pendingChunks.get(jobId);
  const buf = (existing ? existing.buf : '') + row.message;
  const entry = {
    buf,
    seq: row.seq,
    ts: row.ts,
    stepNumber: row.step_number,
    deliverySummary: row.delivery_summary,
    state: row.state,
    jobStatus: rec && rec.status ? rec.status : '',
    layerId: rec && rec.layer_id ? rec.layer_id : '',
    timer: existing && existing.timer ? existing.timer : null,
  };
  if (buf.length >= cfg.maxChars) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    pendingChunks.set(jobId, entry);
    flushChunkForJob(jobId);
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const cur = pendingChunks.get(jobId);
    if (cur && cur.timer) cur.timer = null;
    flushChunkForJob(jobId);
  }, cfg.flushMs);
  if (typeof entry.timer.unref === 'function') entry.timer.unref();
  pendingChunks.set(jobId, entry);
}

/**
 * 内存记录执行事件，并异步 PUSH 到 SaaS（Kafka → SSE / 落库消费者）。
 * phase=chunk 按 job_id 短窗口合并后一次性 POST；step/start/终态立即 flush 并绕过 debounce。
 */
export function recordJobEvent(jobId, phase, message = '', extra = {}) {
  const row = recordJobEventMem(jobId, phase, message, extra);
  const rec = getJob(jobId);
  const event = extra && typeof extra === 'object' ? { phase: row.phase, message: row.message, ts: row.ts, ...extra } : {
    phase: row.phase,
    message: row.message,
    ts: row.ts,
  };

  if (row.phase === 'chunk') {
    enqueueChunk(jobId, row, rec);
    return row;
  }

  // step/start/终态：先 flush 待发 chunk 保证顺序，再立即推送自身
  flushChunkForJob(jobId);
  void publishJobStreamEventToSaas({
    job_id: jobId,
    seq: row.seq,
    phase: row.phase,
    message: row.message,
    step_number: row.step_number,
    delivery_summary: extra && extra.delivery_summary,
    state: extra && extra.state,
    event,
    job_status: rec && rec.status ? rec.status : '',
    layer_id: rec && rec.layer_id ? rec.layer_id : '',
  });
  return row;
}
