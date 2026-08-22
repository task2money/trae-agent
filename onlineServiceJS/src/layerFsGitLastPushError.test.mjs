import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import {
  createRootLayer,
  layerGitRemoteSnapshot,
  newLayerId,
  rememberLayerPrHtmlUrl,
} from './layerFs.mjs';
import {
  rememberLayerLastPushError,
  clearLayerLastPushError,
  readLayerLastPushError,
} from './layerFsGitLastPushError.mjs';

test('rememberLayerLastPushError 写入后 snapshot 带 last_push_error', () => {
  const layers = fs.mkdtempSync(os.tmpdir() + '/layer-push-err-');
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    createRootLayer(lid);
    const detail = '该仓库未找到可用的 OAuth access_token';
    assert.equal(
      rememberLayerLastPushError(lid, detail, { traceId: 'trace-push-1' }),
      true,
    );
    const stored = readLayerLastPushError(lid);
    assert.equal(stored.detail, detail);
    assert.equal(stored.trace_id, 'trace-push-1');
    const snap = layerGitRemoteSnapshot(lid);
    assert.equal(snap.last_push_error, detail);
    assert.equal(snap.last_push_error_trace_id, 'trace-push-1');
  } finally {
    process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

test('rememberLayerPrHtmlUrl 成功后清除 last_push_error', () => {
  const layers = fs.mkdtempSync(os.tmpdir() + '/layer-push-err-clear-');
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    createRootLayer(lid);
    rememberLayerLastPushError(lid, 'push failed once');
    assert.equal(readLayerLastPushError(lid).detail, 'push failed once');
    rememberLayerPrHtmlUrl(lid, 'https://gitlab.example.com/acme/demo/-/merge_requests/1');
    assert.equal(readLayerLastPushError(lid).detail, '');
    const snap = layerGitRemoteSnapshot(lid);
    assert.equal(snap.last_push_error, undefined);
  } finally {
    process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

test('clearLayerLastPushError 删除文件后 snapshot 不再带错误', () => {
  const layers = fs.mkdtempSync(os.tmpdir() + '/layer-push-err-unlink-');
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    createRootLayer(lid);
    rememberLayerLastPushError(lid, 'boom');
    assert.equal(clearLayerLastPushError(lid), true);
    assert.equal(readLayerLastPushError(lid).detail, '');
  } finally {
    process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});
