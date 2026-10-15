/**
 * 根据暂存区 diff 调用 OpenAI 兼容 Chat Completions 生成提交说明；无密钥或失败时回退为启发式短句。
 * 凭证：环境变量 TRAE_STAGED_COMMIT_LLM_* 优先，否则从 service_config.yaml（与 trae 任务配置同结构）解析 openai/openrouter。
 * 出站请求写入 reqLogs/outbound.log（不含 API Key）。
 */
import fs from 'fs';
import YAML from 'yaml';
import { configFilePath } from './paths.mjs';
import { appendOutboundReqLog, isDebugAgentEnabled, debugAgentStringify } from './outboundReqLog.mjs';
import { logLlmCallAudit, newCallIdempotencyKey } from './llmUsageAudit.mjs';

const DIFF_MAX = 28000;
const LLM_TIMEOUT_MS = 45000;

/**
 * 审计用的调用主体标识。两条凭据来源（进程 env 注入 / 容器内 service_config.yaml）在
 * 本进程里**无法区分**是平台托管 key 还是租户自备 key —— service_config.yaml 由 SaaS
 * feature-params-env 下发，故一律按 `system` 记（宁可漏标自备，不可错标托管）。
 */
const AUDIT_AGENT_SOURCE = 'system';

function sanitizeOneLine(s) {
  const t = String(s || '').replace(/\r/g, '').trim();
  if (!t) return '';
  const line = t.split('\n')[0].trim();
  return line.slice(0, 500);
}

function heuristicMessage(statOut, nameOnlyBuf) {
  const raw = String(nameOnlyBuf || '');
  const names = raw.includes('\0')
    ? raw.split('\0').map((x) => x.trim()).filter(Boolean)
    : raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (names.length === 1) return `更新 ${names[0]}`;
  if (names.length > 1) return `更新 ${names.length} 个文件`;
  const st = String(statOut || '').trim();
  if (st) {
    const lines = st.split('\n').filter(Boolean);
    const last = lines[lines.length - 1] || st;
    const one = sanitizeOneLine(last);
    if (one) return one;
  }
  return '暂存区变更';
}

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

async function callOpenAiCompatibleChat({ baseUrl, apiKey, model, req }, userContent) {
  const url = `${baseUrl}/chat/completions`;
  const idempotencyKey = newCallIdempotencyKey('staged-commit-suggest');
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
  appendOutboundReqLog(`staged-commit-suggest POST ${url} model=${model}`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const reqBody = {
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是助手。根据用户提供的 git 暂存区（已索引）unified diff，用中文写一句简短的提交说明：一行标题风格，不超过 72 个字符。只输出这一句说明，不要引号、不要前缀或解释。',
      },
      { role: 'user', content: userContent },
    ],
    max_tokens: 128,
    temperature: 0.2,
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
      appendOutboundReqLog(`staged-commit-suggest LLM HTTP ${r.status} ${text.slice(0, 240)}`);
      audit('http_fail', `HTTP ${r.status} ${text.slice(0, 160)}`);
      return null;
    }
    if (!j) {
      appendOutboundReqLog(`staged-commit-suggest LLM parse_fail ${text.slice(0, 240)}`);
      audit('parse_fail', '响应不是合法 JSON');
      return null;
    }
    const c = j?.choices?.[0]?.message?.content;
    const out = typeof c === 'string' ? c : '';
    const msg = sanitizeOneLine(out) || null;
    if (!msg) {
      audit('parse_fail', '响应缺少 choices[0].message.content');
      return null;
    }
    audit('ok');
    return msg;
  } catch (e) {
    appendOutboundReqLog(`staged-commit-suggest LLM error ${String(e?.message || e).slice(0, 320)}`);
    audit('upstream_error', String(e?.message || e));
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {(args: string[], cwd: string) => Promise<string>} gitExec
 * @param {string} workDir 仓库根目录（与 git add 所用一致）
 */
export async function suggestStagedCommitMessage(gitExec, workDir, { req } = {}) {
  if (String(process.env.TRAE_STAGED_COMMIT_LLM_DISABLE || '').trim() === '1') {
    let stat = '';
    let names = '';
    try {
      stat = await gitExec(['diff', '--cached', '--stat'], workDir);
    } catch {
      stat = '';
    }
    try {
      names = await gitExec(['diff', '--cached', '-z', '--name-only'], workDir);
    } catch {
      names = '';
    }
    return heuristicMessage(stat, names);
  }

  let diff = '';
  let stat = '';
  let names = '';
  try {
    diff = await gitExec(['diff', '--cached'], workDir);
  } catch {
    diff = '';
  }
  try {
    stat = await gitExec(['diff', '--cached', '--stat'], workDir);
  } catch {
    stat = '';
  }
  try {
    names = await gitExec(['diff', '--cached', '-z', '--name-only'], workDir);
  } catch {
    names = '';
  }

  const diffTrim = String(diff || '').slice(0, DIFF_MAX);
  const creds = resolveLlmFromEnv() || resolveLlmFromYaml();
  if (creds && diffTrim.trim()) {
    const msg = await callOpenAiCompatibleChat(
      { ...creds, req },
      `以下是 git 暂存区的 unified diff（可能被截断）：\n\n${diffTrim}`,
    );
    if (msg) return msg;
  }

  return heuristicMessage(stat, names);
}
