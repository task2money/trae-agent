// @ts-check
/**
 * scoped UI path：有 tenant/workspace/task 时 /ui/{tok} → 302 到规范 path。
 *
 *   npx playwright test --project=api e2e/ui-scoped-path.api.spec.mjs
 */
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, '..');

const TOKEN = 'tok_scoped_e2e';
const TENANT = '850256677331562496';
const WORKSPACE = '861623708318031872';
const TASK = 'task_12949237300462721867';
const PORT = 19878;
const SCOPED = `/ui/tenant/${TENANT}/workspace/${WORKSPACE}/task/${TASK}/${TOKEN}`;

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

test.describe('scoped UI path', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osjs-ui-scoped-'));
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: serviceRoot,
      env: {
        ...process.env,
        PORT: String(PORT),
        ACCESS_TOKEN: TOKEN,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        taskId: TASK,
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
    }
    try {
      child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('GET /ui/{token} 302 到 scoped path', async ({ request }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    const res = await request.get(`${origin}/ui/${encodeURIComponent(TOKEN)}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()['location'] || '').toBe(SCOPED);
  });

  test('GET scoped path 返回 HTML 壳', async ({ request }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    const res = await request.get(`${origin}${SCOPED}`, { maxRedirects: 0 });
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(JSON.stringify(TOKEN));
  });

  test('ui-redirect.ui_path 为 scoped', async ({ request }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    const res = await request.get(`${origin}/api/session/ui-redirect`, {
      headers: { 'X-Access-Token': TOKEN },
    });
    expect(res.ok()).toBeTruthy();
    const j = await res.json();
    expect(j.ui_path).toBe(SCOPED);
  });
});
