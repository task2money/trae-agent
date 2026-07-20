import fs from 'fs';
import path from 'path';
import express from 'express';
import {
  accessTokenExpected,
  isTokenBootstrapFailed,
  respondTokenBootstrapFailClosed,
  tokenBootstrapFailClosedDetail,
} from './auth.mjs';
import { resolveUiPathAccessToken, isRememberedStaleAccessToken } from './uiAccessToken.mjs';
import { buildScopedUiPath, resolveUiScopeFromEnv } from './scopedUiPath.mjs';
import { serviceRoot } from './paths.mjs';

/**
 * @param {import('express').Response} res
 * @param {string} serveToken
 */
function sendUiConsoleHtml(res, serveToken) {
  const staticIndex = path.join(serviceRoot(), 'static', 'index.html');
  if (!fs.existsSync(staticIndex)) {
    return res
      .status(200)
      .type('html')
      .send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>onlineServiceJS</title></head><body><p>onlineServiceJS 已就绪。仓库中应包含 <code>onlineServiceJS/static</code>（见 Dockerfile）；缺失时请从构建上下文恢复该目录，或使用任务云任务详情。</p></body></html>`,
      );
  }
  let raw = fs.readFileSync(staticIndex, 'utf8');
  // 始终注入当前 ACCESS_TOKEN，避免路径与 env 短暂不一致。
  raw = raw.replace('__ACCESS_TOKEN_JSON__', JSON.stringify(serveToken));
  return res.type('html').send(raw);
}

/**
 * @param {import('express').Response} res
 * @param {string} serveToken
 */
function sendUiRenderHintsHtml(res, serveToken) {
  const p = path.join(serviceRoot(), 'static', 'render-hints.html');
  if (!fs.existsSync(p)) {
    return res.status(404).type('text/plain').send('render-hints.html missing');
  }
  let raw = fs.readFileSync(p, 'utf8');
  raw = raw.replace('__ACCESS_TOKEN_JSON__', JSON.stringify(serveToken));
  return res.type('html').send(raw);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ renderHints?: boolean }} [opts]
 */
function handleUiAccessTokenRoute(req, res, opts = {}) {
  if (isTokenBootstrapFailed()) {
    return respondTokenBootstrapFailClosed(res);
  }
  const expected = accessTokenExpected();
  const resolved = resolveUiPathAccessToken(req.params.access_token, expected);
  if (resolved.redirectTo) {
    const dest = opts.renderHints ? `${resolved.redirectTo}/render-hints` : resolved.redirectTo;
    return res.redirect(302, dest);
  }
  if (!resolved.ok) {
    return res.status(401).json({ detail: 'Invalid or missing access token' });
  }
  // 有 scope 时把旧 /ui/{token} 书签迁到 scoped path（规范 path 含三 ID）。
  const scope = resolveUiScopeFromEnv();
  if (scope) {
    const canonical = buildScopedUiPath(resolved.serveToken, scope);
    const want = opts.renderHints ? `${canonical}/render-hints` : canonical;
    if (String(req.path || '') !== want) {
      return res.redirect(302, want);
    }
  }
  if (opts.renderHints) return sendUiRenderHintsHtml(res, resolved.serveToken);
  return sendUiConsoleHtml(res, resolved.serveToken);
}

export function registerUiRoutes(app) {
  app.get('/skill.md', (req, res) => {
    const p = path.join(serviceRoot(), 'skill.md');
    if (!fs.existsSync(p)) return res.status(404).send('missing');
    res.type('text/markdown; charset=utf-8').send(fs.readFileSync(p, 'utf8'));
  });

  /** 规范入口：/ui/tenant/{t}/workspace/{w}/task/{task}/{access_token} */
  app.get(
    '/ui/tenant/:tenantId/workspace/:workspaceId/task/:taskId/:access_token',
    (req, res) => handleUiAccessTokenRoute(req, res),
  );
  app.get(
    '/ui/tenant/:tenantId/workspace/:workspaceId/task/:taskId/:access_token/render-hints',
    (req, res) => handleUiAccessTokenRoute(req, res, { renderHints: true }),
  );

  /** 兼容旧 /ui/{token}：有 scope 时 302 到 scoped path */
  app.get('/ui/:access_token', (req, res) => handleUiAccessTokenRoute(req, res));

  /** 新窗口查看「富文本呈现声明」JSON（与 GET /api/ui/agent-render-hints 同源数据） */
  app.get('/ui/:access_token/render-hints', (req, res) =>
    handleUiAccessTokenRoute(req, res, { renderHints: true }),
  );

  app.use('/static', express.static(path.join(serviceRoot(), 'static')));

  /**
   * 公开探活：换票 fail-closed 时返回 503，便于编排区分「进程在听但业务不可用」。
   * 无需 ACCESS_TOKEN。
   */
  app.get('/healthz', (req, res) => {
    if (isTokenBootstrapFailed()) {
      return res.status(503).json({
        status: 'unavailable',
        token_bootstrap: 'failed',
        detail: tokenBootstrapFailClosedDetail(),
        error_code: 'TOKEN_BOOTSTRAP_FAILED',
      });
    }
    return res.json({ status: 'ok', token_bootstrap: 'ok' });
  });
}

/**
 * 打开中的控制台页若仍持有换票前 bootstrap token，SSE 会 401。
 * 本接口在「当前 token 或已记住的旧 token」下返回应跳转的 scoped /ui/... 路径。
 * 须在 authMiddleware 之前挂载。
 */
export function registerSessionUiRedirectRoute(app) {
  app.get('/api/session/ui-redirect', (req, res) => {
    if (isTokenBootstrapFailed()) {
      return respondTokenBootstrapFailClosed(res);
    }
    const expected = accessTokenExpected();
    if (!expected) {
      return res.status(503).json({ detail: 'ACCESS_TOKEN not configured' });
    }
    const q = req.query?.access_token;
    const h = req.headers['x-access-token'];
    const tok = (typeof q === 'string' ? q : '') || (typeof h === 'string' ? h : '');
    if (!tok || (tok !== expected && !isRememberedStaleAccessToken(tok))) {
      return res.status(401).json({ detail: 'Invalid or missing access token' });
    }
    res.json({
      access_token: expected,
      ui_path: buildScopedUiPath(expected),
      redirected: tok !== expected,
    });
  });
}
