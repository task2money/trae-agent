/**
 * 源码扫描：出站 SaaS JSON 必须经 postJson（自动带 comment_id）或 withSaasInboundScope。
 * GitHub / LLM 裸 fetch 不在此列。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const SKIP = /\.test\.|\.spec\./;
const SAAS_URL = /server-container-token\/|container-agent-comments/;
const SCOPE = /withSaasInboundScope|saasInboundScopeFields|postJson(?:WithAbortRetry)?\b/;
const CALL = /\bfetch\s*\(|fetchFn\s*\(|postJson(?:WithAbortRetry)?\b/;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.mjs') && !SKIP.test(name)) acc.push(p);
  }
  return acc;
}

test('SaaS 出站 JSON 源文件必须带 comment_id helper', () => {
  const files = walk(here).filter((p) => {
    const src = readFileSync(p, 'utf8');
    if (!SAAS_URL.test(src)) return false;
    if (!CALL.test(src)) return false;
    return true;
  });
  assert.ok(files.length >= 12, `expected SaaS callers, got ${files.length}`);
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    assert.match(src, SCOPE, `${p.split('/src/')[1]} missing comment_id helper`);
  }
});
