import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gitCmd } from './gitCmd.mjs';
import {
  createRootLayer,
  gitWorktreeDirty,
  layerGitWorkdirRootsForFileListing,
  matchGitRootByLongestPrefix,
  newLayerId,
} from './layerFs.mjs';
import { commitLayerGitWorkdirs, syncNestedRepoHeadsFile } from './layerGitCommit.mjs';

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

test('layerGitWorkdirRoots: 父仓内嵌套子仓被发现', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-nested-roots-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const root = createRootLayer(lid);
    const parent = path.join(root, 'ram-work');
    initRepo(parent);
    fs.writeFileSync(path.join(parent, '.gitignore'), 'docs/\n');
    fs.writeFileSync(
      path.join(parent, '.gitmodules'),
      '[submodule "docs"]\n\tpath = docs\n\turl = ../docs.git\n',
    );
    git(parent, ['add', '.gitignore', '.gitmodules']);
    git(parent, ['commit', '-m', 'registry']);

    const docs = path.join(parent, 'docs');
    initRepo(docs);
    fs.writeFileSync(path.join(docs, 'a.txt'), 'change\n');

    const roots = layerGitWorkdirRootsForFileListing(lid);
    const prefixes = roots.map((r) => r.relPrefix).sort();
    assert.ok(prefixes.includes('ram-work'));
    assert.ok(prefixes.includes('ram-work/docs'));
    assert.equal(gitWorktreeDirty(lid), true);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

test('matchGitRootByLongestPrefix: 嵌套优先于父仓', () => {
  const roots = [
    { workdir: '/tmp/ram-work', relPrefix: 'ram-work' },
    { workdir: '/tmp/ram-work/docs', relPrefix: 'ram-work/docs' },
  ];
  const hit = matchGitRootByLongestPrefix(roots, 'ram-work/docs/architecture/x.md');
  assert.equal(hit.relPrefix, 'ram-work/docs');
  assert.equal(hit.inner, 'architecture/x.md');
});

test('commitLayerGitWorkdirs: 子仓提交并写父仓 .nested-repo-heads', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-nested-commit-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    const root = createRootLayer(lid);
    const parent = path.join(root, 'ram-work');
    initRepo(parent);
    fs.writeFileSync(path.join(parent, '.gitignore'), 'docs/\n');
    fs.writeFileSync(
      path.join(parent, '.gitmodules'),
      '[submodule "docs"]\n\tpath = docs\n\turl = ../docs.git\n',
    );
    git(parent, ['add', '.gitignore', '.gitmodules']);
    git(parent, ['commit', '-m', 'registry']);

    const docs = path.join(parent, 'docs');
    initRepo(docs);
    fs.writeFileSync(path.join(docs, 'bugfix.txt'), 'fix\n');

    const result = commitLayerGitWorkdirs(lid, { message: 'fix nested', stage_all: true });
    assert.equal(result.ok, true);
    const prefixes = result.committed.map((c) => c.rel_prefix);
    assert.ok(prefixes.includes('ram-work/docs'));
    assert.ok(prefixes.includes('ram-work'));
    assert.ok(fs.existsSync(path.join(parent, '.nested-repo-heads')));
    const pin = fs.readFileSync(path.join(parent, '.nested-repo-heads'), 'utf8');
    assert.match(pin, /^docs\t[0-9a-f]{7,}/m);
    assert.equal(gitWorktreeDirty(lid), false);
  } finally {
    if (prev === undefined) delete process.env.ONLINE_PROJECT_LAYERS;
    else process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

test('syncNestedRepoHeadsFile: 无 .gitmodules 时不写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-no-gm-'));
  try {
    initRepo(dir);
    assert.equal(syncNestedRepoHeadsFile(dir, [{ path: 'docs', sha: 'abc' }]), false);
    assert.equal(fs.existsSync(path.join(dir, '.nested-repo-heads')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
