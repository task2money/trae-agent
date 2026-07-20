// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { gitCmd } from './gitCmd.mjs';
import { MAX_DIFF_ENTRIES } from './layerParentDiffCollect.mjs';
import { collectPairChanges, parseLsTreeZ } from './layerParentDiffGit.mjs';

test('parseLsTreeZ: 解析 mode type object TAB path', () => {
  const z = '\u0000';
  const buf = `100644 blob abc\tfoo.txt${z}100644 blob def\tdir/b.txt${z}`;
  const map = parseLsTreeZ(buf);
  assert.equal(map.get('foo.txt'), 'blob:abc');
  assert.equal(map.get('dir/b.txt'), 'blob:def');
});

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
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
}

/** 在已提交的仓中塞大量相同文件，模拟大型 monorepo（walk 会触顶） */
function seedManyTrackedFiles(dir, n) {
  const bulk = path.join(dir, 'bulk');
  fs.mkdirSync(bulk, { recursive: true });
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(bulk, `f${i}.txt`), `x${i}\n`);
  }
  git(dir, ['add', 'bulk']);
  git(dir, ['commit', '-m', 'bulk']);
}

test('collectPairChanges: 共享 .git 子层改文件，大量无关 tracked 不 truncated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-git-share-'));
  try {
    const parent = path.join(root, 'parent');
    const child = path.join(root, 'child');
    initRepo(parent);
    seedManyTrackedFiles(parent, Math.min(MAX_DIFF_ENTRIES + 50, 4200));

    fs.mkdirSync(child, { recursive: true });
    for (const name of fs.readdirSync(parent)) {
      if (name === '.git') continue;
      fs.cpSync(path.join(parent, name), path.join(child, name), { recursive: true });
    }
    fs.symlinkSync(path.join('..', 'parent', '.git'), path.join(child, '.git'), 'dir');

    fs.writeFileSync(path.join(child, 'README.md'), 'child-edit\n');

    const { changes, truncated, strategy } = collectPairChanges(parent, child);
    assert.equal(strategy, 'git');
    assert.equal(truncated, false);
    const readme = changes.find((c) => c.path === 'README.md');
    assert.ok(readme, `expected README.md in ${JSON.stringify(changes)}`);
    assert.equal(readme.kind, 'modified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectPairChanges: 父脏子净（共享 .git）仍能列出差异', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-git-parent-dirty-'));
  try {
    const parent = path.join(root, 'parent');
    const child = path.join(root, 'child');
    initRepo(parent);
    fs.mkdirSync(child, { recursive: true });
    for (const name of fs.readdirSync(parent)) {
      if (name === '.git') continue;
      fs.cpSync(path.join(parent, name), path.join(child, name), { recursive: true });
    }
    fs.symlinkSync(path.join('..', 'parent', '.git'), path.join(child, '.git'), 'dir');

    fs.writeFileSync(path.join(parent, 'README.md'), 'parent-only-edit\n');

    const { changes, truncated, strategy } = collectPairChanges(parent, child);
    assert.equal(strategy, 'git');
    assert.equal(truncated, false);
    const readme = changes.find((c) => c.path === 'README.md');
    assert.ok(readme);
    assert.equal(readme.kind, 'modified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectPairChanges: HEAD 分叉时用 tree-diff（共享对象库 worktree）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-git-head-'));
  try {
    const parent = path.join(root, 'parent');
    const child = path.join(root, 'child');
    initRepo(parent);
    git(parent, ['branch', 'child-br']);
    git(parent, ['worktree', 'add', child, 'child-br']);

    fs.writeFileSync(path.join(parent, 'only-p.txt'), 'p\n');
    git(parent, ['add', 'only-p.txt']);
    git(parent, ['commit', '-m', 'p']);

    fs.writeFileSync(path.join(child, 'only-c.txt'), 'c\n');
    git(child, ['add', 'only-c.txt']);
    git(child, ['commit', '-m', 'c']);

    const { changes, truncated, strategy } = collectPairChanges(parent, child);
    assert.equal(strategy, 'git');
    assert.equal(truncated, false);
    const kinds = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
    assert.equal(kinds['only-p.txt'], 'removed');
    assert.equal(kinds['only-c.txt'], 'added');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectPairChanges: 独立 clone HEAD 分叉（对象互不可见）用 ls-tree，不 walk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-git-indep-'));
  try {
    const parent = path.join(root, 'parent');
    const child = path.join(root, 'child');
    initRepo(parent);
    seedManyTrackedFiles(parent, Math.min(MAX_DIFF_ENTRIES + 50, 4200));
    fs.cpSync(parent, child, { recursive: true });

    fs.writeFileSync(path.join(parent, 'only-p.txt'), 'p\n');
    git(parent, ['add', 'only-p.txt']);
    git(parent, ['commit', '-m', 'p']);

    fs.writeFileSync(path.join(child, 'only-c.txt'), 'c\n');
    git(child, ['add', 'only-c.txt']);
    git(child, ['commit', '-m', 'c']);

    const { changes, truncated, strategy } = collectPairChanges(parent, child);
    assert.equal(strategy, 'git');
    assert.equal(truncated, false);
    const kinds = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
    assert.equal(kinds['only-p.txt'], 'removed');
    assert.equal(kinds['only-c.txt'], 'added');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectPairChanges: 非 git 目录回退 walk 并可 truncated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-git-walk-'));
  try {
    const parent = path.join(root, 'parent');
    const child = path.join(root, 'child');
    fs.mkdirSync(parent);
    fs.mkdirSync(child);
    const n = MAX_DIFF_ENTRIES + 5;
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(parent, `f${i}.txt`), 'p\n');
      fs.writeFileSync(path.join(child, `f${i}.txt`), 'c\n');
    }
    const { truncated, strategy } = collectPairChanges(parent, child);
    assert.equal(strategy, 'walk');
    assert.equal(truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
