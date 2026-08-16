/**
 * 容器执行步骤/作业生命周期上报 SaaS `server-container-token/job-stream-push/`。
 * Cloud 先打 Kafka SSE_MESSAGE，再经 SSE 到前端；落库由 Kafka 消费者完成。
 */
import { taskApiPrefix, postJson } from './saasTaskCloud.mjs';
import { withSaasInboundScope } from './saasInboundScope.mjs';

export async function publishJobStreamEventToSaas(fields) {
  if (!fields || typeof fields !== 'object') return false;
  const jobId = String(fields.job_id || '').trim();
  const phase = String(fields.phase || '').trim();
  if (!jobId || !phase) return false;
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRAE_SKIP_SAAS_JOB_STREAM_PUSH || '').toLowerCase())) {
    return false;
  }
  let cloudPrefix;
  try {
    cloudPrefix = taskApiPrefix();
  } catch {
    return false;
  }
  const accessToken = String(process.env.ACCESS_TOKEN || '').trim();
  if (!cloudPrefix || !accessToken) return false;
  const url = `${cloudPrefix.replace(/\/$/, '')}/server-container-token/job-stream-push/`;
  const body = withSaasInboundScope({
    access_token: accessToken,
    job_id: jobId,
    phase,
    seq: Number.isFinite(Number(fields.seq)) ? Math.floor(Number(fields.seq)) : 0,
    message: fields.message != null ? String(fields.message) : '',
  });
  if (fields.job_status) body.job_status = String(fields.job_status);
  if (fields.layer_id) body.layer_id = String(fields.layer_id);
  if (fields.step_number != null && Number.isFinite(Number(fields.step_number))) {
    body.step_number = Math.floor(Number(fields.step_number));
  }
  if (fields.delivery_summary) body.delivery_summary = String(fields.delivery_summary);
  if (fields.state) body.state = String(fields.state);
  if (fields.event && typeof fields.event === 'object') body.event = fields.event;
  try {
    await postJson(url, body, 12);
    return true;
  } catch {
    return false;
  }
}
