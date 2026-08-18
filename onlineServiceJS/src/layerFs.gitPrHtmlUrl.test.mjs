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
  newLayerId,
  rememberLayerPrHtmlUrl,
  readLayerPrHtmlUrl,
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

test('rememberLayerPrHtmlUrl 写入后 read 可读回', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-pr-url-'));
  const prev = process.env.ONLINE_PROJECT_LAYERS;
  process.env.ONLINE_PROJECT_LAYERS = layers;
  try {
    const lid = newLayerId();
    createRootLayer(lid);
    const url = 'https://gitlab.example.com/acme/demo/-/merge_requests/7';
    assert.equal(rememberLayerPrHtmlUrl(lid, url), true);
    assert.equal(readLayerPrHtmlUrl(lid), url);
  } finally {
    process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});

test('layerGitRemoteSnapshot 含已记住的 pr_html_url', () => {
  const layers = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-pr-snap-'));
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

    const url = 'https://github.com/acme/repo/pull/42';
    rememberLayerPrHtmlUrl(lid, url);
    const snap = layerGitRemoteSnapshot(lid);
    assert.equal(snap.is_git, true);
    assert.equal(snap.pr_html_url, url);
  } finally {
    process.env.ONLINE_PROJECT_LAYERS = prev;
    fs.rmSync(layers, { recursive: true, force: true });
  }
});
