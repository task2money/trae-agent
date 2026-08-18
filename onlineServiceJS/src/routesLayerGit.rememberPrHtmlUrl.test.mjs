import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRootLayer, newLayerId, readLayerPrHtmlUrl } from './layerFs.mjs';
import { runRememberPrHtmlUrl } from './routesLayerGit.mjs';

// OPT-20260817-042：网关兜底「SaaS follow-up 创建的 PR 也写入容器层 git_pr_html_url」。
test('runRememberPrHtmlUrl 合法入参写入层文件系统，read 可回读', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-remember-pr-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    createRootLayer(lid);
    const url = 'https://github.com/acme/demo/pull/123';
    const r = runRememberPrHtmlUrl({ layerId: lid, htmlUrl: url });
    assert.equal(r.httpStatus, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.remembered, true);
    assert.equal(readLayerPrHtmlUrl(lid), url);
  } finally {
    process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

test('runRememberPrHtmlUrl 缺参或 URL 非法返回 400，不写文件', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-remember-pr-bad-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    createRootLayer(lid);
    assert.equal(runRememberPrHtmlUrl({ layerId: '', htmlUrl: 'https://x' }).httpStatus, 400);
    assert.equal(runRememberPrHtmlUrl({ layerId: lid, htmlUrl: '   ' }).httpStatus, 400);
    assert.equal(runRememberPrHtmlUrl({ layerId: lid, htmlUrl: 'not-a-url' }).payload.remembered, false);
  } finally {
    process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});
