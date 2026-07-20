import fs from 'fs';
import YAML from 'yaml';
import {
  appendOutboundReqLog,
  isDebugAgentEnabled,
  debugAgentStringify,
} from './outboundReqLog.mjs';
import { configFilePath } from './paths.mjs';

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

async function callOpenAiCompatibleChat({ baseUrl, apiKey, model }, userContent) {
  const url = `${baseUrl}/chat/completions`;
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
    const text = await r.text();
    if (isDebugAgentEnabled()) {
      appendOutboundReqLog(
        `DEBUG_AGENT outbound response method=POST url=${url} status=${r.status} headers=${debugAgentStringify(Object.fromEntries(r.headers.entries()))} body=${text}`,
      );
    }
    if (!r.ok) {
      appendOutboundReqLog(`diff-log-summary LLM HTTP ${r.status} ${text.slice(0, 240)}`);
      return null;
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return null;
    }
    const c = j?.choices?.[0]?.message?.content;
    return typeof c === 'string' ? c.trim() : null;
  } catch (e) {
    appendOutboundReqLog(`diff-log-summary LLM error ${String(e?.message || e).slice(0, 320)}`);
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

export async function generateDiffSummary(diffLogs) {
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
      creds,
      `以下是 git diff 内容（可能被截断）：\n\n${diffTrim}`,
    );
    if (summary) return summary;
  }

  return heuristicSummary(diffLogs);
}
