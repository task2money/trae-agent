// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listLayerChildren } from './layerChildren.mjs';
import { resolveAbsolutePathForLayerListedFile } from './layerFs.mjs';

/**
 * @param {(layersDir: string, layerId: string, layerDir: string) => void} setup
 * @param {(layerId: string) => void} fn
 */
function withLayer(setup, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-children-'));
  const layers = path.join(tmp, 'layers');
  const lid = `20260719_${Math.random().toString(16).slice(2, 8)}_test`;
  const layerDir = path.join(layers, lid);
  fs.mkdirSync(layerDir, { recursive: true });
  setup(layers, lid, layerDir);
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    fn(lid);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('listLayerChildren: 单仓在子目录时顶层返回带前缀的仓库目录', () => {
  withLayer((_layers, _lid, layerDir) => {
    fs.mkdirSync(path.join(layerDir, 'ram-work', '.git'), { recursive: true });
    fs.writeFileSync(path.join(layerDir, 'ram-work', 'README.md'), 'hi');
  }, (lid) => {
    const out = listLayerChildren(lid, { dir: '', offset: 0, limit: 200 });
    assert.equal(out.ok, true);
    assert.ok(out.entries.some((e) => e.type === 'dir' && e.path === 'ram-work'));
    assert.ok(!out.entries.some((e) => e.path === 'README.md'));
  });
});

test('listLayerChildren: 展开仓库前缀后路径带前缀，且可被 file-content 解析', () => {
  withLayer((_layers, _lid, layerDir) => {
    fs.mkdirSync(path.join(layerDir, 'ram-work', '.git'), { recursive: true });
    fs.writeFileSync(path.join(layerDir, 'ram-work', 'README.md'), 'hi');
    fs.mkdirSync(path.join(layerDir, 'ram-work', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(layerDir, 'ram-work', 'docs', 'a.md'), 'a');
  }, (lid) => {
    const root = listLayerChildren(lid, { dir: 'ram-work', offset: 0, limit: 200 });
    assert.equal(root.ok, true);
    assert.ok(root.entries.some((e) => e.type === 'file' && e.path === 'ram-work/README.md'));
    assert.ok(root.entries.some((e) => e.type === 'dir' && e.path === 'ram-work/docs'));

    const nested = listLayerChildren(lid, { dir: 'ram-work/docs', offset: 0, limit: 200 });
    assert.equal(nested.ok, true);
    assert.ok(nested.entries.some((e) => e.path === 'ram-work/docs/a.md'));

    const fp = resolveAbsolutePathForLayerListedFile(lid, 'ram-work/README.md');
    assert.ok(fp && fs.readFileSync(fp, 'utf8') === 'hi');
  });
});

test('listLayerChildren: 并列多仓顶层列出各仓目录', () => {
  withLayer((_layers, _lid, layerDir) => {
    fs.mkdirSync(path.join(layerDir, 'goPractice', '.git'), { recursive: true });
    fs.writeFileSync(path.join(layerDir, 'goPractice', 'a.txt'), '1');
    fs.mkdirSync(path.join(layerDir, 'otherRepo', '.git'), { recursive: true });
    fs.writeFileSync(path.join(layerDir, 'otherRepo', 'b.txt'), '2');
  }, (lid) => {
    const out = listLayerChildren(lid, { dir: '', offset: 0, limit: 200 });
    assert.equal(out.ok, true);
    const dirs = out.entries.filter((e) => e.type === 'dir').map((e) => e.path).sort();
    assert.deepEqual(dirs, ['goPractice', 'otherRepo']);

    const a = listLayerChildren(lid, { dir: 'goPractice', offset: 0, limit: 200 });
    assert.ok(a.entries.some((e) => e.path === 'goPractice/a.txt'));
    const b = listLayerChildren(lid, { dir: 'otherRepo', offset: 0, limit: 200 });
    assert.ok(b.entries.some((e) => e.path === 'otherRepo/b.txt'));
  });
});

test('resolveAbsolutePathForLayerListedFile: 兼容无前缀（primary 相对）路径', () => {
  withLayer((_layers, _lid, layerDir) => {
    fs.mkdirSync(path.join(layerDir, 'ram-work', '.git'), { recursive: true });
    fs.writeFileSync(path.join(layerDir, 'ram-work', 'README.md'), 'legacy');
  }, (lid) => {
    const fp = resolveAbsolutePathForLayerListedFile(lid, 'README.md');
    assert.ok(fp);
    assert.equal(fs.readFileSync(fp, 'utf8'), 'legacy');
  });
});

test('resolveAbsolutePathForLayerListedFile: 解码 path 中的 %2F', () => {
  withLayer((_layers, _lid, layerDir) => {
    fs.mkdirSync(path.join(layerDir, 'ram-work', '.git'), { recursive: true });
    fs.mkdirSync(path.join(layerDir, 'ram-work', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(layerDir, 'ram-work', 'docs', 'a.md'), 'ok');
  }, (lid) => {
    const fp = resolveAbsolutePathForLayerListedFile(lid, 'ram-work%2Fdocs%2Fa.md');
    assert.ok(fp);
    assert.equal(fs.readFileSync(fp, 'utf8'), 'ok');
  });
});
