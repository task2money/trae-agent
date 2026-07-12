import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gitCmd } from './gitCmd.mjs';
import { createRootLayer, gitWorktreeDirty, newLayerId } from './layerFs.mjs';

function git(cwd, args) {
  const r = spawnSync(gitCmd(), args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'ok\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
}

/**
 * 多仓并列时：主仓（readdir 顺序靠前）干净、次仓有未提交变更 → dirty 必须为 true。
 * 回归：旧实现只查 layerPrimaryGitWorkdir，会导致文件变动列表有条目但 ztree 无「提交」。
 */
test('gitWorktreeDirty: 次仓 dirty 时聚合为 true（主仓干净）', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-dirty-multi-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const root = createRootLayer(lid);
    // 两个并列仓：alpha 先于 beta（主仓倾向 alpha）
    const alpha = path.join(root, 'alpha');
    const beta = path.join(root, 'beta');
    initRepo(alpha);
    initRepo(beta);
    fs.writeFileSync(path.join(beta, 'dirty.txt'), 'changed\n');

    assert.equal(gitWorktreeDirty(lid), true);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

test('gitWorktreeDirty: 多仓均干净时为 false', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-dirty-clean-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const root = createRootLayer(lid);
    initRepo(path.join(root, 'alpha'));
    initRepo(path.join(root, 'beta'));
    assert.equal(gitWorktreeDirty(lid), false);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});
