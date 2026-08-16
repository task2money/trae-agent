import { recordJobEvent as recordJobEventMem, getJob } from './jobsRuntimeState.mjs';
import { publishJobStreamEventToSaas } from './saasTaskCloudJobStream.mjs';

/**
 * 内存记录执行事件，并异步 PUSH 到 SaaS（Kafka → SSE / 落库消费者）。
 */
export function recordJobEvent(jobId, phase, message = '', extra = {}) {
  const row = recordJobEventMem(jobId, phase, message, extra);
  const rec = getJob(jobId);
  const event = extra && typeof extra === 'object' ? { phase: row.phase, message: row.message, ts: row.ts, ...extra } : {
    phase: row.phase,
    message: row.message,
    ts: row.ts,
  };
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
