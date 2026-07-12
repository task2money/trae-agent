import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gitCmd } from './gitCmd.mjs';
import {
  createRootLayer,
  layerGitRemoteSnapshot,
  markOriginRemoteTrackingToHead,
  newLayerId,
  rememberLayerGitPushCompareBranch,
} from './layerFs.mjs';

function git(cwd, args) {
  const r = spawnSync(gitCmd(), args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

/**
 * T5：本地仍在 main、@{u}=origin/main，推送到 feature 并 mark remote-tracking 后，
 * 传入 compareBranch=feature 时 ahead 必须为 0（不依赖改 @{u}）。
 */
test('T5: compareBranch=target 时 ahead 相对工作分支归零（@{u} 仍可为 origin/main）', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-compare-branch-'));
  const bare = path.join(layers, 'bare.git');
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const work = createRootLayer(lid);
    git(layers, ['init', '--bare', bare]);
    // init in work as clone of bare
    fs.rmSync(work, { recursive: true, force: true });
    git(layers, ['clone', bare, work]);
    git(work, ['config', 'user.email', 't@example.com']);
    git(work, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a.txt'), '1\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'init']);
    git(work, ['branch', '-M', 'main']);
    git(work, ['push', '-u', 'origin', 'main']);

    fs.writeFileSync(path.join(work, 'a.txt'), '2\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'c1']);
    fs.writeFileSync(path.join(work, 'a.txt'), '3\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'c2']);
    // Stay on main with upstream origin/main (repro live bug: primary repo on master)
    assert.equal(String(git(work, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout).trim(), 'main');

    git(work, ['push', bare, 'HEAD:refs/heads/feature/work']);
    assert.equal(markOriginRemoteTrackingToHead(work, 'feature/work'), true);

    const withCompare = layerGitRemoteSnapshot(lid, { compareBranch: 'feature/work' });
    assert.equal(withCompare.is_git, true);
    assert.equal(withCompare.no_upstream, false);
    assert.equal(withCompare.ahead, 0);
    assert.equal(withCompare.current_branch, 'main');
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

/**
 * T5b：同上场景若不传 compareBranch 且未 remember，旧 @{u} 语义仍可 ahead>0。
 */
test('T5b: 无 compareBranch 时仍可能相对 @{u} ahead>0', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-compare-branch-b-'));
  const bare = path.join(layers, 'bare.git');
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const work = createRootLayer(lid);
    git(layers, ['init', '--bare', bare]);
    fs.rmSync(work, { recursive: true, force: true });
    git(layers, ['clone', bare, work]);
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
    git(work, ['push', bare, 'HEAD:refs/heads/feature/work']);
    assert.equal(markOriginRemoteTrackingToHead(work, 'feature/work'), true);

    const legacy = layerGitRemoteSnapshot(lid);
    assert.equal(legacy.is_git, true);
    assert.ok(legacy.ahead > 0, `expected ahead>0 vs @{u}, got ${legacy.ahead}`);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

/**
 * T7：推送后 remember compareBranch，再次 snapshot（模拟刷新）仍 ahead=0。
 */
test('T7: rememberLayerGitPushCompareBranch 后刷新 snapshot ahead=0', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-compare-branch-t7-'));
  const bare = path.join(layers, 'bare.git');
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const work = createRootLayer(lid);
    git(layers, ['init', '--bare', bare]);
    fs.rmSync(work, { recursive: true, force: true });
    git(layers, ['clone', bare, work]);
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
    git(work, ['push', bare, 'HEAD:refs/heads/feature/work']);
    assert.equal(markOriginRemoteTrackingToHead(work, 'feature/work'), true);
    rememberLayerGitPushCompareBranch(lid, 'feature/work');

    const refreshed = layerGitRemoteSnapshot(lid);
    assert.equal(refreshed.ahead, 0);
    assert.equal(refreshed.no_upstream, false);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

/**
 * T8：主仓停在 base、工作分支远程已与 HEAD 对齐时 ahead=0（带 compareBranch）。
 */
test('T8: 主仓在 base 分支但工作分支远程已对齐 → ahead=0', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-compare-branch-t8-'));
  const bare = path.join(layers, 'bare.git');
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const work = createRootLayer(lid);
    git(layers, ['init', '--bare', bare]);
    fs.rmSync(work, { recursive: true, force: true });
    git(layers, ['clone', bare, work]);
    git(work, ['config', 'user.email', 't@example.com']);
    git(work, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a.txt'), '1\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'init']);
    git(work, ['branch', '-M', 'master']);
    git(work, ['push', '-u', 'origin', 'master']);

    fs.writeFileSync(path.join(work, 'a.txt'), '2\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'c1']);
    fs.writeFileSync(path.join(work, 'a.txt'), '3\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'c2']);

    const workBranch = 'feature/2026-07-12_task_runIt';
    git(work, ['push', bare, `HEAD:refs/heads/${workBranch}`]);
    assert.equal(markOriginRemoteTrackingToHead(work, workBranch), true);
    rememberLayerGitPushCompareBranch(lid, workBranch);

    const snap = layerGitRemoteSnapshot(lid);
    assert.equal(snap.current_branch, 'master');
    assert.equal(snap.ahead, 0);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

/**
 * T9：本地 feature 无 @{u}、亦无 origin/<同名分支>，但 origin/HEAD→master 存在且 HEAD 超前 →
 * ahead>0 且 no_upstream=false（否则 ztree 推送/提交门控全灭）。
 */
test('T9: 无上游时回退 origin/HEAD 计算 ahead', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-compare-branch-t9-'));
  const bare = path.join(layers, 'bare.git');
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const work = createRootLayer(lid);
    git(layers, ['init', '--bare', bare]);
    fs.rmSync(work, { recursive: true, force: true });
    git(layers, ['clone', bare, work]);
    git(work, ['config', 'user.email', 't@example.com']);
    git(work, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(work, 'a.txt'), '1\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'init']);
    git(work, ['branch', '-M', 'master']);
    git(work, ['push', '-u', 'origin', 'master']);
    git(work, ['checkout', '-b', 'feature/local-only']);
    fs.writeFileSync(path.join(work, 'a.txt'), '2\n');
    git(work, ['add', 'a.txt']);
    git(work, ['commit', '-m', 'local feature']);
    // feature/local-only 从未设置 upstream，且无 origin/feature/local-only

    const snap = layerGitRemoteSnapshot(lid);
    assert.equal(snap.is_git, true);
    assert.equal(snap.no_upstream, false);
    assert.ok(snap.ahead > 0, `expected ahead>0, got ${snap.ahead}`);
    assert.match(String(snap.upstream || ''), /origin\/master/);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});
