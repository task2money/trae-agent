import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gitCmd } from './gitCmd.mjs';
import { markOriginRemoteTrackingToHead } from './layerFs.mjs';

function git(cwd, args) {
  const r = spawnSync(gitCmd(), args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

test('markOriginRemoteTrackingToHead: URL 推送后补齐 origin/<branch> 使 ahead 归零', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-remote-tracking-'));
  const bare = path.join(root, 'bare.git');
  const work = path.join(root, 'work');
  try {
    git(root, ['init', '--bare', bare]);
    git(root, ['clone', bare, work]);
    git(work, ['config', 'user.email', 't@example.com']);
    git(work, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a.txt'), '1\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'init']);
    git(work, ['branch', '-M', 'main']);
    git(work, ['push', '-u', 'origin', 'main']);

    fs.writeFileSync(path.join(work, 'a.txt'), '2\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'local']);
    git(work, ['checkout', '-b', 'feature/push-ui']);
    git(work, ['branch', `--set-upstream-to=origin/main`, 'feature/push-ui']);

    const aheadBefore = spawnSync(gitCmd(), ['rev-list', '--count', '@{u}..HEAD'], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    assert.equal(aheadBefore.status, 0);
    assert.ok(parseInt(String(aheadBefore.stdout || '').trim(), 10) >= 1);

    // 模拟 OAuth/URL push：不经 named remote，remote-tracking 不会自动更新
    git(work, ['push', bare, 'HEAD:refs/heads/feature/push-ui']);
    const aheadMid = spawnSync(gitCmd(), ['rev-list', '--count', 'origin/main..HEAD'], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    assert.ok(parseInt(String(aheadMid.stdout || '').trim(), 10) >= 1);

    assert.equal(markOriginRemoteTrackingToHead(work, 'feature/push-ui'), true);
    // 将上游切到刚推送的分支后 ahead 应为 0
    git(work, ['branch', `--set-upstream-to=origin/feature/push-ui`]);
    const aheadAfter = spawnSync(gitCmd(), ['rev-list', '--count', '@{u}..HEAD'], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    assert.equal(aheadAfter.status, 0);
    assert.equal(parseInt(String(aheadAfter.stdout || '').trim(), 10), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
