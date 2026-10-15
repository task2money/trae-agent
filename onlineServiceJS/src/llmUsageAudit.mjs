/**
 * 智能体 LLM 出站用量审计（约束 78 / ADR-0168）——onlineServiceJS 侧记录器。
 *
 * 本模块服务两处出站：diff 摘要（`diffSummaryLlm.mjs`）与暂存提交建议
 * （`stagedCommitSuggest.mjs`）。此前它们只往 `reqLogs/outbound.log` 写纯文本行，
 * HTTP 状态与耗时都有，**上游 usage 一个字段都没解析** —— 于是平台侧算不出这两个
 * 高频动作的 token 账，缓存命中率塌了也无从发现。
 *
 * 落一行扁平 JSON 日志（`msg=llm_call`），字段与约束 78 必备表逐项对应：
 * - 缓存口径统一为 **exclusive**（`input_tokens` 不含命中），换算见 `normalizeChatUsage`；
 * - `credential_ref` 只存 API Key 的 sha256 前 16 位，禁止明文/Bearer 全量；
 * - `trace_id` 非空：走 `logJson` 注入（`resolveTraceId`），不在此手写裸字段；
 * - `usage_ok` 区分「上游未返回 usage」与「真实 0」，两条退化路径都不得伪装成有账。
 */
import { createHash, randomUUID } from 'node:crypto';
import { logJson } from './jsonLog.mjs';
import { resolveTraceId, startupTraceId } from './traceId.mjs';

// 上游 usage 口径标识（与 taskAIEndPoint / taskPageAdvisor 的命名对齐）。
const SCHEMA_OPENAI_INCLUSIVE = 'openai_inclusive';
const SCHEMA_DEEPSEEK_INCLUSIVE = 'deepseek_inclusive';
const SCHEMA_ANTHROPIC_EXCLUSIVE = 'anthropic_exclusive';
const SCHEMA_UNKNOWN = 'unknown';

function intOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function detailsOf(raw, ...path) {
  let cur = raw;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function envStr(name) {
  return String(process.env[name] || '').trim();
}

/** 由 base_url 反推厂商标识（不内嵌厂商域名，避免与「直连」判定混淆）。 */
export function providerOfBaseUrl(baseUrl) {
  let host = '';
  try {
    const u = new URL(String(baseUrl || '').includes('://') ? baseUrl : `http://${baseUrl}`);
    host = u.hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  for (const name of ['openai', 'deepseek', 'anthropic', 'openrouter', 'dashscope', 'moonshot', 'zhipu', 'qwen', 'gemini']) {
    if (host.includes(name)) return name;
  }
  const labels = host.split('.').filter(Boolean);
  return labels.length >= 2 ? labels[labels.length - 2] : host || 'unknown';
}

/** 凭据标识：sha256 前 16 位，禁止明文（约束 78「凭据标识而非凭据」）。 */
export function credentialRefOf(apiKey) {
  const secret = String(apiKey ?? '').trim();
  if (!secret) return '';
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
}

/** 每次出站一个去重键（本层无重试；上层重试属另一次真实调用，故逐次唯一）。 */
export function newCallIdempotencyKey(scope) {
  return `llm-${String(scope || 'online-service')}-${randomUUID()}`;
}

/**
 * 上游 usage → exclusive 口径账目。
 *
 * OpenAI / OpenRouter 与 DeepSeek 的 prompt 计数**包含**缓存命中，而本仓
 * `input_tokens` 约定为「未命中」那部分（与 anthropic 客户端、平台网关
 * `normalizeAuditUsage` 一致）。不减去命中数，同一份用量在两家会一个记 100、
 * 一个记 60，跨 provider 成本对比与缓存收益核算直接失真。
 * 减成负数时按 0 计（上游自相矛盾时以命中数为准）。
 */
export function normalizeChatUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
      usage_ok: false,
      usage_schema: SCHEMA_UNKNOWN,
    };
  }
  const raw = rawUsage;
  const openAiStyle = raw.prompt_tokens !== undefined;
  const hasFields =
    raw.prompt_tokens !== undefined ||
    raw.input_tokens !== undefined ||
    raw.completion_tokens !== undefined ||
    raw.output_tokens !== undefined ||
    raw.total_tokens !== undefined;
  const prompt = intOf(openAiStyle ? raw.prompt_tokens : raw.input_tokens);
  const completion = intOf(raw.completion_tokens !== undefined ? raw.completion_tokens : raw.output_tokens);
  const cacheRead = openAiStyle
    ? intOf(detailsOf(raw, 'prompt_tokens_details', 'cached_tokens')) ||
      intOf(detailsOf(raw, 'input_tokens_details', 'cached_tokens')) ||
      intOf(raw.prompt_cache_hit_tokens)
    : intOf(raw.cache_read_input_tokens);
  // OpenAI 系不报缓存写入；保留字段是为了「上游哪天报了」不必再改结构。
  const cacheCreation = openAiStyle
    ? intOf(detailsOf(raw, 'prompt_tokens_details', 'cache_creation_tokens')) ||
      intOf(raw.prompt_cache_creation_tokens)
    : intOf(raw.cache_creation_input_tokens);
  const reasoning =
    intOf(detailsOf(raw, 'completion_tokens_details', 'reasoning_tokens')) ||
    intOf(detailsOf(raw, 'output_tokens_details', 'reasoning_tokens'));
  const input = openAiStyle ? Math.max(prompt - cacheRead, 0) : prompt;
  // 一个用量字段都没有（如只回了 id/choices）时口径无从判断，标 unknown 而不是硬套
  // 某一家 —— 否则跨 provider 汇总会把「没账」记成「某口径的 0」。
  const schema = !hasFields
    ? SCHEMA_UNKNOWN
    : openAiStyle
      ? raw.prompt_cache_hit_tokens !== undefined
        ? SCHEMA_DEEPSEEK_INCLUSIVE
        : SCHEMA_OPENAI_INCLUSIVE
      : SCHEMA_ANTHROPIC_EXCLUSIVE;
  const total = intOf(raw.total_tokens) || input + completion + cacheRead + cacheCreation;
  return {
    input_tokens: input,
    output_tokens: completion,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    reasoning_tokens: reasoning,
    total_tokens: total,
    usage_ok: hasFields,
    usage_schema: schema,
  };
}

/**
 * 非空 trace_id。
 *
 * `resolveTraceId({ req })` 在「有 req 但请求头没带 trace」时**返回空串**（刻意为
 * 防止 request-scoped 日志落到陈旧的进程级 TRACE_ID）。审计行不能接受空值
 * （约束 78「trace_id 必填非空」），故这里显式补一层：请求头 → 进程启动值 → 生成。
 */
export function ensureTraceId(req) {
  const fromCtx = resolveTraceId({ req }) || startupTraceId();
  return fromCtx || `gen-${randomUUID()}`;
}

/**
 * 落一行 `llm_call` 审计（成功与失败都要落，禁止只记成功的）。
 *
 * @param {object} fields
 * @param {object} [fields.req] 请求上下文（trace 来源）
 * @param {string} fields.agent_source `system` / `own` / `external` / `trial`
 * @param {string} fields.base_url 上游地址（不含密钥）
 * @param {string} fields.model 本次请求的模型名
 * @param {string} fields.api_key 仅用于算 credential_ref，不落日志
 * @param {object|null} fields.usage 上游 usage 原文
 * @param {'ok'|'http_fail'|'parse_fail'|'upstream_error'} fields.outcome
 * @param {number} fields.http_status 0 = 未拿到响应（连接/超时）
 * @param {number} fields.latency_ms
 * @param {string} [fields.error] 失败摘要（已截断，不得含密钥）
 */
export function logLlmCallAudit(fields = {}) {
  const usage = normalizeChatUsage(fields.usage);
  const httpStatus = Number.isFinite(Number(fields.http_status)) ? Math.floor(Number(fields.http_status)) : 0;
  const latencyMs = Number.isFinite(Number(fields.latency_ms)) ? Math.max(0, Math.floor(Number(fields.latency_ms))) : 0;
  // 键名带引号是刻意的：门禁 check_llm_usage_audit 按字面量（含引号）核验必备字段，
  // 少一个即视为契约破坏。改字段名必须同步那条门禁。
  const payload = {
    "tenant_id": envStr('tenantId'),
    "workspace_id": envStr('workspaceId'),
    "task_id": envStr('taskId'),
    "agent_source": String(fields.agent_source || 'system'),
    "credential_ref": credentialRefOf(fields.api_key),
    "provider": providerOfBaseUrl(fields.base_url),
    "base_url": String(fields.base_url || ''),
    "model": String(fields.model || ''),
    "input_tokens": usage.input_tokens,
    "output_tokens": usage.output_tokens,
    "cache_read_tokens": usage.cache_read_tokens,
    "cache_creation_tokens": usage.cache_creation_tokens,
    "reasoning_tokens": usage.reasoning_tokens,
    "total_tokens": usage.total_tokens,
    "usage_ok": usage.usage_ok,
    "usage_schema": usage.usage_schema,
    "outcome": String(fields.outcome || 'ok'),
    "http_status": httpStatus,
    "latency_ms": latencyMs,
    "idempotency_key": String(fields.idempotency_key || newCallIdempotencyKey('online-service')),
    "created_at": new Date().toISOString(),
  };
  if (fields.error) payload.error = String(fields.error).slice(0, 240);
  logJson('info', 'llm_call', { req: fields.req, trace_id: ensureTraceId(fields.req), ...payload });
}
