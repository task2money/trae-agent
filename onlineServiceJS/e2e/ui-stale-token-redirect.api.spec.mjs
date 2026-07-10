// @ts-check
/**
 * 换票后旧 /ui/{bootstrap} 书签 → 302 到当前 token；session/ui-redirect 自愈。
 * 自启临时 onlineServiceJS（不依赖 8765 上已有实例）。
 *
 *   npx playwright test --project=api e2e/ui-stale-token-redirect.api.spec.mjs
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, '..');

const CURRENT = 'tok_current_e2e_ui';
const STALE = 'tok_bootstrap_e2e_ui';
const PORT = 19877;

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
/** @type {string} */
let stateRoot = '';

async function waitHealth(origin, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${origin}/skill.md`);
      if (r.ok) return;
      last = `status=${r.status}`;
    } catch (e) {
      last = String(e && e.message ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not ready: ${last}`);
}

test.describe('stale UI token redirect', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osjs-ui-stale-'));
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: serviceRoot,
      env: {
        ...process.env,
        PORT: String(PORT),
        ACCESS_TOKEN: CURRENT,
        TRAE_UI_STALE_ACCESS_TOKENS: STALE,
        TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE: '1',
        ONLINE_PROJECT_STATE_ROOT: stateRoot,
        // 无 TaskApi 时跳过换票
        TaskApiEndPoint: '',
        TASK_API_ENDPOINT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitHealth(`http://127.0.0.1:${PORT}`);
  });

  test.afterAll(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('GET /ui/{stale} 302 到 /ui/{current}', async ({ request }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    const res = await request.get(`${origin}/ui/${encodeURIComponent(STALE)}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    const loc = res.headers()['location'] || '';
    expect(loc).toContain(`/ui/${encodeURIComponent(CURRENT)}`);
  });

  test('GET /ui/{stale} 跟随重定向后 HTML 注入当前 token', async ({ request }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    const res = await request.get(`${origin}/ui/${encodeURIComponent(STALE)}`, {
      maxRedirects: 5,
    });
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(JSON.stringify(CURRENT));
    expect(html).not.toContain(JSON.stringify(STALE));
  });

  test('GET /api/session/ui-redirect 接受旧 token 并返回新 ui_path', async ({ request }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    const res = await request.get(`${origin}/api/session/ui-redirect`, {
      headers: { 'X-Access-Token': STALE },
    });
    expect(res.ok()).toBeTruthy();
    const j = await res.json();
    expect(j.access_token).toBe(CURRENT);
    expect(j.redirected).toBe(true);
    expect(j.ui_path).toBe(`/ui/${encodeURIComponent(CURRENT)}`);
  });

  test('未知旧 token 仍 401', async ({ request }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    const res = await request.get(`${origin}/ui/tok_unknown_never_seen`, { maxRedirects: 0 });
    expect(res.status()).toBe(401);
  });

  test('当前 token 可访问受保护 API；旧 token 访问 events 为 401', async ({ request }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    const ok = await request.get(`${origin}/api/requirements/task-gate`, {
      headers: { 'X-Access-Token': CURRENT },
    });
    expect(ok.ok()).toBeTruthy();

    const bad = await request.get(
      `${origin}/api/events/stream?access_token=${encodeURIComponent(STALE)}`,
      { timeout: 2000, failOnStatusCode: false },
    );
    // 旧 token 不应通过 authMiddleware（SSE 长连接在 401 时会立即结束）
    expect(bad.status()).toBe(401);
  });
});
