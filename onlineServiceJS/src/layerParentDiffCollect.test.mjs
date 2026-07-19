// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectIndex, MAX_DIFF_ENTRIES } from './layerParentDiffCollect.mjs';

test('collectIndex: 跳过 node_modules / .venv，不占满扫描额度', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-collect-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'a');
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', `f${i}.js`), 'x');
    }
    fs.mkdirSync(path.join(tmp, '.venv', 'lib'), { recursive: true });
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(tmp, '.venv', 'lib', `v${i}.py`), 'x');
    }
    fs.writeFileSync(path.join(tmp, 'readme.md'), 'r');

    const { map, truncated } = collectIndex(tmp);
    assert.equal(truncated, false);
    assert.ok(map.has('src/a.js'));
    assert.ok(map.has('readme.md'));
    assert.ok(![...map.keys()].some((k) => k.startsWith('node_modules')));
    assert.ok(![...map.keys()].some((k) => k.startsWith('.venv')));
    assert.ok(map.size < 10);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('collectIndex: 非噪声文件触顶仍标记 truncated', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-collect-cap-'));
  try {
    const n = Math.min(MAX_DIFF_ENTRIES + 5, MAX_DIFF_ENTRIES + 5);
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(tmp, `f${i}.txt`), 'x');
    }
    const { map, truncated } = collectIndex(tmp);
    assert.equal(truncated, true);
    assert.equal(map.size, MAX_DIFF_ENTRIES);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
