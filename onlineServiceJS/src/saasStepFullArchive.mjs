/**
 * job 终态把 agent_step_full.json 全文 POST 到 SaaS job-step-full-push，
 * 由 taskCloudService 写入 COS（容器不持有密钥）。
 */
import { taskApiPrefix, postJson } from './saasTaskCloud.mjs';
import { withSaasInboundScope } from './saasInboundScope.mjs';
import { jobLogsTaeJsonPath } from './paths.mjs';
import { listAgentStepFullDocsFromTaeJsonDir } from './jobStepEvents.mjs';

export async function archiveJobStepFullToSaas(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const jobId = String(rec.id || rec.job_id || '').trim();
  if (!jobId) return false;
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.TRAE_SKIP_SAAS_STEP_FULL_ARCHIVE || '').toLowerCase())) {
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
  let steps = [];
  try {
    steps = listAgentStepFullDocsFromTaeJsonDir(jobLogsTaeJsonPath(jobId));
  } catch {
    steps = [];
  }
  const url = `${cloudPrefix.replace(/\/$/, '')}/server-container-token/job-step-full-push/`;
  const body = withSaasInboundScope({
    access_token: accessToken,
    job_id: jobId,
    job_status: rec.status != null ? String(rec.status) : '',
    layer_id: rec.layer_id != null ? String(rec.layer_id) : '',
    steps,
  });
  try {
    await postJson(url, body, 30);
    return true;
  } catch {
    return false;
  }
}
