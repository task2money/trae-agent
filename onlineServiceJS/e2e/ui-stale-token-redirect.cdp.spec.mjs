// @ts-check
/**
 * CDP 9222：旧 /ui/{bootstrap} 书签应 302 到当前 token，页面可建立 SSE。
 *
 * 依赖：本文件 beforeAll 自启临时服务；Chrome --remote-debugging-port=9222。
 *
 *   npx playwright test --project=cdp9222 e2e/ui-stale-token-redirect.cdp.spec.mjs
 */
import { test, expect, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, '..');
const CDP_URL = process.env.PW_CDP_URL || 'http://127.0.0.1:9222';

const CURRENT = 'tok_current_cdp_ui';
const STALE = 'tok_bootstrap_cdp_ui';
const PORT = 19878;

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let stateRoot = '';

async function waitHealth(origin, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${origin}/skill.md`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server not ready');
}

test.describe('stale UI token redirect (CDP)', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test.beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osjs-ui-stale-cdp-'));
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: serviceRoot,
      env: {
        ...process.env,
        PORT: String(PORT),
        ACCESS_TOKEN: CURRENT,
        TRAE_UI_STALE_ACCESS_TOKENS: STALE,
        TRAE_SKIP_CONTAINER_TOKEN_EXCHANGE: '1',
        ONLINE_PROJECT_STATE_ROOT: stateRoot,
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

  test('CDP：打开 /ui/{stale} 最终落在 /ui/{current} 且无 401 JSON', async () => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
      test.skip(true, `无法连接 ${CDP_URL}：${e.message || e}`);
      return;
    }
    const ctx = browser.contexts()[0];
    if (!ctx) {
      test.skip(true, 'CDP 浏览器无默认 context');
      return;
    }
    const page = await ctx.newPage();
    try {
      const origin = `http://127.0.0.1:${PORT}`;
      await page.goto(`${origin}/ui/${encodeURIComponent(STALE)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await expect(page).toHaveURL(new RegExp(`/ui/${CURRENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(/Invalid or missing access token/i);
      // 页面应已注入当前 token（控制台壳）
      const html = await page.content();
      expect(html).toContain(CURRENT);
    } finally {
      await page.close();
    }
  });
});
