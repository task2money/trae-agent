// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  layerGitWorkdirRootsForFileListing,
  listFlatRelativeFilesForLayer,
  resolveLayerGitLogContext,
  clickedPathIsGitRepoRoot,
} from './layerFs.mjs';

test('layerGitWorkdirRootsForFileListing: 并列多仓返回多个根且带前缀', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-fs-test-'));
  const layers = path.join(tmp, 'layers');
  const lid = '20260427_154500_deadbe';
  const layerDir = path.join(layers, lid);
  fs.mkdirSync(path.join(layerDir, 'goPractice', '.git'), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'zOther', '.git'), { recursive: true });

  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const roots = layerGitWorkdirRootsForFileListing(lid);
    assert.equal(roots.length, 2);
    assert.equal(roots[0].relPrefix, 'goPractice');
    assert.equal(roots[1].relPrefix, 'zOther');
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listFlatRelativeFilesForLayer: 合并多仓相对路径', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-fs-test-'));
  const layers = path.join(tmp, 'layers');
  const lid = '20260427_154501_c0ffee';
  const layerDir = path.join(layers, lid);
  fs.mkdirSync(path.join(layerDir, 'repoA', '.git'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'repoA', 'x.md'), 'x');
  fs.mkdirSync(path.join(layerDir, 'repoB', '.git'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'repoB', 'y.md'), 'y');

  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const { files, truncated } = listFlatRelativeFilesForLayer(lid, 100);
    assert.ok(files.includes('repoA/x.md'));
    assert.ok(files.includes('repoB/y.md'));
    assert.equal(truncated, false);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listFlatRelativeFilesForLayer: max_files 截断时仍保留全部顶层目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-fs-top-'));
  const layers = path.join(tmp, 'layers');
  const lid = '20260427_154502_aabbcc';
  const layerDir = path.join(layers, lid);
  fs.mkdirSync(path.join(layerDir, '.git'), { recursive: true });
  // 早期目录塞满大量深文件 + node_modules，模拟旧 DFS 占满额度
  fs.mkdirSync(path.join(layerDir, 'AaaDeep', 'node_modules', 'pkg'), { recursive: true });
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(layerDir, 'AaaDeep', 'node_modules', 'pkg', `f${i}.js`), 'x');
  }
  fs.mkdirSync(path.join(layerDir, 'AaaDeep', 'src'), { recursive: true });
  for (let i = 0; i < 80; i++) {
    fs.writeFileSync(path.join(layerDir, 'AaaDeep', 'src', `d${i}.js`), 'x');
  }
  fs.mkdirSync(path.join(layerDir, 'ZzzLate', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'ZzzLate', 'nested', 'late.md'), 'late');
  fs.writeFileSync(path.join(layerDir, 'root.txt'), 'r');
  fs.mkdirSync(path.join(layerDir, 'EmptyDir'), { recursive: true });

  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const { files, truncated } = listFlatRelativeFilesForLayer(lid, 20);
    const tops = new Set(files.map((f) => String(f).replace(/\/$/, '').split('/')[0]));
    assert.ok(tops.has('AaaDeep'), `missing AaaDeep in ${[...tops]}`);
    assert.ok(tops.has('ZzzLate'), `missing ZzzLate in ${[...tops]}`);
    assert.ok(tops.has('EmptyDir'), `missing EmptyDir in ${[...tops]}`);
    assert.ok(tops.has('root.txt'), `missing root.txt in ${[...tops]}`);
    assert.ok(!files.some((f) => f.includes('node_modules')), 'node_modules must be skipped');
    assert.equal(truncated, true);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listFlatRelativeFilesForLayer: 多仓时小 max_files 仍种子化后序仓', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-fs-multi-seed-'));
  const layers = path.join(tmp, 'layers');
  const lid = '20260427_154503_bbccdd';
  const layerDir = path.join(layers, lid);
  fs.mkdirSync(path.join(layerDir, 'repoA', '.git'), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'repoA', 'src'), { recursive: true });
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(layerDir, 'repoA', 'src', `a${i}.js`), 'a');
  }
  fs.mkdirSync(path.join(layerDir, 'repoB', '.git'), { recursive: true });
  fs.writeFileSync(path.join(layerDir, 'repoB', 'b.md'), 'b');

  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const { files } = listFlatRelativeFilesForLayer(lid, 5);
    const tops = new Set(files.map((f) => String(f).split('/')[0]));
    assert.ok(tops.has('repoA'));
    assert.ok(tops.has('repoB'), `repoB missing from ${[...tops]} / ${files}`);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveLayerGitLogContext: 多仓时按路径前缀选对应 workdir 与 pathspec', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-gitlog-ctx-'));
  const layers = path.join(tmp, 'layers');
  const lid = '20260427_160000_abcdef';
  const layerDir = path.join(layers, lid);
  fs.mkdirSync(path.join(layerDir, 'zFirst', '.git'), { recursive: true });
  fs.mkdirSync(path.join(layerDir, 'somanyad-emailD', '.git'), { recursive: true });
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const a = resolveLayerGitLogContext(lid, 'somanyad-emailD');
    assert(a);
    assert.equal(a.pathspec, null);
    assert(a.work.endsWith(`${path.sep}somanyad-emailD`));
    const b = resolveLayerGitLogContext(lid, 'somanyad-emailD/src');
    assert(b);
    assert.equal(b.pathspec, 'src');
    assert(b.work.endsWith(`${path.sep}somanyad-emailD`));
    const c = resolveLayerGitLogContext(lid, 'somanyad-emailD/hello_world/Cargo.lock');
    assert(c);
    assert.equal(c.pathspec, 'hello_world/Cargo.lock');
    assert(c.work.endsWith(`${path.sep}somanyad-emailD`));

    // T1: 多仓根 pathspec=null → 是仓库根
    assert.equal(clickedPathIsGitRepoRoot(a), true);
    // T2: 仓内子目录无嵌套 .git → 不是仓库根
    assert.equal(clickedPathIsGitRepoRoot(b), false);
    assert.equal(clickedPathIsGitRepoRoot(c), false);
    assert.equal(clickedPathIsGitRepoRoot(null), false);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
