import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gitCmd } from './gitCmd.mjs';
import { createRootLayer, layerGitRemoteSnapshot, newLayerId } from './layerFs.mjs';

function git(cwd, args) {
  const r = spawnSync(gitCmd(), args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

test('layerGitRemoteSnapshot 含 current_branch（与 HEAD 一致）', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-current-branch-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const work = createRootLayer(lid);
    git(work, ['init', '-b', 'feature/hide-merge']);
    git(work, ['config', 'user.email', 't@example.com']);
    git(work, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a.txt'), '1\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'init']);

    const snap = layerGitRemoteSnapshot(lid);
    assert.equal(snap.is_git, true);
    assert.equal(snap.current_branch, 'feature/hide-merge');
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});
