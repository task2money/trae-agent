import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  credentialRefOf,
  ensureTraceId,
  logLlmCallAudit,
  newCallIdempotencyKey,
  normalizeChatUsage,
  providerOfBaseUrl,
} from './llmUsageAudit.mjs';

function captureStdout(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('OpenAI 包含式 usage 换算出 exclusive 输入（命中数不重复计入）', () => {
  const u = normalizeChatUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
  });
  assert.equal(u.input_tokens, 60);
  assert.equal(u.output_tokens, 20);
  assert.equal(u.cache_read_tokens, 40);
  assert.equal(u.cache_creation_tokens, 0);
  assert.equal(u.usage_schema, 'openai_inclusive');
  assert.equal(u.usage_ok, true);
  assert.equal(u.total_tokens, 120);
});

test('DeepSeek 风格命中数在 prompt_cache_hit_tokens 上，同样按包含式减出', () => {
  const u = normalizeChatUsage({
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_cache_hit_tokens: 900,
  });
  assert.equal(u.input_tokens, 100);
  assert.equal(u.cache_read_tokens, 900);
  assert.equal(u.usage_schema, 'deepseek_inclusive');
});

test('命中数大于 prompt（上游自相矛盾）时输入按 0 计，不出现负数', () => {
  const u = normalizeChatUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 99 });
  assert.equal(u.input_tokens, 0);
  assert.equal(u.cache_read_tokens, 99);
});

test('reasoning 是 output 的附加信息，不从 output 扣', () => {
  const u = normalizeChatUsage({
    prompt_tokens: 10,
    completion_tokens: 80,
    completion_tokens_details: { reasoning_tokens: 30 },
  });
  assert.equal(u.output_tokens, 80);
  assert.equal(u.reasoning_tokens, 30);
});

test('上游未返回 usage 时全零且 usage_ok=false（不得伪装成真实 0）', () => {
  for (const raw of [undefined, null, 'nonsense', {}, { id: 'x', choices: [] }]) {
    const u = normalizeChatUsage(raw);
    assert.equal(u.usage_ok, false);
    assert.equal(u.input_tokens, 0);
    assert.equal(u.output_tokens, 0);
    assert.equal(u.usage_schema, 'unknown');
  }
});

test('usage 对象存在但字段为 0 时仍算「上游返回过」', () => {
  const u = normalizeChatUsage({ prompt_tokens: 0, completion_tokens: 0 });
  assert.equal(u.usage_ok, true);
  assert.equal(u.usage_schema, 'openai_inclusive');
});

test('credential_ref 是 sha256 前 16 位，且不含密钥任何片段', () => {
  const key = 'sk-live-abcdef0123456789abcdef';
  const ref = credentialRefOf(key);
  const expect = `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  assert.equal(ref, expect);
  assert.equal(ref.includes('abcdef'), false);
  assert.equal(credentialRefOf(''), '');
});

test('provider 由 base_url 反推，未知主机退化为域名二级标签', () => {
  assert.equal(providerOfBaseUrl('https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(providerOfBaseUrl('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(providerOfBaseUrl('https://llm.internal.example.com/v1'), 'example');
  assert.equal(providerOfBaseUrl(''), 'unknown');
});

test('trace_id 在请求无 trace 头时仍非空（规则 78 要求必填非空）', () => {
  const tid = ensureTraceId({ headers: {} });
  assert.ok(tid && tid.length > 0);
});

test('llm_call 审计行带齐必备字段，不含密钥明文，且 outcome/status 如实', () => {
  const key = 'sk-secret-value-should-never-appear';
  const lines = captureStdout(() =>
    logLlmCallAudit({
      req: { headers: { 'x-trace-id': 'trace-abc-123456' } },
      agent_source: 'system',
      base_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      api_key: key,
      usage: { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 40 },
      outcome: 'ok',
      http_status: 200,
      latency_ms: 42,
      idempotency_key: 'llm-staged-commit-suggest-fixed',
    }),
  );
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.msg, 'llm_call');
  assert.equal(rec.trace_id, 'trace-abc-123456');
  assert.equal(rec.provider, 'deepseek');
  assert.equal(rec.model, 'deepseek-chat');
  assert.equal(rec.input_tokens, 60);
  assert.equal(rec.cache_read_tokens, 40);
  assert.equal(rec.output_tokens, 7);
  assert.equal(rec.usage_ok, true);
  assert.equal(rec.outcome, 'ok');
  assert.equal(rec.http_status, 200);
  assert.equal(rec.latency_ms, 42);
  assert.equal(rec.idempotency_key, 'llm-staged-commit-suggest-fixed');
  assert.equal(rec.credential_ref, credentialRefOf(key));
  assert.match(rec.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(lines[0].includes(key), false, '审计行泄漏了 API Key 明文');
});

test('失败调用同样落审计行，http_status=0 表示没拿到响应', () => {
  const lines = captureStdout(() =>
    logLlmCallAudit({
      base_url: 'https://openrouter.ai/api/v1',
      model: 'm',
      api_key: 'k',
      outcome: 'upstream_error',
      latency_ms: 1500,
      error: 'The operation was aborted',
    }),
  );
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.outcome, 'upstream_error');
  assert.equal(rec.http_status, 0);
  assert.equal(rec.usage_ok, false);
  assert.equal(rec.error, 'The operation was aborted');
  assert.ok(rec.trace_id, 'trace_id 不得为空');
});

test('幂等键逐次唯一且带 scope 前缀', () => {
  const a = newCallIdempotencyKey('diff-log-summary');
  const b = newCallIdempotencyKey('diff-log-summary');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('llm-diff-log-summary-'));
});
