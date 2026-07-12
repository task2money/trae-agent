/**
 * 真实 git：克隆后 checkoutWorkBranchesForJobs 将各仓切到工作分支。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkoutWorkBranchesForJobs } from './bootstrapWorkBranch.mjs';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

function makeBareWithMaster(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'master']);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  git(dir, ['config', 'user.name', 'e2e']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
}

test('e2e: after clone, all repos switch to shared work branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-checkout-'));
  const bareA = path.join(root, 'a.git');
  const bareB = path.join(root, 'b.git');
  const workA = path.join(root, 'work-a');
  const workB = path.join(root, 'work-b');
  makeBareWithMaster(bareA);
  makeBareWithMaster(bareB);
  git(root, ['clone', bareA, workA]);
  git(root, ['clone', bareB, workB]);
  assert.equal(git(workA, ['rev-parse', '--abbrev-ref', 'HEAD']), 'master');
  assert.equal(git(workB, ['rev-parse', '--abbrev-ref', 'HEAD']), 'master');

  const workBranch = 'feature/2026-07-12_task_demo_runIt';
  const gitExec = async (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error((r.stderr || r.stdout || `git exit ${r.status}`).slice(-4000));
    }
    return `${r.stdout || ''}${r.stderr || ''}`;
  };

  const out = await checkoutWorkBranchesForJobs({
    gitExec,
    jobs: [
      { raw: 'file://a.git', repoDir: workA },
      { raw: 'file://b.git', repoDir: workB },
    ],
    plansByUrl: new Map([
      ['file://a.git', { baseBranch: 'master', workBranch }],
      ['file://b.git', { baseBranch: 'master', workBranch }],
    ]),
    sharedWorkBranch: workBranch,
  });

  assert.equal(out.ok, true);
  assert.equal(git(workA, ['rev-parse', '--abbrev-ref', 'HEAD']), workBranch);
  assert.equal(git(workB, ['rev-parse', '--abbrev-ref', 'HEAD']), workBranch);
  assert.equal(out.results.every((r) => r.ok && r.mode === 'create_local'), true);
});
