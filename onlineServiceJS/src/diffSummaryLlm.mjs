import fs from 'fs';
import YAML from 'yaml';
import {
  appendOutboundReqLog,
  isDebugAgentEnabled,
  debugAgentStringify,
} from './outboundReqLog.mjs';
import { configFilePath } from './paths.mjs';
import { logLlmCallAudit, newCallIdempotencyKey } from './llmUsageAudit.mjs';

const AI_SUMMARY_MAX_DIFF = 28000;
const AI_SUMMARY_TIMEOUT_MS = 45000;

function resolveLlmFromEnv() {
  const baseUrl = String(process.env.TRAE_STAGED_COMMIT_LLM_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  const apiKey = String(process.env.TRAE_STAGED_COMMIT_LLM_API_KEY || '').trim();
  const model = String(process.env.TRAE_STAGED_COMMIT_LLM_MODEL || '').trim();
  if (baseUrl && apiKey && model) return { baseUrl, apiKey, model };
  return null;
}

function resolveLlmFromYaml() {
  const p = configFilePath();
  if (!fs.existsSync(p)) return null;
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const agentKey = doc.agents?.trae_agent?.model;
  if (!agentKey || typeof agentKey !== 'string') return null;
  const mdef = doc.models?.[agentKey];
  if (!mdef || typeof mdef !== 'object') return null;
  const provKey = mdef.model_provider;
  const modelId = mdef.model;
  if (!provKey || !modelId) return null;
  const prov = doc.model_providers?.[provKey];
  if (!prov || typeof prov !== 'object') return null;
  const apiKey = String(prov.api_key || '').trim();
  if (!apiKey || apiKey.includes('your_')) return null;
  let baseUrl = String(prov.base_url || '').trim().replace(/\/$/, '');
  const provName = String(prov.provider || provKey || '').toLowerCase();
  if (!baseUrl) {
    if (provName === 'openai') baseUrl = 'https://api.openai.com/v1';
    else if (provName === 'openrouter') baseUrl = 'https://openrouter.ai/api/v1';
    else return null;
  }
  return { baseUrl, apiKey, model: String(modelId) };
}

/**
 * 审计用的调用主体标识。两条凭据来源（进程 env 注入 / 容器内 service_config.yaml）在
 * 本进程里**无法区分**是平台托管 key 还是租户自备 key —— service_config.yaml 由 SaaS
 * feature-params-env 下发，故一律按 `system` 记（宁可漏标自备，不可错标托管）。
 */
const AUDIT_AGENT_SOURCE = 'system';

async function callOpenAiCompatibleChat({ baseUrl, apiKey, model, req }, userContent) {
  const url = `${baseUrl}/chat/completions`;
  const idempotencyKey = newCallIdempotencyKey('diff-log-summary');
  const startedAt = Date.now();
  let httpStatus = 0;
  let usage = null;
  const audit = (outcome, error) =>
    logLlmCallAudit({
      req,
      agent_source: AUDIT_AGENT_SOURCE,
      base_url: baseUrl,
      model,
      api_key: apiKey,
      usage,
      outcome,
      http_status: httpStatus,
      latency_ms: Date.now() - startedAt,
      idempotency_key: idempotencyKey,
      error,
    });
  appendOutboundReqLog(`diff-log-summary POST ${url} model=${model}`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), AI_SUMMARY_TIMEOUT_MS);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const reqBody = {
    model,
    messages: [
      {
        role: 'system',
        content: '你是一个代码变更总结助手。请根据用户提供的 git diff 内容，用简洁的中文总结用户做了什么修改。输出格式：1. 变更类型：描述；2. 涉及文件：文件名列表；3. 主要改动：简要说明。保持简洁明了。',
      },
      { role: 'user', content: userContent },
    ],
    max_tokens: 256,
    temperature: 0.3,
  };
  try {
    if (isDebugAgentEnabled()) {
      appendOutboundReqLog(
        `DEBUG_AGENT outbound request method=POST url=${url} headers=${debugAgentStringify(headers)} body=${debugAgentStringify(reqBody)}`,
      );
    }
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: ac.signal,
    });
    httpStatus = r.status;
    const text = await r.text();
    if (isDebugAgentEnabled()) {
      appendOutboundReqLog(
        `DEBUG_AGENT outbound response method=POST url=${url} status=${r.status} headers=${debugAgentStringify(Object.fromEntries(r.headers.entries()))} body=${text}`,
      );
    }
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* 非 JSON 回包（错误页/网关 HTML）走下面的 parse_fail / http_fail 分支 */
    }
    // usage 在失败回包上也可能存在（部分上游按已生成 token 计费），先取再判状态。
    if (j && typeof j === 'object') usage = j.usage ?? null;
    if (!r.ok) {
      appendOutboundReqLog(`diff-log-summary LLM HTTP ${r.status} ${text.slice(0, 240)}`);
      audit('http_fail', `HTTP ${r.status} ${text.slice(0, 160)}`);
      return null;
    }
    if (!j) {
      appendOutboundReqLog(`diff-log-summary LLM parse_fail ${text.slice(0, 240)}`);
      audit('parse_fail', '响应不是合法 JSON');
      return null;
    }
    const c = j?.choices?.[0]?.message?.content;
    if (typeof c !== 'string') {
      audit('parse_fail', '响应缺少 choices[0].message.content');
      return null;
    }
    audit('ok');
    return c.trim();
  } catch (e) {
    appendOutboundReqLog(`diff-log-summary LLM error ${String(e?.message || e).slice(0, 320)}`);
    audit('upstream_error', String(e?.message || e));
    return null;
  } finally {
    clearTimeout(t);
  }
}

function heuristicSummary(diffLogs) {
  const changed = diffLogs.filter(d => d.has_changes);
  const removed = changed.filter(d => d.diff.includes('/dev/null')).map(d => d.file);
  const added = changed.filter(d => d.diff.startsWith('--- /dev/null')).map(d => d.file);
  const modified = changed.filter(d => !d.diff.includes('/dev/null') || !d.diff.startsWith('--- /dev/null')).map(d => d.file);

  const parts = [];
  if (removed.length > 0) {
    parts.push(`删除文件：${removed.join(', ')}`);
  }
  if (added.length > 0) {
    parts.push(`新增文件：${added.join(', ')}`);
  }
  if (modified.length > 0) {
    parts.push(`修改文件：${modified.join(', ')}`);
  }
  if (parts.length === 0) {
    return '未检测到变更';
  }
  return parts.join('；');
}

export async function generateDiffSummary(diffLogs, { req } = {}) {
  if (String(process.env.TRAE_STAGED_COMMIT_LLM_DISABLE || '').trim() === '1') {
    return heuristicSummary(diffLogs);
  }

  const changed = diffLogs.filter(d => d.has_changes);
  if (changed.length === 0) {
    return '未检测到变更';
  }

  const diffContent = changed.map(d => `=== ${d.file} ===\n${d.diff}`).join('\n\n');
  const diffTrim = diffContent.slice(0, AI_SUMMARY_MAX_DIFF);

  const creds = resolveLlmFromEnv() || resolveLlmFromYaml();
  if (creds && diffTrim.trim()) {
    const summary = await callOpenAiCompatibleChat(
      { ...creds, req },
      `以下是 git diff 内容（可能被截断）：\n\n${diffTrim}`,
    );
    if (summary) return summary;
  }

  return heuristicSummary(diffLogs);
}
