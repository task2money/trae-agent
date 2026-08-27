// @ts-check
/**
 * OPT-20260820-002：引导空层（kind=empty）应作为 pending 节点进入层图快照。
 * 心跳早于克隆时，过滤空层会让 UI 层图变 0 节点；快照应输出
 * bootstrap_pending=true 的「正在准备可写层」节点，而非空白。
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';

const EMPTY_LAYER_ID = '20260820_000000_a1b2c3';

function writeEmptyLayer(layersDir, layerId) {
  const dir = path.join(layersDir, layerId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'layer_meta.json'),
    JSON.stringify({ version: 1, kind: 'empty' }, null, 2),
    'utf8',
  );
}

test('buildLayersSnapshot includes empty layer as bootstrap_pending node', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osjs-empty-'));
  const layersDir = path.join(tmp, 'layers');
  fs.mkdirSync(layersDir, { recursive: true });
  const backup = {
    ONLINE_PROJECT_STATE_ROOT: process.env.ONLINE_PROJECT_STATE_ROOT,
    ONLINE_PROJECT_LAYERS: process.env.ONLINE_PROJECT_LAYERS,
    REPO_ROOT: process.env.REPO_ROOT,
  };
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  process.env.ONLINE_PROJECT_LAYERS = layersDir;
  process.env.REPO_ROOT = tmp;

  try {
    const { setLastBootstrapFailure } = await import('./bootstrapState.mjs');
    setLastBootstrapFailure(null);
    const { buildLayersSnapshot } = await import('./jobsRuntimeSnapshot.mjs');
    writeEmptyLayer(layersDir, EMPTY_LAYER_ID);

    const snap = buildLayersSnapshot('');
    assert.ok(Array.isArray(snap.layers));
    const empty = snap.layers.find((x) => x.layer_id === EMPTY_LAYER_ID);
    assert.ok(empty, 'empty layer should be present in snapshot layers');
    assert.equal(empty.meta_kind, 'empty');
    assert.equal(empty.bootstrap_pending, true);
    assert.equal(empty.mind_state, 'pending');
    // 空层在 bootstrap 窗口期是唯一结构锚点，层图不应为 0 节点
    assert.ok(snap.layers.length >= 1);
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('buildLayersSnapshot marks empty layer failed when lastBootstrapFailure is set', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osjs-empty-fail-'));
  const layersDir = path.join(tmp, 'layers');
  fs.mkdirSync(layersDir, { recursive: true });
  const backup = {
    ONLINE_PROJECT_STATE_ROOT: process.env.ONLINE_PROJECT_STATE_ROOT,
    ONLINE_PROJECT_LAYERS: process.env.ONLINE_PROJECT_LAYERS,
    REPO_ROOT: process.env.REPO_ROOT,
  };
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  process.env.ONLINE_PROJECT_LAYERS = layersDir;
  process.env.REPO_ROOT = tmp;

  const { setLastBootstrapFailure } = await import('./bootstrapState.mjs');
  setLastBootstrapFailure({
    phase: 'task_detail_or_credentials',
    code: 'REPO_CLONE_CREDENTIALS_INCOMPLETE',
    message: 'repo-clone-credentials 未返回完整 repo_clone_credentials',
    at: '2026-08-27T08:03:56.631Z',
    missing_repo_credentials: ['http://115.29.110.74/ljy124818167/somanyad.git'],
  });

  try {
    const { buildLayersSnapshot } = await import('./jobsRuntimeSnapshot.mjs');
    writeEmptyLayer(layersDir, EMPTY_LAYER_ID);

    const snap = buildLayersSnapshot('');
    const empty = snap.layers.find((x) => x.layer_id === EMPTY_LAYER_ID);
    assert.ok(empty, 'empty layer should still be present');
    assert.equal(empty.meta_kind, 'empty');
    assert.equal(empty.bootstrap_pending, false);
    assert.equal(empty.bootstrap_failed, true);
    assert.equal(empty.mind_state, 'failed');
    assert.equal(empty.job_status, 'failed');
    assert.match(String(empty.bootstrap_error || ''), /repo-clone-credentials/);
    assert.equal(empty.bootstrap_error_code, 'REPO_CLONE_CREDENTIALS_INCOMPLETE');
  } finally {
    setLastBootstrapFailure(null);
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('buildLayersSnapshot emits normal clone layer without bootstrap_pending', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osjs-empty2-'));
  const layersDir = path.join(tmp, 'layers');
  fs.mkdirSync(layersDir, { recursive: true });
  const backup = {
    ONLINE_PROJECT_STATE_ROOT: process.env.ONLINE_PROJECT_STATE_ROOT,
    ONLINE_PROJECT_LAYERS: process.env.ONLINE_PROJECT_LAYERS,
    REPO_ROOT: process.env.REPO_ROOT,
  };
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  process.env.ONLINE_PROJECT_LAYERS = layersDir;
  process.env.REPO_ROOT = tmp;

  try {
    const { buildLayersSnapshot } = await import('./jobsRuntimeSnapshot.mjs');
    const cloneDir = path.join(layersDir, '20260820_010000_c4d5e6');
    fs.mkdirSync(cloneDir, { recursive: true });
    fs.writeFileSync(
      path.join(cloneDir, 'layer_meta.json'),
      JSON.stringify({ version: 1, kind: 'clone', clone_url: 'git@example.com:r/a.git' }, null, 2),
      'utf8',
    );

    const snap = buildLayersSnapshot('');
    const clone = snap.layers.find((x) => x.meta_kind === 'clone');
    assert.ok(clone, 'clone layer should be present');
    assert.equal(clone.bootstrap_pending, undefined);
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
