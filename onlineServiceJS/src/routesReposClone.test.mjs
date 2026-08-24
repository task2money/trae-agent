import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildManualCloneKickoff,
  layerHasCloneGit,
} from './routesReposClone.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repos-clone-test-'));
}

test('layerHasCloneGit 检测克隆目标目录是否已出现 .git', () => {
  const dir = tmpDir();
  assert.equal(layerHasCloneGit(dir), false);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  assert.equal(layerHasCloneGit(dir), true);
  assert.equal(layerHasCloneGit(null), false);
  assert.equal(layerHasCloneGit(path.join(dir, 'not-exist')), false);
});

test('buildManualCloneKickoff 克隆成功且 .git 存在时以 manual_clone 补跑 kickoff', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const calls = [];
  const fn = buildManualCloneKickoff({
    repoUrl: 'https://example.com/org/repo.git',
    detail: { task: { auto_run: true } },
    resume: async (opts) => { calls.push(opts); return { kind: 'auto_run' }; },
    log: () => {},
  });
  await fn({ lid: 'layer_new', cloneCwd: dir });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'manual_clone');
  assert.equal(calls[0].layerId, 'layer_new');
  assert.equal(calls[0].repoUrl, 'https://example.com/org/repo.git');
});

test('buildManualCloneKickoff 无 .git（克隆未落盘）时不补跑', async () => {
  const dir = tmpDir(); // 无 .git
  const calls = [];
  const fn = buildManualCloneKickoff({
    repoUrl: 'https://example.com/org/repo.git',
    detail: { task: { auto_run: true } },
    resume: async (opts) => { calls.push(opts); return { kind: 'auto_run' }; },
    log: () => {},
  });
  await fn({ lid: 'layer_new', cloneCwd: dir });
  assert.equal(calls.length, 0);
});

test('buildManualCloneKickoff 无 bootstrap detail 时不补跑（空工作区无关联任务）', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const calls = [];
  const fn = buildManualCloneKickoff({
    repoUrl: 'https://example.com/org/repo.git',
    detail: null,
    resume: async (opts) => { calls.push(opts); return { kind: 'auto_run' }; },
    log: () => {},
  });
  await fn({ lid: 'layer_new', cloneCwd: dir });
  assert.equal(calls.length, 0);
});

test('buildManualCloneKickoff 补跑失败仅记日志不抛', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  let logged = '';
  const fn = buildManualCloneKickoff({
    repoUrl: 'https://example.com/org/repo.git',
    detail: { task: { auto_run: true } },
    resume: async () => { throw new Error('kickoff boom'); },
    log: (msg) => { logged = msg; },
  });
  await fn({ lid: 'layer_new', cloneCwd: dir });
  assert.match(logged, /kickoff resume failed.*kickoff boom/);
});

test('clone 成功路径接线：routesReposClone 传 onCloneSuccess，cloneQueue 成功时调用', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const routesSrc = fs.readFileSync(path.join(here, 'routesReposClone.mjs'), 'utf8');
  const queueSrc = fs.readFileSync(path.join(here, 'cloneQueue.mjs'), 'utf8');
  // routesReposClone 的 /repos/clone handler 把 buildManualCloneKickoff 结果传给 enqueueClone
  assert.match(routesSrc, /onCloneSuccess:\s*buildManualCloneKickoff/);
  assert.match(routesSrc, /import\s*\{[\s\S]*resumeAgentKickoffAfterCloneReady/);
  assert.match(routesSrc, /buildManualCloneKickoff/);
  // cloneQueue 在克隆成功（exit 0、repo_cloned 广播后）调用 onCloneSuccess
  assert.match(queueSrc, /task\.onCloneSuccess/);
  assert.match(queueSrc, /repo_cloned/);
});
