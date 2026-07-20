import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gitCmd } from './gitCmd.mjs';
import { createRootLayer, layerGitRemoteSnapshot, newLayerId } from './layerFs.mjs';
import { aggregateGitRemoteSnapshots } from './layerFsGitRemote.mjs';

function git(cwd, args) {
  const r = spawnSync(gitCmd(), args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

function initRepoWithOrigin(dir, branch = 'master') {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', branch]);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'ok\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  const bare = `${dir}.bare.git`;
  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '--bare', '-b', branch]);
  git(dir, ['remote', 'add', 'origin', bare]);
  git(dir, ['push', '-u', 'origin', branch]);
}

test('aggregateGitRemoteSnapshots: 累加各仓 ahead', () => {
  const agg = aggregateGitRemoteSnapshots([
    { is_git: true, ahead: 0, no_upstream: false, upstream: 'origin/a', current_branch: 'a', compare_branch: '' },
    { is_git: true, ahead: 2, no_upstream: false, upstream: 'origin/b', current_branch: 'b', compare_branch: '' },
  ]);
  assert.equal(agg.is_git, true);
  assert.equal(agg.ahead, 2);
  assert.equal(agg.no_upstream, false);
});

test('layerGitRemoteSnapshot: 主仓干净但嵌套子仓 ahead>0 时层 ahead>0', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-nested-ahead-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const root = createRootLayer(lid);
    const parent = path.join(root, 'ram-work');
    initRepoWithOrigin(parent);
    fs.writeFileSync(path.join(parent, '.gitignore'), 'docs/\n');
    git(parent, ['add', '.gitignore']);
    git(parent, ['commit', '-m', 'ignore docs']);
    git(parent, ['push']);

    const docs = path.join(parent, 'docs');
    initRepoWithOrigin(docs);
    fs.writeFileSync(path.join(docs, 'a.txt'), 'change\n');
    git(docs, ['add', 'a.txt']);
    git(docs, ['commit', '-m', 'nested commit']);

    const snap = layerGitRemoteSnapshot(lid);
    assert.equal(snap.is_git, true);
    assert.ok(snap.ahead != null && snap.ahead >= 1, `expected ahead>=1 got ${snap.ahead}`);
    assert.equal(snap.no_upstream, false);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});
